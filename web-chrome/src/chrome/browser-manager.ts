import { CdpConnection, type CdpEvent } from "./connection.js";
import { assertLocalEndpoint, resolveBrowserEndpoint } from "./http.js";
import { launchChrome, type ChromeLaunchInput, type LaunchedChrome } from "./launcher.js";
import {
	PageSession,
	type ClickInput as PageClickInput,
	type ConsoleInput as PageConsoleInput,
	type ConsoleResult,
	type EvaluateInput as PageEvaluateInput,
	type EvaluateResult,
	type LoadState,
	type NetworkInput as PageNetworkInput,
	type NetworkResult,
	type PressKeyInput as PagePressKeyInput,
	type ScreenshotInput as PageScreenshotInput,
	type ScreenshotResult,
	type ScrollInput as PageScrollInput,
	type SnapshotResult,
	type TypeInput as PageTypeInput,
} from "./page-session.js";
import { buildSearchUrl, formatSearchResults, searchEnginesFor, type DuckDuckGoMode, type SearchEngine, type SearchResult } from "./search.js";
import type { SnapshotOptions } from "./snapshot.js";
import type { BrowserVersion, StatusDetails, TabSummary, TargetInfo } from "./types.js";
import { envBoolean } from "../config.js";
import { AsyncQueue, abortError } from "../util/async-queue.js";
import { sleep, remainingMs } from "../util/time.js";

export type BrowserManagerStatus = "stopped" | "launching" | "connecting" | "connected" | "closing" | "disconnected";

export interface LaunchToolInput extends ChromeLaunchInput {
	forceNew?: boolean;
}

export interface ConnectToolInput {
	endpoint: string;
	timeoutMs?: number;
}

export interface TabsInput {
	action: "list" | "new" | "select" | "activate" | "close";
	tabId?: string;
	url?: string;
	includeAllTargets?: boolean;
}

export interface NavigateInput {
	url: string;
	tabId?: string;
	waitUntil?: "none" | LoadState;
	timeoutMs?: number;
}

export interface SearchInput {
	query: string;
	engine?: SearchEngine;
	limit?: number;
	language?: string;
	region?: string;
	duckDuckGoMode?: DuckDuckGoMode;
	tabId?: string;
	timeoutMs?: number;
}

export interface WaitForInput {
	tabId?: string;
	timeMs?: number;
	text?: string;
	textGone?: string;
	selector?: string;
	selectorGone?: string;
	urlContains?: string;
	loadState?: LoadState;
	timeoutMs?: number;
}

export interface CloseInput {
	target?: "browser" | "tab";
	tabId?: string;
}

export interface SnapshotInput extends SnapshotOptions {
	tabId?: string;
}

export interface ClickInput extends PageClickInput {
	tabId?: string;
}

export interface TypeInput extends PageTypeInput {
	tabId?: string;
}

export interface PressKeyInput extends PagePressKeyInput {
	tabId?: string;
}

export interface ScrollInput extends PageScrollInput {
	tabId?: string;
}

export interface ScreenshotInput extends PageScreenshotInput {
	tabId?: string;
}

export interface ConsoleInput extends PageConsoleInput {
	tabId?: string;
}

export interface NetworkInput extends PageNetworkInput {
	tabId?: string;
}

export interface EvaluateInput extends PageEvaluateInput {
	tabId?: string;
}

export class BrowserManager {
	private statusValue: BrowserManagerStatus = "stopped";
	private globalQueue = new AsyncQueue();
	private connection?: CdpConnection;
	private launched?: LaunchedChrome;
	private riskyExistingBrowser = false;
	private endpoint?: string;
	private webSocketDebuggerUrl?: string;
	private version?: BrowserVersion;
	private targetInfos = new Map<string, TargetInfo>();
	private sessions = new Map<string, PageSession>();
	private currentTargetId?: string;
	private lastMessage?: string;

	get status(): BrowserManagerStatus {
		return this.statusValue;
	}

	isConnected(): boolean {
		return this.statusValue === "connected" && !!this.connection?.isConnected();
	}

