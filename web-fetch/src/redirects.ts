import type { WebFetchConfig } from "./config.js";
import { InvalidUrlError, UnsafeRedirectError } from "./errors.js";
import { normalizeHostnameForPolicy, stripSingleLeadingWww } from "./utils.js";

export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type RedirectDecision =
	| { follow: true; url: URL }
	| { follow: false; url: URL; reason: "cross-host" | "protocol-change" | "port-change" };

export function isRedirectStatus(status: number): boolean {
	return REDIRECT_STATUSES.has(status);
}

export function resolveRedirectUrl(currentUrl: URL, location: string | null, config: WebFetchConfig): URL {
	if (!location) throw new UnsafeRedirectError(`Redirect from ${currentUrl.href} did not include a Location header`);
	let next: URL;
	try {
		next = new URL(location, currentUrl);
	} catch (error) {
		throw new InvalidUrlError(`Invalid redirect Location header: ${location}`, { cause: error });
	}

	if (next.protocol === "http:" && !config.allowHttp) next.protocol = "https:";
	if (next.protocol !== "http:" && next.protocol !== "https:") {
		throw new UnsafeRedirectError(`Blocked redirect to unsupported scheme ${next.protocol}`);
	}
	if (next.username || next.password) {
		throw new UnsafeRedirectError("Blocked redirect URL with username or password components");
	}
	return next;
}

export function classifyRedirect(currentUrl: URL, nextUrl: URL): RedirectDecision {
	const currentProtocol = currentUrl.protocol;
	const nextProtocol = nextUrl.protocol;
	if (currentProtocol !== nextProtocol) {
		// Same-host HTTP -> HTTPS upgrades are safe. Other scheme changes are not auto-followed.
		if (!(currentProtocol === "http:" && nextProtocol === "https:")) {
			return { follow: false, url: nextUrl, reason: "protocol-change" };
		}
	}

	if (effectivePort(currentUrl) !== effectivePort(nextUrl)) {
		return { follow: false, url: nextUrl, reason: "port-change" };
	}

	const currentHost = stripSingleLeadingWww(normalizeHostnameForPolicy(currentUrl.hostname));
	const nextHost = stripSingleLeadingWww(normalizeHostnameForPolicy(nextUrl.hostname));
	if (currentHost !== nextHost) {
		return { follow: false, url: nextUrl, reason: "cross-host" };
	}

	return { follow: true, url: nextUrl };
}

export function effectivePort(url: URL): string {
	if (url.port) return url.port;
	if (url.protocol === "http:") return "80";
	if (url.protocol === "https:") return "443";
	return "";
}
