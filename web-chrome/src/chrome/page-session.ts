import type { CdpConnection, CdpEvent } from "./connection.js";
import { applySnapshotRefs, formatSnapshot, SNAPSHOT_EXTRACTOR, type ElementBox, type SnapshotData, type SnapshotNode, type SnapshotOptions, type SnapshotRef } from "./snapshot.js";
import { SEARCH_EXTRACTOR, type SearchEngine, type SearchExtractionResult } from "./search.js";
import type { TargetInfo } from "./types.js";
import { AsyncQueue, abortError } from "../util/async-queue.js";
import { writeArtifact } from "../util/artifacts.js";
import { CdpError } from "../util/errors.js";
import { redactHeaders, redactUrl } from "../util/redact.js";
import { sleep, remainingMs } from "../util/time.js";
import { formatBytes, truncateText, type TruncationResult } from "../util/truncate.js";

export type LoadState = "domcontentloaded" | "load" | "networkidle";
export type MouseButton = "left" | "right" | "middle";
export type ModifierKey = "Alt" | "Control" | "Ctrl" | "Meta" | "Command" | "Shift";
export type ScreenshotFormat = "png" | "jpeg" | "webp";
export type ConsoleLevel = "debug" | "info" | "warning" | "error";

interface LifecycleRecord {
	seq: number;
	name: string;
	loaderId?: string;
	timestamp: number;
}

interface LifecycleWaiter {
	name: string;
	sinceSeq: number;
	loaderId?: string;
	resolve: () => void;
	reject: (error: unknown) => void;
	timer: NodeJS.Timeout;
	onAbort?: () => void;
	signal?: AbortSignal;
}

export interface SnapshotResult {
	snapshot: string;
	data: SnapshotData;
	refCount: number;
}

export interface ActionTargetInput {
	ref?: string;
	selector?: string;
	x?: number;
	y?: number;
}

export interface ClickInput extends ActionTargetInput {
	button?: MouseButton;
	doubleClick?: boolean;
	modifiers?: ModifierKey[];
	waitAfterMs?: number;
}

export interface TypeInput extends ActionTargetInput {
	text: string;
	clear?: boolean;
	submit?: boolean;
	slowly?: boolean;
}

export interface PressKeyInput {
	key: string;
	modifiers?: ModifierKey[];
	waitAfterMs?: number;
}

export interface ScrollInput extends ActionTargetInput {
	deltaX?: number;
	deltaY?: number;
}

export interface ScreenshotInput {
	path?: string;
	fullPage?: boolean;
	selector?: string;
	format?: ScreenshotFormat;
	quality?: number;
}

export interface ScreenshotResult {
	path: string;
	format: ScreenshotFormat;
	width: number;
	height: number;
	fullPage: boolean;
	selector?: string;
}

export interface ConsoleEntry {
	seq: number;
	timestamp: number;
	source: "runtime" | "log" | "exception";
	level: ConsoleLevel;
	type?: string;
	text: string;
	url?: string;
	lineNumber?: number;
	stack?: string;
}

export interface ConsoleResult {
	entries: ConsoleEntry[];
	totalBuffered: number;
	returned: number;
}

export interface ConsoleInput {
	level?: ConsoleLevel;
	all?: boolean;
	limit?: number;
}

export interface NetworkRecord {
	requestId: string;
	url: string;
	method?: string;
	resourceType?: string;
	status?: number;
	statusText?: string;
	mimeType?: string;
	startedAt: number;
	finishedAt?: number;
	failed?: boolean;
	errorText?: string;
	encodedDataLength?: number;
	requestHeaders?: Record<string, unknown>;
	responseHeaders?: Record<string, unknown>;
}

export interface NetworkInput {
	filter?: string;
	includeStatic?: boolean;
	limit?: number;
	bodyRequestId?: string;
	includeHeaders?: boolean;
	includeBody?: boolean;
	includeSensitive?: boolean;
}

export interface NetworkBodyResult {
	requestId: string;
	body: string;
	base64Encoded: boolean;
	truncation: TruncationResult;
	artifactPath?: string;
}

export interface NetworkResult {
	requests: NetworkRecord[];
	totalBuffered: number;
	returned: number;
	body?: NetworkBodyResult;
}

export interface EvaluateInput {
	expression: string;
	awaitPromise?: boolean;
	returnByValue?: boolean;
	timeoutMs?: number;
}

export interface EvaluateResult {
	type?: string;
	subtype?: string;
	className?: string;
	description?: string;
	value?: unknown;
	unserializableValue?: string;
	resultText: string;
	truncation: TruncationResult;
	artifactPath?: string;
}

interface ResolvePointResult {
	x: number;
	y: number;
	box?: ElementBox;
	selector?: string;
}

