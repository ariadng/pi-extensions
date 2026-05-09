import type { CacheEntry, WebFetchCache } from "./cache.js";
import type { WebFetchConfig } from "./config.js";
import {
	RequestTimeoutError,
	ResponseTooLargeError,
	TooManyRedirectsError,
	WebFetchError,
} from "./errors.js";
import { convertResponseBody } from "./convert.js";
import { classifyRedirect, isRedirectStatus, resolveRedirectUrl } from "./redirects.js";
import { formatBytes } from "./utils.js";
import { type DnsLookup, normalizeAndValidateUrl } from "./validate-url.js";

export type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type FetchWebContentOptions = {
	config: WebFetchConfig;
	cache: WebFetchCache;
	lookup?: DnsLookup;
	fetchImpl?: FetchImplementation;
	now?: () => number;
	signal?: AbortSignal;
};

export type FetchedResult = CacheEntry & {
	kind: "fetched";
	cacheKey: string;
	durationMs: number;
	cached: boolean;
};

export type RedirectResult = {
	kind: "redirect";
	url: string;
	finalUrl: string;
	status: number;
	statusText: string;
	contentType: string;
	bytes: number;
	markdown: string;
	markdownBytes: number;
	durationMs: number;
	cached: false;
	redirected: true;
	redirectUrl: string;
	cacheKey: string;
	contentKind: "text";
	title?: string;
};

export type FetchWebContentResult = FetchedResult | RedirectResult;

export async function fetchWebContent(rawUrl: string, options: FetchWebContentOptions): Promise<FetchWebContentResult> {
	const now = options.now ?? Date.now;
	const started = now();
	const validated = await normalizeAndValidateUrl(rawUrl, options.config, { lookup: options.lookup });
	const cacheKey = validated.normalizedUrl;
	const cached = options.cache.get(cacheKey, now());
	if (cached) {
		return {
			...cached,
			kind: "fetched",
			cacheKey,
			durationMs: Math.max(0, now() - started),
			cached: true,
		};
	}

	const fetched = await fetchWithPermittedRedirects(validated.url, cacheKey, options);
	if (fetched.kind === "redirect") {
		return { ...fetched, durationMs: Math.max(0, now() - started) };
	}

	const entry: CacheEntry = {
		url: cacheKey,
		finalUrl: fetched.finalUrl,
		status: fetched.status,
		statusText: fetched.statusText,
		contentType: fetched.contentType,
		bytes: fetched.bytes,
		markdown: fetched.markdown,
		markdownBytes: fetched.markdownBytes,
		title: fetched.title,
		persistedBinaryPath: fetched.persistedBinaryPath,
		fetchedAt: now(),
		redirected: fetched.finalUrl !== cacheKey,
		contentKind: fetched.contentKind,
	};
	options.cache.set(cacheKey, entry);

	return {
		...entry,
		kind: "fetched",
		cacheKey,
		durationMs: Math.max(0, now() - started),
		cached: false,
	};
}

type NetworkFetchResult =
	| {
			kind: "fetched";
			finalUrl: string;
			status: number;
			statusText: string;
			contentType: string;
			bytes: number;
			markdown: string;
			markdownBytes: number;
			title?: string;
			persistedBinaryPath?: string;
			contentKind: "text" | "binary";
		}
	| Omit<RedirectResult, "durationMs">;