	statusLine(): string {
		const details = this.statusDetails();
		if (!details.connected) return "Chrome: off";
		const current = details.tabs.find((tab) => tab.current);
		const risk = details.riskyExistingBrowser ? "⚠ " : "✓ ";
		const label = current?.url ? shortUrl(current.url) : details.version?.product ?? "connected";
		return `Chrome: ${risk}${label}`;
	}

	statusDetails(): StatusDetails {
		const connected = this.isConnected();
		return {
			status: this.statusValue,
			connected,
			riskyExistingBrowser: this.riskyExistingBrowser,
			managedBrowser: !!this.launched && !this.riskyExistingBrowser,
			pid: this.launched?.pid,
			endpoint: this.endpoint,
			webSocketDebuggerUrl: this.webSocketDebuggerUrl,
			userDataDir: this.launched?.profile.userDataDir,
			profileMode: this.launched?.profile.mode,
			version: this.version,
			currentTargetId: this.currentTargetId,
			tabs: this.tabSummaries(false),
			message: this.lastMessage,
		};
	}

	async launch(input: LaunchToolInput, cwd: string, signal?: AbortSignal): Promise<StatusDetails> {
		return this.globalQueue.run(async () => {
			if (this.isConnected() && !input.forceNew) {
				this.lastMessage = "Chrome is already connected. Pass forceNew=true to replace the managed browser.";
				return this.statusDetails();
			}
			if (this.isConnected() && input.forceNew) await this.closeInternal({ target: "browser" }, signal);

			validateNavigableUrl(input.url ?? "about:blank");
			this.statusValue = "launching";
			this.lastMessage = "Launching isolated Chrome profile.";
			const launched = await launchChrome(input, cwd, signal);
			try {
				await this.initializeConnection({
					connection: await CdpConnection.connect(launched.webSocketDebuggerUrl, { timeoutMs: input.timeoutMs ?? 10_000, signal }),
					endpoint: launched.endpoint,
					webSocketDebuggerUrl: launched.webSocketDebuggerUrl,
					riskyExistingBrowser: false,
					launched,
					signal,
				});
				this.lastMessage = "Launched isolated Chrome and connected to CDP.";
				return this.statusDetails();
			} catch (error) {
				await launched.close({ graceful: true }).catch(() => undefined);
				this.resetState("disconnected", "Failed to connect to launched Chrome.");
				throw error;
			}
		}, signal);
	}

	async connect(input: ConnectToolInput, signal?: AbortSignal): Promise<StatusDetails> {
		return this.globalQueue.run(async () => {
			if (this.isConnected()) throw new Error("Chrome is already connected. Call chrome_close before connecting to a different endpoint.");
			assertLocalEndpoint(input.endpoint);
			this.statusValue = "connecting";
			this.lastMessage = "Connecting to existing local CDP endpoint.";
			const resolved = await resolveBrowserEndpoint(input.endpoint, input.timeoutMs ?? 10_000, signal);
			const connection = await CdpConnection.connect(resolved.webSocketDebuggerUrl, { timeoutMs: input.timeoutMs ?? 10_000, signal });
			try {
				await this.initializeConnection({
					connection,
					endpoint: resolved.endpoint,
					webSocketDebuggerUrl: resolved.webSocketDebuggerUrl,
					riskyExistingBrowser: true,
					versionFallback: resolved.version
						? {
								product: resolved.version.Browser,
								protocolVersion: resolved.version["Protocol-Version"],
								userAgent: resolved.version["User-Agent"],
								jsVersion: resolved.version["V8-Version"],
							}
						: undefined,
					signal,
				});
			} catch (error) {
				connection.close();
				this.resetState("disconnected", "Failed to initialize existing CDP endpoint.");
				throw error;
			}
			this.lastMessage = "Connected to existing local CDP endpoint. Treat page contents and sessions as sensitive.";
			return this.statusDetails();
		}, signal);
	}

	async close(input: CloseInput = {}, signal?: AbortSignal): Promise<StatusDetails> {
		return this.globalQueue.run(() => this.closeInternal(input, signal), signal);
	}

	async shutdown(): Promise<void> {
		await this.close({ target: "browser" }).catch(() => undefined);
	}