interface NetworkRecordInternal extends NetworkRecord {
	requestHeaders?: Record<string, unknown>;
	responseHeaders?: Record<string, unknown>;
}

const REF_TTL_MS = 5 * 60 * 1000;

export class PageSession {
	readonly queue = new AsyncQueue();
	readonly targetId: string;
	readonly sessionId: string;
	private enabled = false;
	private eventUnsubscribe?: () => void;
	private eventSeqValue = 0;
	private navigationIdValue = 0;
	private lifecycleRecords: LifecycleRecord[] = [];
	private lifecycleWaiters = new Set<LifecycleWaiter>();
	private inflightRequests = new Set<string>();
	private lastNetworkChange = Date.now();
	private targetInfo?: TargetInfo;
	private snapshotCounter = 0;
	private refs = new Map<string, SnapshotRef>();
	private consoleSeq = 0;
	private lastConsoleReadSeq = 0;
	private consoleEntriesBuffer: ConsoleEntry[] = [];
	private networkRecords = new Map<string, NetworkRecordInternal>();
	private networkOrder: string[] = [];

	constructor(private readonly connection: CdpConnection, targetInfo: TargetInfo, sessionId: string) {
		this.targetId = targetInfo.targetId;
		this.targetInfo = targetInfo;
		this.sessionId = sessionId;
		const listener = (event: CdpEvent) => this.handleEvent(event);
		connection.on(`session:${sessionId}`, listener);
		this.eventUnsubscribe = () => connection.off(`session:${sessionId}`, listener);
	}

	get eventSequence(): number {
		return this.eventSeqValue;
	}

	get navigationId(): number {
		return this.navigationIdValue;
	}

	get networkInflightCount(): number {
		return this.inflightRequests.size;
	}

	get lastKnownUrl(): string | undefined {
		return this.targetInfo?.url;
	}

	updateTargetInfo(targetInfo: TargetInfo): void {
		this.targetInfo = targetInfo;
	}

	async enable(signal?: AbortSignal): Promise<void> {
		if (this.enabled) return;
		await this.send("Page.enable", {}, { signal });
		await this.send("Runtime.enable", {}, { signal });
		await this.send("Network.enable", {}, { signal });
		await this.send("Log.enable", {}, { signal }).catch(() => undefined);
		await this.send("Page.setLifecycleEventsEnabled", { enabled: true }, { signal }).catch(() => undefined);
		this.enabled = true;
	}

	async detach(signal?: AbortSignal): Promise<void> {
		this.eventUnsubscribe?.();
		this.eventUnsubscribe = undefined;
		await this.connection
			.send("Target.detachFromTarget", { sessionId: this.sessionId }, { signal, timeoutMs: 2_000 })
			.catch(() => undefined);
	}

	send<T = unknown>(method: string, params?: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
		return this.connection.send<T>(method, params, { ...options, sessionId: this.sessionId });
	}

	async evaluate<T = unknown>(expression: string, options: { timeoutMs?: number; signal?: AbortSignal; awaitPromise?: boolean } = {}): Promise<T> {
		const result = await this.send<{
			result?: { type?: string; value?: unknown; unserializableValue?: string; description?: string };
			exceptionDetails?: { text?: string; exception?: { description?: string } };
		}>(
			"Runtime.evaluate",
			{
				expression,
				awaitPromise: options.awaitPromise ?? true,
				returnByValue: true,
				userGesture: false,
			},
			{ timeoutMs: options.timeoutMs ?? 5_000, signal: options.signal },
		);

		if (result.exceptionDetails) {
			const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Runtime evaluation failed";
			throw new CdpError(detail);
		}
		if (result.result && "value" in result.result) return result.result.value as T;
		return result.result?.unserializableValue as T;
	}