async function fetchWithPermittedRedirects(
	initialUrl: URL,
	cacheKey: string,
	options: FetchWebContentOptions,
): Promise<NetworkFetchResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	let currentUrl = initialUrl;
	let followedRedirects = 0;

	while (true) {
		const validated = await normalizeAndValidateUrl(currentUrl.href, options.config, { lookup: options.lookup });
		currentUrl = validated.url;

		const request = createMergedSignal(options.signal, options.config.timeoutMs);
		try {
			const response = await fetchOnce(fetchImpl, currentUrl, options.config, request.signal);
			const contentType = response.headers.get("content-type") ?? "";

			if (isRedirectStatus(response.status)) {
				await cancelBody(response);
				const nextUrl = resolveRedirectUrl(currentUrl, response.headers.get("location"), options.config);
				const decision = classifyRedirect(currentUrl, nextUrl);
				if (!decision.follow) {
					return {
						kind: "redirect",
						url: cacheKey,
						finalUrl: currentUrl.href,
						status: response.status,
						statusText: response.statusText,
						contentType,
						bytes: 0,
						markdown: "",
						markdownBytes: 0,
						cached: false,
						redirected: true,
						redirectUrl: decision.url.href,
						cacheKey,
						contentKind: "text",
					};
				}
				if (followedRedirects >= options.config.redirects) {
					throw new TooManyRedirectsError(`Too many redirects while fetching ${cacheKey}; limit is ${options.config.redirects}`);
				}
				// Revalidate before the next request to reduce redirect-based SSRF risk.
				const nextValidated = await normalizeAndValidateUrl(decision.url.href, options.config, { lookup: options.lookup });
				currentUrl = nextValidated.url;
				followedRedirects += 1;
				continue;
			}

			const bytes = await readLimitedBody(response, options.config.maxBytes, request.signal);
			const converted = await convertResponseBody({ bytes, contentType, finalUrl: currentUrl.href, signal: request.signal });
			return {
				kind: "fetched",
				finalUrl: currentUrl.href,
				status: response.status,
				statusText: response.statusText,
				contentType,
				bytes: bytes.byteLength,
				markdown: converted.markdown,
				markdownBytes: converted.markdownBytes,
				title: converted.title,
				persistedBinaryPath: converted.persistedBinaryPath,
				contentKind: converted.contentKind,
			};
		} finally {
			request.cleanup();
		}
	}
}

async function fetchOnce(fetchImpl: FetchImplementation, url: URL, config: WebFetchConfig, signal: AbortSignal): Promise<Response> {
	try {
		return await fetchImpl(url, {
			method: "GET",
			redirect: "manual",
			signal,
			headers: {
				"User-Agent": config.userAgent,
				Accept: "text/markdown, text/html, text/plain, application/json, application/xml, */*;q=0.1",
			},
		});
	} catch (error) {
		if (signal.aborted) throw abortErrorFromSignal(signal, error);
		throw new WebFetchError(`Request failed for ${url.href}: ${error instanceof Error ? error.message : String(error)}`, "FETCH_FAILED", { cause: error });
	}
}

function createMergedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;
	const abortFromParent = () => controller.abort(parent?.reason ?? new WebFetchError("WebFetch request was aborted", "ABORTED"));
	const abortFromTimeout = () => controller.abort(new RequestTimeoutError(`WebFetch request timed out after ${timeoutMs}ms`));

	if (parent?.aborted) abortFromParent();
	else parent?.addEventListener("abort", abortFromParent, { once: true });

	if (!controller.signal.aborted) timeout = setTimeout(abortFromTimeout, timeoutMs);

	return {
		signal: controller.signal,
		cleanup: () => {
			if (timeout) clearTimeout(timeout);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

function abortErrorFromSignal(signal: AbortSignal, cause?: unknown): WebFetchError {
	const reason = signal.reason;
	if (reason instanceof WebFetchError) return reason;
	if (reason instanceof Error && reason.name === "AbortError") return new WebFetchError("WebFetch request was aborted", "ABORTED", { cause: reason });
	if (reason instanceof Error) return new WebFetchError(`WebFetch request was aborted: ${reason.message}`, "ABORTED", { cause: reason });
	return new WebFetchError("WebFetch request was aborted", "ABORTED", { cause });
}

async function readLimitedBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const abortReader = () => {
		reader.cancel(signal?.reason).catch(() => undefined);
	};
	if (signal?.aborted) abortReader();
	signal?.addEventListener("abort", abortReader, { once: true });
	try {
		while (true) {
			if (signal?.aborted) throw abortErrorFromSignal(signal);
			let read: ReadableStreamReadResult<Uint8Array>;
			try {
				read = await reader.read();
			} catch (error) {
				if (signal?.aborted) throw abortErrorFromSignal(signal, error);
				throw error;
			}
			if (signal?.aborted) throw abortErrorFromSignal(signal);
			if (read.done) break;
			if (!read.value) continue;
			total += read.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new ResponseTooLargeError(`Response exceeded WebFetch byte limit of ${formatBytes(maxBytes)}`);
			}
			chunks.push(read.value);
		}
	} finally {
		signal?.removeEventListener("abort", abortReader);
	}

	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

async function cancelBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Best-effort cleanup for redirect bodies.
	}
}