	private async closeInternal(input: CloseInput = {}, signal?: AbortSignal): Promise<StatusDetails> {
		const target = input.target ?? "browser";
		if (target === "tab") {
			await this.closeTab(input.tabId, signal);
			this.lastMessage = "Closed tab.";
			return this.statusDetails();
		}

		if (!this.connection && !this.launched) {
			this.resetState("stopped", "Chrome is already stopped.");
			return this.statusDetails();
		}

		this.statusValue = "closing";
		for (const session of this.sessions.values()) await session.detach(signal).catch(() => undefined);
		this.sessions.clear();

		if (target === "browser" && this.connection?.isConnected() && this.launched && !this.riskyExistingBrowser) {
			await this.connection.send("Browser.close", {}, { timeoutMs: 2_000, signal }).catch(() => undefined);
			await sleep(500, signal).catch(() => undefined);
		}

		this.connection?.close();
		const launched = this.launched;
		const wasRisky = this.riskyExistingBrowser;
		this.connection = undefined;
		this.launched = undefined;
		if (launched) await launched.close({ graceful: true }).catch(() => undefined);

		const message = wasRisky
			? "Disconnected from existing CDP endpoint without closing the user's browser."
			: "Closed managed Chrome browser.";
		this.resetState("stopped", message);
		return this.statusDetails();
	}

	async tabs(input: TabsInput, signal?: AbortSignal): Promise<{ tabs: TabSummary[]; currentTargetId?: string; message: string }> {
		this.assertConnected();
		return this.globalQueue.run(async () => {
			switch (input.action) {
				case "list":
					await this.refreshTargets(signal);
					this.pickCurrentTarget();
					return { tabs: this.tabSummaries(input.includeAllTargets === true), currentTargetId: this.currentTargetId, message: "Listed tabs." };
				case "new": {
					const url = input.url ?? "about:blank";
					validateNavigableUrl(url);
					const result = await this.connection!.send<{ targetId: string }>("Target.createTarget", { url }, { signal, timeoutMs: 10_000 });
					await this.refreshTargets(signal);
					this.currentTargetId = result.targetId;
					await this.activateTab(result.targetId, signal);
					await this.ensurePageSession(result.targetId, signal);
					return { tabs: this.tabSummaries(input.includeAllTargets === true), currentTargetId: this.currentTargetId, message: `Opened new tab ${result.targetId}.` };
				}
				case "select":
				case "activate": {
					const targetId = requireTabId(input.tabId, input.action);
					this.requireKnownTarget(targetId);
					this.currentTargetId = targetId;
					await this.activateTab(targetId, signal);
					await this.ensurePageSession(targetId, signal);
					return { tabs: this.tabSummaries(input.includeAllTargets === true), currentTargetId: this.currentTargetId, message: `${input.action === "select" ? "Selected" : "Activated"} tab ${targetId}.` };
				}
				case "close": {
					await this.closeTab(requireTabId(input.tabId, "close"), signal);
					return { tabs: this.tabSummaries(input.includeAllTargets === true), currentTargetId: this.currentTargetId, message: "Closed tab." };
				}
			}
		}, signal);
	}

	async navigate(input: NavigateInput, signal?: AbortSignal): Promise<{ tab: TabSummary; navigation: unknown; message: string }> {
		this.assertConnected();
		validateNavigableUrl(input.url);
		const timeoutMs = input.timeoutMs ?? 30_000;
		const waitUntil = input.waitUntil ?? "load";
		const session = await this.ensurePageSession(input.tabId, signal);
		return session.queue.run(async () => {
			await this.activateTab(session.targetId, signal);
			const sinceSeq = session.eventSequence;
			const navigation = await session.send<{ frameId?: string; loaderId?: string; errorText?: string }>("Page.navigate", { url: input.url }, { timeoutMs, signal });
			if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
			if (waitUntil !== "none") await session.waitForLoadState(waitUntil, timeoutMs, signal, sinceSeq, navigation.loaderId);
			await this.refreshTargets(signal).catch(() => undefined);
			const tab = this.tabSummaries(false).find((item) => item.targetId === session.targetId) ?? tabFromTarget(this.targetInfos.get(session.targetId), session.targetId, true);
			return { tab, navigation, message: `Navigated to ${input.url}${waitUntil === "none" ? "" : ` and waited for ${waitUntil}`}.` };
		}, signal);
	}