	async evaluateForTool(input: EvaluateInput, cwd: string, signal?: AbortSignal): Promise<EvaluateResult> {
		const objectGroup = `pi-web-chrome-evaluate-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const returnByValue = input.returnByValue !== false;
		const response = await this.send<{
			result?: {
				type?: string;
				subtype?: string;
				className?: string;
				value?: unknown;
				unserializableValue?: string;
				description?: string;
				objectId?: string;
			};
			exceptionDetails?: { text?: string; exception?: { description?: string }; stackTrace?: unknown };
		}>(
			"Runtime.evaluate",
			{
				expression: input.expression,
				awaitPromise: input.awaitPromise ?? true,
				returnByValue,
				userGesture: false,
				objectGroup,
			},
			{ timeoutMs: input.timeoutMs ?? 5_000, signal },
		);

		try {
			if (response.exceptionDetails) {
				const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Runtime evaluation failed";
				throw new CdpError(detail);
			}

			const remote = response.result ?? {};
			const value = returnByValue && "value" in remote ? remote.value : undefined;
			const resultText = stringifyEvaluationResult(returnByValue ? value ?? remote.unserializableValue ?? remote.description : remote.description ?? remote.type ?? "undefined");
			const truncation = truncateText(resultText);
			let artifactPath: string | undefined;
			if (truncation.truncated) {
				artifactPath = await writeArtifact({ cwd, prefix: "evaluate-result", extension: "txt", data: resultText, encoding: "utf8" });
			}
			return {
				type: remote.type,
				subtype: remote.subtype,
				className: remote.className,
				description: remote.description,
				value,
				unserializableValue: remote.unserializableValue,
				resultText: truncation.content,
				truncation,
				artifactPath,
			};
		} finally {
			await this.send("Runtime.releaseObjectGroup", { objectGroup }, { signal, timeoutMs: 2_000 }).catch(() => undefined);
		}
	}

	async extractSearchResults(options: { engine: Exclude<SearchEngine, "auto">; limit?: number }, signal?: AbortSignal): Promise<SearchExtractionResult> {
		return this.evaluate<SearchExtractionResult>(`(${SEARCH_EXTRACTOR})(${JSON.stringify(options)})`, { timeoutMs: 10_000, signal });
	}

	async snapshot(options: SnapshotOptions, signal?: AbortSignal): Promise<SnapshotResult> {
		const maxNodes = Math.max(1, Math.min(options.maxNodes ?? 120, 500));
		this.refs.clear();
		this.snapshotCounter = 0;
		const data = await this.evaluate<SnapshotData>(`(${SNAPSHOT_EXTRACTOR})(${JSON.stringify({ ...options, maxNodes })})`, {
			timeoutMs: 10_000,
			signal,
		});
		const navigationId = this.navigationIdValue;
		const createdAt = Date.now();
		const withRefs = applySnapshotRefs(data, (node: SnapshotNode) => {
			const ref = `c${++this.snapshotCounter}`;
			this.refs.set(ref, { ref, selector: node.selector, role: node.role, name: node.name, box: node.box, navigationId, createdAt });
			return ref;
		});
		return { snapshot: formatSnapshot(withRefs), data: withRefs, refCount: this.refs.size };
	}

	async click(input: ClickInput, signal?: AbortSignal): Promise<ResolvePointResult> {
		const point = await this.resolvePoint(input, signal);
		const button = input.button ?? "left";
		const clickCount = input.doubleClick ? 2 : 1;
		const modifiers = modifiersToBitfield(input.modifiers);
		await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, modifiers }, { signal });
		await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, buttons: buttonBit(button), clickCount, modifiers }, { signal });
		await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, buttons: 0, clickCount, modifiers }, { signal });
		await sleep(input.waitAfterMs ?? 100, signal);
		return point;
	}

	async typeText(input: TypeInput, signal?: AbortSignal): Promise<{ target?: ResolvePointResult; textLength: number }> {
		let target: ResolvePointResult | undefined;
		const hasTarget = input.ref !== undefined || input.selector !== undefined || (input.x !== undefined && input.y !== undefined);
		if (hasTarget) {
			target = await this.click({ ...input, waitAfterMs: 50 }, signal);
		}
		if (input.clear) await this.clearTarget(input, signal);
		if (input.slowly) {
			for (const char of input.text) {
				await this.send("Input.insertText", { text: char }, { signal, timeoutMs: 5_000 });
				await sleep(30, signal);
			}
		} else {
			await this.send("Input.insertText", { text: input.text }, { signal, timeoutMs: 10_000 });
		}
		if (input.submit) await this.pressKey({ key: "Enter" }, signal);
		return { target, textLength: input.text.length };
	}

	async pressKey(input: PressKeyInput, signal?: AbortSignal): Promise<{ key: string; modifiers: number }> {
		const parsed = parseKeyChord(input.key, input.modifiers);
		const key = keyDefinition(parsed.key);
		const modifiers = modifiersToBitfield(parsed.modifiers);
		await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, modifiers }, { signal, timeoutMs: 5_000 });
		if (key.text && modifiers === 0) await this.send("Input.dispatchKeyEvent", { type: "char", ...key, modifiers }, { signal, timeoutMs: 5_000 });
		await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...key, modifiers }, { signal, timeoutMs: 5_000 });
		await sleep(input.waitAfterMs ?? 50, signal);
		return { key: parsed.key, modifiers };
	}

	async scroll(input: ScrollInput, signal?: AbortSignal): Promise<{ x: number; y: number; deltaX: number; deltaY: number }> {
		let point: ResolvePointResult;
		const hasTarget = input.ref !== undefined || input.selector !== undefined || (input.x !== undefined && input.y !== undefined);
		if (hasTarget) point = await this.resolvePoint(input, signal);
		else point = await this.evaluate<ResolvePointResult>("({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) })", { signal });
		const deltaX = input.deltaX ?? 0;
		const deltaY = input.deltaY ?? 600;
		await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY }, { signal, timeoutMs: 5_000 });
		await sleep(100, signal);
		return { x: point.x, y: point.y, deltaX, deltaY };
	}

	async screenshot(input: ScreenshotInput, cwd: string, signal?: AbortSignal): Promise<ScreenshotResult> {
		const format = input.format ?? "png";
		const params: Record<string, unknown> = { format, captureBeyondViewport: input.fullPage === true || !!input.selector };
		let width = 0;
		let height = 0;
		if (format !== "png" && input.quality !== undefined) params.quality = Math.max(0, Math.min(100, input.quality));

		if (input.selector) {
			const clip = await this.elementClip(input.selector, signal);
			params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
			width = Math.round(clip.width);
			height = Math.round(clip.height);
		} else if (input.fullPage) {
			const metrics = await this.send<{ cssContentSize?: ElementBox }>("Page.getLayoutMetrics", {}, { signal, timeoutMs: 5_000 });
			const size = metrics.cssContentSize ?? { x: 0, y: 0, width: 0, height: 0 };
			params.clip = { x: 0, y: 0, width: Math.max(1, Math.ceil(size.width)), height: Math.max(1, Math.ceil(size.height)), scale: 1 };
			width = Math.max(1, Math.ceil(size.width));
			height = Math.max(1, Math.ceil(size.height));
		} else {
			const viewport = await this.evaluate<{ width: number; height: number }>("({ width: window.innerWidth, height: window.innerHeight })", { signal });
			width = viewport.width;
			height = viewport.height;
		}

		const result = await this.send<{ data: string }>("Page.captureScreenshot", params, { signal, timeoutMs: 30_000 });
		const path = await writeArtifact({
			cwd,
			path: input.path,
			prefix: input.selector ? "element-screenshot" : input.fullPage ? "fullpage-screenshot" : "screenshot",
			extension: format,
			data: Buffer.from(result.data, "base64"),
		});
		return { path, format, width, height, fullPage: input.fullPage === true, selector: input.selector };
	}

	getConsoleEntries(input: ConsoleInput = {}): ConsoleResult {
		const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
		let entries = this.consoleEntriesBuffer;
		if (!input.all) entries = entries.filter((entry) => entry.seq > this.lastConsoleReadSeq);
		if (input.level) entries = entries.filter((entry) => entry.level === input.level);
		const returned = entries.slice(-limit);
		this.lastConsoleReadSeq = this.consoleSeq;
		return { entries: returned, totalBuffered: this.consoleEntriesBuffer.length, returned: returned.length };
	}

	async getNetwork(input: NetworkInput = {}, cwd: string, signal?: AbortSignal): Promise<NetworkResult> {
		const includeSensitive = input.includeSensitive === true;
		const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
		let records = this.networkOrder.map((id) => this.networkRecords.get(id)).filter((record): record is NetworkRecordInternal => !!record);
		if (!input.includeStatic) records = records.filter((record) => !isStaticResource(record));
		if (input.filter) records = records.filter((record) => matchesNetworkFilter(record, input.filter!, includeSensitive));
		const returned = records.slice(-limit).map((record) => formatNetworkRecord(record, input.includeHeaders === true, includeSensitive));
		const result: NetworkResult = { requests: returned, totalBuffered: this.networkOrder.length, returned: returned.length };

		if (input.bodyRequestId && input.includeBody) {
			const body = await this.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId: input.bodyRequestId }, { signal, timeoutMs: 10_000 });
			const decoded = body.base64Encoded ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
			const truncation = truncateText(decoded);
			let artifactPath: string | undefined;
			if (truncation.truncated) {
				artifactPath = await writeArtifact({ cwd, prefix: `network-body-${input.bodyRequestId}`, extension: "txt", data: decoded, encoding: "utf8" });
			}
			result.body = { requestId: input.bodyRequestId, body: truncation.content, base64Encoded: body.base64Encoded, truncation, artifactPath };
		}
		return result;
	}

	async waitForLoadState(state: LoadState, timeoutMs: number, signal?: AbortSignal, sinceSeq = this.eventSequence, loaderId?: string): Promise<void> {
		if (state === "networkidle") {
			await this.waitForReadyState("load", timeoutMs, signal);
			await this.waitForNetworkIdle(timeoutMs, signal);
			return;
		}

		if (loaderId) {
			await this.waitForLifecycle(state === "load" ? "load" : "DOMContentLoaded", sinceSeq, timeoutMs, signal, loaderId);
			return;
		}

		await this.waitForReadyState(state, timeoutMs, signal);
	}

	async waitForReadyState(state: "domcontentloaded" | "load", timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (remainingMs(deadline) > 0) {
			if (signal?.aborted) throw abortError();
			const ready = await this.evaluate<string>("document.readyState", { timeoutMs: Math.min(1_000, remainingMs(deadline)), signal }).catch(() => "loading");
			if (state === "domcontentloaded" && (ready === "interactive" || ready === "complete")) return;
			if (state === "load" && ready === "complete") return;
			await sleep(100, signal);
		}
		throw new Error(`Timed out after ${timeoutMs}ms waiting for ${state}.`);
	}

	async waitForNetworkIdle(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (remainingMs(deadline) > 0) {
			if (signal?.aborted) throw abortError();
			if (this.inflightRequests.size === 0 && Date.now() - this.lastNetworkChange >= 500) return;
			await sleep(100, signal);
		}
		throw new Error(`Timed out after ${timeoutMs}ms waiting for networkidle.`);
	}

	private async resolvePoint(input: ActionTargetInput, signal?: AbortSignal): Promise<ResolvePointResult> {
		const hasRef = !!input.ref;
		const hasSelector = !!input.selector;
		const hasCoords = input.x !== undefined || input.y !== undefined;
		if ([hasRef, hasSelector, hasCoords].filter(Boolean).length !== 1) {
			throw new Error("Action target requires exactly one of ref, selector, or both x and y coordinates.");
		}
		if (hasCoords) {
			if (typeof input.x !== "number" || typeof input.y !== "number") throw new Error("Coordinate target requires both x and y.");
			return { x: input.x, y: input.y };
		}
		const selector = hasRef ? this.selectorForRef(input.ref!) : input.selector!;
		return this.elementCenter(selector, signal);
	}

	private selectorForRef(ref: string): string {
		const entry = this.refs.get(ref);
		if (!entry) throw new Error(`Unknown or expired ref ${ref}. Call chrome_snapshot again.`);
		if (entry.navigationId !== this.navigationIdValue) throw new Error(`Stale ref ${ref}: page navigated. Call chrome_snapshot again.`);
		if (Date.now() - entry.createdAt > REF_TTL_MS) throw new Error(`Expired ref ${ref}. Call chrome_snapshot again.`);
		return entry.selector;
	}

	private async elementCenter(selector: string, signal?: AbortSignal): Promise<ResolvePointResult> {
		const result = await this.evaluate<ResolvePointResult & { error?: string }>(
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return { error: 'No element matches selector: ${escapeForSingleLine(selector)}' };
				if (!(el instanceof Element)) return { error: 'Target is not an element.' };
				el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
				const rect = el.getBoundingClientRect();
				const style = getComputedStyle(el);
				if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return { error: 'Element is not visible or has no layout box.' };
				return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), box: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }, selector: ${JSON.stringify(selector)} };
			})()`,
			{ timeoutMs: 5_000, signal },
		);
		if (result.error) throw new Error(result.error);
		return result;
	}

	private async clearTarget(input: ActionTargetInput, signal?: AbortSignal): Promise<void> {
		if (input.ref || input.selector) {
			const selector = input.ref ? this.selectorForRef(input.ref) : input.selector!;
			const result = await this.evaluate<{ error?: string }>(
				`(() => {
					const el = document.querySelector(${JSON.stringify(selector)});
					if (!el) return { error: 'No element matches selector for clear.' };
					el.focus();
					if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
						el.value = '';
						el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
						el.dispatchEvent(new Event('change', { bubbles: true }));
						return {};
					}
					if (el.isContentEditable) {
						el.textContent = '';
						el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
						return {};
					}
					return {};
				})()`,
				{ timeoutMs: 5_000, signal },
			);
			if (result.error) throw new Error(result.error);
			return;
		}
		await this.pressKey({ key: "Meta+A" }, signal);
		await this.pressKey({ key: "Backspace" }, signal);
	}

	private async elementClip(selector: string, signal?: AbortSignal): Promise<ElementBox> {
		const result = await this.evaluate<ElementBox & { error?: string }>(
			`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				if (!el) return { error: 'No element matches selector: ${escapeForSingleLine(selector)}' };
				el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
				const rect = el.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) return { error: 'Element has no screenshot area.' };
				return { x: Math.max(0, rect.left + window.scrollX), y: Math.max(0, rect.top + window.scrollY), width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
			})()`,
			{ timeoutMs: 5_000, signal },
		);
		if (result.error) throw new Error(result.error);
		return result;
	}

	private waitForLifecycle(name: string, sinceSeq: number, timeoutMs: number, signal?: AbortSignal, loaderId?: string): Promise<void> {
		if (this.lifecycleRecords.some((record) => matchesLifecycle(record, name, sinceSeq, loaderId))) return Promise.resolve();
		if (signal?.aborted) return Promise.reject(abortError());

		return new Promise((resolve, reject) => {
			const waiter: LifecycleWaiter = {
				name,
				sinceSeq,
				loaderId,
				resolve: () => {
					cleanup();
					resolve();
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
				timer: setTimeout(() => {
					cleanup();
					reject(new Error(`Timed out after ${timeoutMs}ms waiting for lifecycle event ${name}.`));
				}, timeoutMs),
				signal,
			};

			const cleanup = () => {
				clearTimeout(waiter.timer);
				this.lifecycleWaiters.delete(waiter);
				if (waiter.onAbort && signal) signal.removeEventListener("abort", waiter.onAbort);
			};

			waiter.onAbort = () => waiter.reject(abortError());
			signal?.addEventListener("abort", waiter.onAbort, { once: true });
			this.lifecycleWaiters.add(waiter);
		});
	}

	private handleEvent(event: CdpEvent): void {
		this.eventSeqValue += 1;
		const params = event.params ?? {};

		if (event.method === "Page.lifecycleEvent") {
			const name = typeof params.name === "string" ? params.name : undefined;
			if (name) this.addLifecycleRecord({ name, loaderId: typeof params.loaderId === "string" ? params.loaderId : undefined });
		}

		if (event.method === "Page.domContentEventFired") this.addLifecycleRecord({ name: "DOMContentLoaded" });
		if (event.method === "Page.loadEventFired") this.addLifecycleRecord({ name: "load" });

		if (event.method === "Page.frameNavigated") {
			const frame = params.frame;
			if (isRecord(frame) && typeof frame.url === "string" && !frame.parentId) {
				this.targetInfo = this.targetInfo ? { ...this.targetInfo, url: frame.url } : this.targetInfo;
				this.navigationIdValue += 1;
				this.refs.clear();
				this.lastConsoleReadSeq = this.consoleSeq;
			}
		}

		this.handleConsoleEvent(event);
		this.handleNetworkEvent(event);
	}

	private handleConsoleEvent(event: CdpEvent): void {
		const params = event.params ?? {};
		if (event.method === "Runtime.consoleAPICalled") {
			const type = typeof params.type === "string" ? params.type : "log";
			const args = Array.isArray(params.args) ? params.args : [];
			const text = args.map(remoteObjectText).join(" ");
			this.addConsoleEntry({ source: "runtime", level: consoleTypeToLevel(type), type, text, timestamp: Date.now() });
		}

		if (event.method === "Runtime.exceptionThrown") {
			const details = isRecord(params.exceptionDetails) ? params.exceptionDetails : {};
			const exception = isRecord(details.exception) ? details.exception : undefined;
			const text = String(exception?.description ?? details.text ?? "Unhandled exception");
			this.addConsoleEntry({
				source: "exception",
				level: "error",
				text,
				timestamp: Date.now(),
				url: typeof details.url === "string" ? details.url : undefined,
				lineNumber: typeof details.lineNumber === "number" ? details.lineNumber : undefined,
				stack: stackTraceText(details.stackTrace),
			});
		}

		if (event.method === "Log.entryAdded") {
			const entry = isRecord(params.entry) ? params.entry : undefined;
			if (!entry) return;
			const level = normalizeConsoleLevel(typeof entry.level === "string" ? entry.level : "info");
			this.addConsoleEntry({
				source: "log",
				level,
				text: String(entry.text ?? ""),
				timestamp: Date.now(),
				url: typeof entry.url === "string" ? entry.url : undefined,
				lineNumber: typeof entry.lineNumber === "number" ? entry.lineNumber : undefined,
				stack: stackTraceText(entry.stackTrace),
			});
		}
	}

	private handleNetworkEvent(event: CdpEvent): void {
		const params = event.params ?? {};
		if (event.method === "Network.requestWillBeSent") {
			const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
			if (requestId) {
				this.inflightRequests.add(requestId);
				this.lastNetworkChange = Date.now();
				const request = isRecord(params.request) ? params.request : {};
				this.upsertNetworkRecord(requestId, {
					requestId,
					url: typeof request.url === "string" ? request.url : "",
					method: typeof request.method === "string" ? request.method : undefined,
					resourceType: typeof params.type === "string" ? params.type : undefined,
					startedAt: Date.now(),
					requestHeaders: isRecord(request.headers) ? request.headers : undefined,
				});
			}
		}

		if (event.method === "Network.responseReceived") {
			const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
			if (requestId) {
				const response = isRecord(params.response) ? params.response : {};
				this.upsertNetworkRecord(requestId, {
					requestId,
					url: typeof response.url === "string" ? response.url : this.networkRecords.get(requestId)?.url ?? "",
					resourceType: typeof params.type === "string" ? params.type : this.networkRecords.get(requestId)?.resourceType,
					startedAt: this.networkRecords.get(requestId)?.startedAt ?? Date.now(),
					status: typeof response.status === "number" ? response.status : undefined,
					statusText: typeof response.statusText === "string" ? response.statusText : undefined,
					mimeType: typeof response.mimeType === "string" ? response.mimeType : undefined,
					responseHeaders: isRecord(response.headers) ? response.headers : undefined,
				});
			}
		}

		if (event.method === "Network.loadingFinished" || event.method === "Network.loadingFailed") {
			const requestId = typeof params.requestId === "string" ? params.requestId : undefined;
			if (requestId) {
				this.inflightRequests.delete(requestId);
				this.lastNetworkChange = Date.now();
				const current = this.networkRecords.get(requestId);
				if (current) {
					current.finishedAt = Date.now();
					if (typeof params.encodedDataLength === "number") current.encodedDataLength = params.encodedDataLength;
					if (event.method === "Network.loadingFailed") {
						current.failed = true;
						current.errorText = typeof params.errorText === "string" ? params.errorText : "loading failed";
					}
				}
			}
		}
	}

	private addLifecycleRecord(record: { name: string; loaderId?: string }): void {
		const lifecycleRecord: LifecycleRecord = {
			seq: this.eventSeqValue,
			name: record.name,
			loaderId: record.loaderId,
			timestamp: Date.now(),
		};
		this.lifecycleRecords.push(lifecycleRecord);
		while (this.lifecycleRecords.length > 200) this.lifecycleRecords.shift();

		for (const waiter of [...this.lifecycleWaiters]) {
			if (matchesLifecycle(lifecycleRecord, waiter.name, waiter.sinceSeq, waiter.loaderId)) waiter.resolve();
		}
	}

	private addConsoleEntry(entry: Omit<ConsoleEntry, "seq">): void {
		this.consoleSeq += 1;
		this.consoleEntriesBuffer.push({ ...entry, seq: this.consoleSeq });
		while (this.consoleEntriesBuffer.length > 500) this.consoleEntriesBuffer.shift();
	}

	private upsertNetworkRecord(requestId: string, patch: NetworkRecordInternal): void {
		const existing = this.networkRecords.get(requestId);
		this.networkRecords.set(requestId, { ...existing, ...patch });
		if (!existing) this.networkOrder.push(requestId);
		while (this.networkOrder.length > 1000) {
			const oldest = this.networkOrder.shift();
			if (oldest) this.networkRecords.delete(oldest);
		}
	}
}