	async search(input: SearchInput, signal?: AbortSignal): Promise<SearchResult & { tab: TabSummary; formatted: string; message: string }> {
		this.assertConnected();
		if (!input.query?.trim()) throw new Error("chrome_search requires a non-empty query.");
		const timeoutMs = input.timeoutMs ?? 30_000;
		const limit = Math.max(1, Math.min(input.limit ?? 10, 20));
		const engines = searchEnginesFor(input.engine);
		const session = await this.ensurePageSession(input.tabId, signal);

		return session.queue.run(async () => {
			await this.activateTab(session.targetId, signal);
			const attempts: SearchResult["attempts"] = [];
			let lastResult: SearchResult | undefined;

			for (const engine of engines) {
				const url = buildSearchUrl(engine, { ...input, limit });
				try {
					const sinceSeq = session.eventSequence;
					const navigation = await session.send<{ frameId?: string; loaderId?: string; errorText?: string }>("Page.navigate", { url }, { timeoutMs, signal });
					if (navigation.errorText) throw new Error(navigation.errorText);
					await session.waitForLoadState("load", timeoutMs, signal, sinceSeq, navigation.loaderId).catch(() => undefined);
					await sleep(500, signal).catch(() => undefined);
					const extracted = await session.extractSearchResults({ engine, limit }, signal);
					const result: SearchResult = { query: input.query, attempts, ...extracted, results: extracted.results.slice(0, limit) };
					attempts.push({ engine, url, challenge: extracted.challenge, challengeReason: extracted.challengeReason, resultCount: extracted.results.length });
					lastResult = result;
					if (!extracted.challenge && extracted.results.length > 0) {
						await this.refreshTargets(signal).catch(() => undefined);
						const finalResult = { ...result, attempts: [...attempts] };
						return { ...finalResult, tab: this.tabForSession(session), formatted: formatSearchResults(finalResult), message: `Found ${finalResult.results.length} result(s) with ${engine}.` };
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					attempts.push({ engine, url, challenge: false, resultCount: 0, error: message });
				}
			}

			if (!lastResult) {
				const fallback: SearchResult = { query: input.query, engine: engines[engines.length - 1] ?? "duckduckgo", url: attempts.at(-1)?.url ?? "", title: "", challenge: false, attempts: [...attempts], results: [] };
				return { ...fallback, tab: this.tabForSession(session), formatted: formatSearchResults(fallback), message: "Search failed for all engines." };
			}
			const finalResult = { ...lastResult, attempts: [...attempts] };
			return { ...finalResult, tab: this.tabForSession(session), formatted: formatSearchResults(finalResult), message: finalResult.challenge ? "Search engine challenge detected." : "No search results extracted." };
		}, signal);
	}

	async waitFor(input: WaitForInput, signal?: AbortSignal): Promise<{ matched: string[]; tab: TabSummary; message: string }> {
		this.assertConnected();
		validateWaitInput(input);
		const timeoutMs = input.timeoutMs ?? 30_000;
		const session = await this.ensurePageSession(input.tabId, signal);
		return session.queue.run(async () => {
			const deadline = Date.now() + timeoutMs;
			const matched: string[] = [];

			if (input.timeMs !== undefined) {
				await sleep(input.timeMs, signal);
				matched.push(`timeMs=${input.timeMs}`);
			}

			if (input.loadState) {
				await session.waitForLoadState(input.loadState, remainingMs(deadline), signal, session.eventSequence);
				matched.push(`loadState=${input.loadState}`);
			}

			const checks = buildWaitChecks(input);
			while (checks.length > 0 && remainingMs(deadline) > 0) {
				if (signal?.aborted) throw abortError();
				const states = await Promise.all(checks.map((check) => check.run(session, Math.min(1_000, remainingMs(deadline)), signal)));
				if (states.every(Boolean)) {
					matched.push(...checks.map((check) => check.label));
					break;
				}
				await sleep(100, signal);
			}

			if (checks.length > 0 && !checks.every((check) => matched.includes(check.label))) {
				throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${checks.map((check) => check.label).join(", ")}.`);
			}

			await this.refreshTargets(signal).catch(() => undefined);
			const tab = this.tabForSession(session);
			return { matched, tab, message: `Wait completed: ${matched.join(", ")}.` };
		}, signal);
	}

	async snapshot(input: SnapshotInput, signal?: AbortSignal): Promise<SnapshotResult & { tab: TabSummary }> {
		this.assertConnected();
		const session = await this.ensurePageSession(input.tabId, signal);
		return session.queue.run(async () => {
			const result = await session.snapshot(input, signal);
			await this.refreshTargets(signal).catch(() => undefined);
			return { ...result, tab: this.tabForSession(session) };
		}, signal);
	}

	async click(input: ClickInput, signal?: AbortSignal): Promise<{ point: Awaited<ReturnType<PageSession["click"]>>; tab: TabSummary; message: string }> {
		this.assertConnected();
		const session = await this.ensurePageSession(input.tabId, signal);
		return session.queue.run(async () => {
			await this.activateTab(session.targetId, signal);
			const point = await session.click(input, signal);
			return { point, tab: this.tabForSession(session), message: `Clicked at (${point.x}, ${point.y}).` };
		}, signal);
	}

	async typeText(input: TypeInput, signal?: AbortSignal): Promise<{ result: Awaited<ReturnType<PageSession["typeText"]>>; tab: TabSummary; message: string }> {
		this.assertConnected();
		const session = await this.ensurePageSession(input.tabId, signal);
		return session.queue.run(async () => {
			await this.activateTab(session.targetId, signal);
			const result = await session.typeText(input, signal);
			return { result, tab: this.tabForSession(session), message: `Inserted ${result.textLength} character(s).` };
		}, signal);
	}

	async pressKey(input: PressKeyInput, signal?: AbortSignal): Promise<{ result: Awaited<ReturnType<PageSession["pressKey"]>>; tab: TabSummary; message: string }> {
		this.assertConnected();
		const session = await this.ensurePageSession(input.tabId, signal);
		return session.queue.run(async () => {
			await this.activateTab(session.targetId, signal);
			const result = await session.pressKey(input, signal);
			return { result, tab: this.tabForSession(session), message: `Pressed ${result.key}.` };
		}, signal);
	}

	async scroll(input: ScrollInput, signal?: AbortSignal): Promise<{ result: Awaited<ReturnType<PageSession["scroll"]>>; tab: TabSummary; message: string }> {
		this.assertConnected();
		const session = await this.ensurePageSession(input.tabId, signal);
		return session.queue.run(async () => {
			await this.activateTab(session.targetId, signal);
			const result = await session.scroll(input, signal);
			return { result, tab: this.tabForSession(session), message: `Scrolled by (${result.deltaX}, ${result.deltaY}).` };
		}, signal);
	}

	async screenshot(input: ScreenshotInput, cwd: string, signal?: AbortSignal): Promise<ScreenshotResult & { tab: TabSummary; message: string }> {
		this.assertConnected();
		const session = await this.ensurePageSession(input.tabId, signal);
		return session.queue.run(async () => {
			await this.activateTab(session.targetId, signal);
			const result = await session.screenshot(input, cwd, signal);
			return { ...result, tab: this.tabForSession(session), message: `Saved screenshot to ${result.path}.` };
		}, signal);
	}

	async console(input: ConsoleInput, signal?: AbortSignal): Promise<ConsoleResult & { tab: TabSummary; message: string }> {
		this.assertConnected();
		const session = await this.ensurePageSession(input.tabId, signal);
		const result = session.getConsoleEntries(input);
		return { ...result, tab: this.tabForSession(session), message: `Returned ${result.returned} console entr${result.returned === 1 ? "y" : "ies"}.` };
	}

	async network(input: NetworkInput, cwd: string, signal?: AbortSignal): Promise<NetworkResult & { tab: TabSummary; message: string }> {
		this.assertConnected();
		const session = await this.ensurePageSession(input.tabId, signal);
		const result = await session.getNetwork(input, cwd, signal);
		return { ...result, tab: this.tabForSession(session), message: `Returned ${result.returned} network request(s).` };
	}

	async evaluate(input: EvaluateInput, cwd: string, signal?: AbortSignal): Promise<EvaluateResult & { tab: TabSummary; message: string }> {
		this.assertConnected();
		const session = await this.ensurePageSession(input.tabId, signal);
		return session.queue.run(async () => {
			const result = await session.evaluateForTool(input, cwd, signal);
			return { ...result, tab: this.tabForSession(session), message: "Evaluated JavaScript in the current page." };
		}, signal);
	}

	private async initializeConnection(options: {
		connection: CdpConnection;
		endpoint?: string;
		webSocketDebuggerUrl: string;
		riskyExistingBrowser: boolean;
		launched?: LaunchedChrome;
		versionFallback?: BrowserVersion;
		signal?: AbortSignal;
	}): Promise<void> {
		this.connection = options.connection;
		this.endpoint = options.endpoint;
		this.webSocketDebuggerUrl = options.webSocketDebuggerUrl;
		this.riskyExistingBrowser = options.riskyExistingBrowser;
		this.launched = options.launched;
		this.version = options.versionFallback;
		this.targetInfos.clear();
		this.sessions.clear();
		this.currentTargetId = undefined;

		this.connection.on("browserEvent", (event: CdpEvent) => this.handleBrowserEvent(event));
		this.connection.on("closeEvent", (message: string) => {
			const launched = this.launched;
			this.resetState(launched ? "disconnected" : "stopped", message);
			void launched?.close({ graceful: true }).catch(() => undefined);
		});

		this.version = await this.connection
			.send<BrowserVersion>("Browser.getVersion", {}, { timeoutMs: 5_000, signal: options.signal })
			.catch(() => options.versionFallback);

		await this.connection.send("Target.setDiscoverTargets", { discover: true }, { timeoutMs: 5_000, signal: options.signal }).catch(() => undefined);
		await this.refreshTargets(options.signal);
		if (!this.pickCurrentTarget()) await this.createInitialTarget(options.signal);
		this.statusValue = "connected";
	}

	private async refreshTargets(signal?: AbortSignal): Promise<TargetInfo[]> {
		this.assertConnected();
		const result = await this.connection!.send<{ targetInfos?: unknown[] }>("Target.getTargets", {}, { timeoutMs: 5_000, signal });
		this.targetInfos.clear();
		for (const raw of result.targetInfos ?? []) {
			const targetInfo = normalizeTargetInfo(raw);
			if (!targetInfo) continue;
			this.targetInfos.set(targetInfo.targetId, targetInfo);
			this.sessions.get(targetInfo.targetId)?.updateTargetInfo(targetInfo);
		}
		return [...this.targetInfos.values()];
	}

	private async createInitialTarget(signal?: AbortSignal): Promise<void> {
		const result = await this.connection!.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }, { timeoutMs: 10_000, signal });
		await this.refreshTargets(signal);
		this.currentTargetId = result.targetId;
	}

	private pickCurrentTarget(): string | undefined {
		if (this.currentTargetId && this.targetInfos.get(this.currentTargetId)?.type === "page") return this.currentTargetId;
		const page = [...this.targetInfos.values()].find((target) => target.type === "page");
		this.currentTargetId = page?.targetId;
		return this.currentTargetId;
	}

	private async ensurePageSession(tabId?: string, signal?: AbortSignal): Promise<PageSession> {
		this.assertConnected();
		await this.refreshTargets(signal).catch(() => undefined);
		const targetId = tabId ?? this.currentTargetId ?? this.pickCurrentTarget() ?? (await this.createAndReturnInitialTarget(signal));
		const targetInfo = this.targetInfos.get(targetId);
		if (!targetInfo) throw new Error(`Unknown tab target: ${targetId}`);
		if (targetInfo.type !== "page") throw new Error(`Target ${targetId} is type ${targetInfo.type}, not a page tab.`);
		this.currentTargetId = targetId;

		const existing = this.sessions.get(targetId);
		if (existing) return existing;

		const result = await this.connection!.send<{ sessionId: string }>(
			"Target.attachToTarget",
			{ targetId, flatten: true },
			{ timeoutMs: 10_000, signal },
		);
		const session = new PageSession(this.connection!, targetInfo, result.sessionId);
		this.sessions.set(targetId, session);
		await session.enable(signal);
		return session;
	}

	private async createAndReturnInitialTarget(signal?: AbortSignal): Promise<string> {
		const result = await this.connection!.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" }, { timeoutMs: 10_000, signal });
		await this.refreshTargets(signal);
		this.currentTargetId = result.targetId;
		return result.targetId;
	}

	private async activateTab(targetId: string, signal?: AbortSignal): Promise<void> {
		this.requireKnownTarget(targetId);
		await this.connection!.send("Target.activateTarget", { targetId }, { timeoutMs: 5_000, signal }).catch(() => undefined);
		this.currentTargetId = targetId;
	}

	private async closeTab(tabId: string | undefined, signal?: AbortSignal): Promise<void> {
		this.assertConnected();
		const targetId = requireTabId(tabId ?? this.currentTargetId, "close");
		this.requireKnownTarget(targetId);
		await this.sessions.get(targetId)?.detach(signal);
		this.sessions.delete(targetId);
		await this.connection!.send("Target.closeTarget", { targetId }, { timeoutMs: 5_000, signal });
		this.targetInfos.delete(targetId);
		if (this.currentTargetId === targetId) {
			this.currentTargetId = undefined;
			this.pickCurrentTarget();
		}
	}

	private handleBrowserEvent(event: CdpEvent): void {
		const params = event.params ?? {};
		if (event.method === "Target.targetCreated" || event.method === "Target.targetInfoChanged") {
			const targetInfo = normalizeTargetInfo(params.targetInfo);
			if (!targetInfo) return;
			this.targetInfos.set(targetInfo.targetId, targetInfo);
			this.sessions.get(targetInfo.targetId)?.updateTargetInfo(targetInfo);
			if (!this.currentTargetId && targetInfo.type === "page") this.currentTargetId = targetInfo.targetId;
		}
		if (event.method === "Target.targetDestroyed") {
			const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
			if (!targetId) return;
			this.targetInfos.delete(targetId);
			this.sessions.delete(targetId);
			if (this.currentTargetId === targetId) {
				this.currentTargetId = undefined;
				this.pickCurrentTarget();
			}
		}
		if (event.method === "Target.detachedFromTarget") {
			const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
			if (!sessionId) return;
			for (const [targetId, session] of this.sessions.entries()) {
				if (session.sessionId === sessionId) {
					this.sessions.delete(targetId);
					this.lastMessage = `Detached from tab ${targetId}. List tabs or open a new tab if the target was closed.`;
				}
			}
		}
		if (event.method === "Target.targetCrashed") {
			const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
			if (!targetId) return;
			this.sessions.delete(targetId);
			this.lastMessage = `Tab ${targetId} crashed. Call chrome_tabs action=list or open a new tab.`;
		}
	}

	private tabSummaries(includeAllTargets: boolean): TabSummary[] {
		return [...this.targetInfos.values()]
			.filter((target) => includeAllTargets || target.type === "page")
			.map((target) => tabFromTarget(target, this.currentTargetId, target.targetId === this.currentTargetId));
	}

	private tabForSession(session: PageSession): TabSummary {
		return this.tabSummaries(false).find((item) => item.targetId === session.targetId) ?? tabFromTarget(this.targetInfos.get(session.targetId), session.targetId, true);
	}

	private requireKnownTarget(targetId: string): void {
		if (!this.targetInfos.has(targetId)) throw new Error(`Unknown tab target: ${targetId}. Call chrome_tabs action=list to see available tabs.`);
	}

	private assertConnected(): void {
		if (!this.connection?.isConnected()) throw new Error("Chrome is not connected. Use chrome_launch or chrome_connect first.");
	}

	private resetState(status: BrowserManagerStatus, message?: string): void {
		this.statusValue = status;
		this.connection = undefined;
		this.endpoint = undefined;
		this.webSocketDebuggerUrl = undefined;
		this.version = undefined;
		this.targetInfos.clear();
		this.sessions.clear();
		this.currentTargetId = undefined;
		this.riskyExistingBrowser = false;
		this.launched = undefined;
		this.lastMessage = message;
	}
}

interface WaitCheck {
	label: string;
	run(session: PageSession, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
}

function buildWaitChecks(input: WaitForInput): WaitCheck[] {
	const checks: WaitCheck[] = [];
	if (input.text !== undefined) {
		const text = input.text;
		checks.push({
			label: `text=${JSON.stringify(text)}`,
			run: (session, timeoutMs, signal) =>
				session.evaluate<boolean>(`(document.body?.innerText || document.documentElement?.innerText || "").includes(${JSON.stringify(text)})`, {
					timeoutMs,
					signal,
				}),
		});
	}
	if (input.textGone !== undefined) {
		const text = input.textGone;
		checks.push({
			label: `textGone=${JSON.stringify(text)}`,
			run: (session, timeoutMs, signal) =>
				session.evaluate<boolean>(`!(document.body?.innerText || document.documentElement?.innerText || "").includes(${JSON.stringify(text)})`, {
					timeoutMs,
					signal,
				}),
		});
	}
	if (input.selector !== undefined) {
		const selector = input.selector;
		checks.push({
			label: `selector=${JSON.stringify(selector)}`,
			run: (session, timeoutMs, signal) =>
				session.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`, { timeoutMs, signal }),
		});
	}
	if (input.selectorGone !== undefined) {
		const selector = input.selectorGone;
		checks.push({
			label: `selectorGone=${JSON.stringify(selector)}`,
			run: (session, timeoutMs, signal) =>
				session.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}) === null`, { timeoutMs, signal }),
		});
	}
	if (input.urlContains !== undefined) {
		const fragment = input.urlContains;
		checks.push({
			label: `urlContains=${JSON.stringify(fragment)}`,
			run: (session, timeoutMs, signal) => session.evaluate<boolean>(`location.href.includes(${JSON.stringify(fragment)})`, { timeoutMs, signal }),
		});
	}
	return checks;
}

function validateWaitInput(input: WaitForInput): void {
	if (
		input.timeMs === undefined &&
		input.text === undefined &&
		input.textGone === undefined &&
		input.selector === undefined &&
		input.selectorGone === undefined &&
		input.urlContains === undefined &&
		input.loadState === undefined
	) {
		throw new Error("chrome_wait_for requires at least one wait condition.");
	}
	if (input.timeMs !== undefined && input.timeMs < 0) throw new Error("timeMs must be non-negative.");
}

function validateNavigableUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid URL: ${url}. Provide an absolute http(s) URL or about:blank.`);
	}
	if (!["http:", "https:", "about:"].includes(parsed.protocol)) {
		throw new Error(`Blocked URL scheme ${parsed.protocol}. Allowed schemes: http, https, about.`);
	}
}

function normalizeTargetInfo(raw: unknown): TargetInfo | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const record = raw as Record<string, unknown>;
	if (typeof record.targetId !== "string" || typeof record.type !== "string") return undefined;
	return {
		targetId: record.targetId,
		type: record.type,
		title: typeof record.title === "string" ? record.title : undefined,
		url: typeof record.url === "string" ? record.url : undefined,
		attached: typeof record.attached === "boolean" ? record.attached : undefined,
		browserContextId: typeof record.browserContextId === "string" ? record.browserContextId : undefined,
	};
}

function tabFromTarget(target: TargetInfo | undefined, currentTargetId: string | undefined, current: boolean): TabSummary {
	return {
		targetId: target?.targetId ?? (typeof currentTargetId === "string" ? currentTargetId : "unknown"),
		type: target?.type ?? "page",
		title: target?.title ?? "",
		url: target?.url ?? "",
		attached: target?.attached ?? false,
		current,
	};
}

function requireTabId(tabId: string | undefined, action: string): string {
	if (!tabId) throw new Error(`chrome_tabs action=${action} requires tabId.`);
	return tabId;
}

function shortUrl(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.hostname || parsed.href;
	} catch {
		return url.slice(0, 40);
	}
}

export function allowExistingBrowserFromEnv(): boolean {
	return envBoolean(process.env.PI_WEB_CHROME_ALLOW_EXISTING) === true;
}