function matchesLifecycle(record: LifecycleRecord, name: string, sinceSeq: number, loaderId?: string): boolean {
	return record.seq > sinceSeq && record.name === name && (!loaderId || !record.loaderId || record.loaderId === loaderId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buttonBit(button: MouseButton): number {
	if (button === "left") return 1;
	if (button === "right") return 2;
	return 4;
}

function modifiersToBitfield(modifiers: readonly ModifierKey[] | undefined): number {
	let bits = 0;
	for (const modifier of modifiers ?? []) {
		const normalized = modifier.toLowerCase();
		if (normalized === "alt") bits |= 1;
		if (normalized === "control" || normalized === "ctrl") bits |= 2;
		if (normalized === "meta" || normalized === "command") bits |= 4;
		if (normalized === "shift") bits |= 8;
	}
	return bits;
}

function parseKeyChord(key: string, modifiers: ModifierKey[] | undefined): { key: string; modifiers: ModifierKey[] } {
	const pieces = key.split("+").map((piece) => piece.trim()).filter(Boolean);
	const parsedModifiers: ModifierKey[] = [...(modifiers ?? [])];
	let actualKey = key;
	if (pieces.length > 1) {
		actualKey = pieces[pieces.length - 1]!;
		for (const piece of pieces.slice(0, -1)) {
			const normalized = normalizeModifier(piece);
			if (normalized) parsedModifiers.push(normalized);
		}
	}
	return { key: actualKey, modifiers: parsedModifiers };
}

function normalizeModifier(value: string): ModifierKey | undefined {
	const normalized = value.toLowerCase();
	if (normalized === "alt" || normalized === "option") return "Alt";
	if (normalized === "control" || normalized === "ctrl") return "Control";
	if (normalized === "meta" || normalized === "cmd" || normalized === "command") return "Meta";
	if (normalized === "shift") return "Shift";
	return undefined;
}

function keyDefinition(key: string): Record<string, unknown> {
	const normalized = keyAlias(key);
	const common: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
		Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
		Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
		Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
		Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
		Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
		ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
		ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
		ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
		ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
		Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
		End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
		PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
		PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
		Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
	};
	if (common[normalized]) return common[normalized];
	if (normalized.length === 1) {
		const upper = normalized.toUpperCase();
		const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(normalized) ? `Digit${normalized}` : "";
		return { key: normalized, code, windowsVirtualKeyCode: upper.charCodeAt(0), text: normalized };
	}
	return { key: normalized, code: normalized, windowsVirtualKeyCode: 0 };
}

function keyAlias(key: string): string {
	const normalized = key.trim();
	const lower = normalized.toLowerCase();
	if (lower === "esc") return "Escape";
	if (lower === "return") return "Enter";
	if (lower === "left") return "ArrowLeft";
	if (lower === "right") return "ArrowRight";
	if (lower === "up") return "ArrowUp";
	if (lower === "down") return "ArrowDown";
	if (lower === "pgup") return "PageUp";
	if (lower === "pgdown") return "PageDown";
	if (lower === " ") return "Space";
	return normalized;
}

function consoleTypeToLevel(type: string): ConsoleLevel {
	if (["error", "assert"].includes(type)) return "error";
	if (["warning", "warn"].includes(type)) return "warning";
	if (["debug", "trace"].includes(type)) return "debug";
	return "info";
}

function normalizeConsoleLevel(level: string): ConsoleLevel {
	if (level === "error") return "error";
	if (level === "warning" || level === "warn") return "warning";
	if (level === "debug" || level === "verbose") return "debug";
	return "info";
}

function remoteObjectText(value: unknown): string {
	if (!isRecord(value)) return String(value);
	if ("value" in value) return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
	if (typeof value.unserializableValue === "string") return value.unserializableValue;
	if (typeof value.description === "string") return value.description;
	return String(value.type ?? "object");
}

function stackTraceText(value: unknown): string | undefined {
	if (!isRecord(value) || !Array.isArray(value.callFrames)) return undefined;
	return value.callFrames
		.map((frame) => {
			if (!isRecord(frame)) return undefined;
			const fn = typeof frame.functionName === "string" && frame.functionName ? frame.functionName : "(anonymous)";
			const url = typeof frame.url === "string" ? frame.url : "";
			const line = typeof frame.lineNumber === "number" ? frame.lineNumber + 1 : 0;
			return `${fn} ${url}:${line}`;
		})
		.filter((line): line is string => !!line)
		.join("\n");
}

function isStaticResource(record: NetworkRecord): boolean {
	const type = (record.resourceType ?? "").toLowerCase();
	if (["image", "stylesheet", "font", "media"].includes(type)) return true;
	return /\.(png|jpe?g|gif|webp|svg|ico|css|woff2?|ttf|mp4|webm|mp3|wav)(\?|$)/i.test(record.url);
}

function matchesNetworkFilter(record: NetworkRecord, filter: string, includeSensitive: boolean): boolean {
	const url = redactUrl(record.url, includeSensitive);
	try {
		return new RegExp(filter, "i").test(url);
	} catch {
		return url.toLowerCase().includes(filter.toLowerCase());
	}
}

function formatNetworkRecord(record: NetworkRecordInternal, includeHeaders: boolean, includeSensitive: boolean): NetworkRecord {
	return {
		requestId: record.requestId,
		url: redactUrl(record.url, includeSensitive),
		method: record.method,
		resourceType: record.resourceType,
		status: record.status,
		statusText: record.statusText,
		mimeType: record.mimeType,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		failed: record.failed,
		errorText: record.errorText,
		encodedDataLength: record.encodedDataLength,
		requestHeaders: includeHeaders ? redactHeaders(record.requestHeaders, includeSensitive) : undefined,
		responseHeaders: includeHeaders ? redactHeaders(record.responseHeaders, includeSensitive) : undefined,
	};
}

function escapeForSingleLine(value: string): string {
	return value.replace(/[\r\n]/g, " ").replace(/'/g, "\\'");
}

function stringifyEvaluationResult(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "undefined";
	try {
		const json = JSON.stringify(value, null, 2);
		return json === undefined ? String(value) : json;
	} catch {
		return String(value);
	}
}

export function formatNetworkBodySummary(body: NetworkBodyResult): string {
	let text = `\nBody for ${body.requestId} (${formatBytes(body.truncation.outputBytes)} of ${formatBytes(body.truncation.totalBytes)}):\n${body.body}`;
	if (body.truncation.truncated) text += `\n[Body truncated. Full body saved to: ${body.artifactPath}]`;
	return text;
}
