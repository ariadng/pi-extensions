import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { BrowserManager, allowExistingBrowserFromEnv } from "./chrome/browser-manager.js";
import { envBoolean, looksLikeDefaultChromeProfile } from "./config.js";
import { formatNetworkBodySummary } from "./chrome/page-session.js";
import { cleanupWebChromeStorage, formatCleanupResult, type CleanupScope } from "./util/cleanup.js";
import { formatBytes } from "./util/truncate.js";
import type { StatusDetails, TabSummary } from "./chrome/types.js";
import {
	ChromeClickParamsSchema,
	ChromeCloseParamsSchema,
	ChromeConnectParamsSchema,
	ChromeConsoleParamsSchema,
	ChromeEvaluateParamsSchema,
	ChromeLaunchParamsSchema,
	ChromeNavigateParamsSchema,
	ChromeNetworkParamsSchema,
	ChromePressKeyParamsSchema,
	ChromeScreenshotParamsSchema,
	ChromeScrollParamsSchema,
	ChromeSearchParamsSchema,
	ChromeSnapshotParamsSchema,
	ChromeTabsParamsSchema,
	ChromeTypeParamsSchema,
	ChromeWaitForParamsSchema,
	EmptyParamsSchema,
	type ChromeClickParams,
	type ChromeCloseParams,
	type ChromeConnectParams,
	type ChromeConsoleParams,
	type ChromeEvaluateParams,
	type ChromeLaunchParams,
	type ChromeNavigateParams,
	type ChromeNetworkParams,
	type ChromePressKeyParams,
	type ChromeScreenshotParams,
	type ChromeScrollParams,
	type ChromeSearchParams,
	type ChromeSnapshotParams,
	type ChromeTabsParams,
	type ChromeTypeParams,
	type ChromeWaitForParams,
} from "./schemas.js";

const CHROME_SUBCOMMANDS = ["status", "start", "stop", "tabs", "login", "risk", "cleanup", "help"] as const;

const PROMPT_GUIDELINES = [
	"Use chrome_launch before browser actions unless chrome_status shows Chrome is already connected.",
	"Use chrome_tabs action=list when you need the current tab id or available tabs.",
	"Use chrome_search as the default tool whenever the user asks to search the web, look something up online, find current information, or research a topic.",
	"Use chrome_search instead of manually navigating to search engines; use WebFetch only when the user gives a specific URL to fetch.",
	"If chrome_search reports a Google/DuckDuckGo challenge, tell the user and suggest /chrome start --visible or /chrome login with a named profile to complete it manually.",
	"Use chrome_navigate for page navigation and prefer waitUntil=load unless the user asks otherwise.",
	"Use chrome_wait_for after browser actions that trigger asynchronous changes before deciding the next action.",
	"Use chrome_snapshot before chrome_click or chrome_type unless the user gave an exact selector or coordinates.",
	"Use refs from the most recent chrome_snapshot. If a ref is stale, call chrome_snapshot again.",
	"Prefer chrome_click, chrome_type, chrome_press_key, and chrome_scroll for user-like interactions; use diagnostics tools for inspection.",
	"Use chrome_evaluate only for diagnostics or extraction that cannot be done with safer browser tools.",
	"Do not use chrome_evaluate, chrome_network, or chrome_console to extract cookies, auth headers, tokens, local storage secrets, or other credentials.",
	"Do not connect chrome_connect to an existing browser endpoint unless the user explicitly asks or approves the privacy risk.",
];

export default function webChromeExtension(pi: ExtensionAPI): void {
	const manager = new BrowserManager();

	pi.registerTool(createStatusTool(manager));
	pi.registerTool(createLaunchTool(manager));
	pi.registerTool(createConnectTool(manager));
	pi.registerTool(createCloseTool(manager));
	pi.registerTool(createTabsTool(manager));
	pi.registerTool(createNavigateTool(manager));
	pi.registerTool(createSearchTool(manager));
	pi.registerTool(createWaitForTool(manager));
	pi.registerTool(createSnapshotTool(manager));
	pi.registerTool(createClickTool(manager));
	pi.registerTool(createTypeTool(manager));
	pi.registerTool(createPressKeyTool(manager));
	pi.registerTool(createScrollTool(manager));
	pi.registerTool(createScreenshotTool(manager));
	pi.registerTool(createConsoleTool(manager));
	pi.registerTool(createNetworkTool(manager));
	pi.registerTool(createEvaluateTool(manager));

	registerChromeCommands(pi, manager);

	pi.on("session_start", async (_event, ctx) => {
		setChromeStatus(ctx, manager);
	});

	pi.on("session_shutdown", async () => {
		await manager.shutdown();
	});
}

function createStatusTool(manager: BrowserManager) {
	return defineTool<typeof EmptyParamsSchema, StatusDetails>({
		name: "chrome_status",
		label: "Chrome Status",
		description: "Show web-chrome connection, version, endpoint risk, current tab, and tabs count.",
		promptSnippet: "Show Chrome CDP connection status and current tab details",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: EmptyParamsSchema,
		...chromeRenderers("chrome_status"),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const details = manager.statusDetails();
			setChromeStatus(ctx, manager);
			return textResult(formatStatus(details), details);
		},
	});
}

function createLaunchTool(manager: BrowserManager) {
	return defineTool<typeof ChromeLaunchParamsSchema, StatusDetails>({
		name: "chrome_launch",
		label: "Chrome Launch",
		description: "Launch a dedicated isolated Chrome profile with CDP enabled on 127.0.0.1 and a random port.",
		promptSnippet: "Launch isolated Chrome with CDP enabled",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeLaunchParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_launch"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const launchParams = await ensureLaunchProfileAllowed(params as ChromeLaunchParams, ctx);
			const details = await manager.launch(launchParams, ctx.cwd, signal);
			setChromeStatus(ctx, manager);
			return textResult(formatStatus(details), details);
		},
	});
}

function createConnectTool(manager: BrowserManager) {
	return defineTool<typeof ChromeConnectParamsSchema, StatusDetails>({
		name: "chrome_connect",
		label: "Chrome Connect",
		description: "Connect to an explicit local CDP endpoint. Risk-gated because existing browsers may expose cookies, storage, page contents, and authenticated sessions.",
		promptSnippet: "Connect to a local existing Chrome CDP endpoint after explicit risk opt-in",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeConnectParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_connect"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await ensureExistingBrowserAllowed(params as ChromeConnectParams, ctx);
			const details = await manager.connect(params as ChromeConnectParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(formatStatus(details), details);
		},
	});
}

function createCloseTool(manager: BrowserManager) {
	return defineTool<typeof ChromeCloseParamsSchema, StatusDetails>({
		name: "chrome_close",
		label: "Chrome Close",
		description: "Close the current tab, disconnect from an existing endpoint, or close the managed Chrome browser.",
		promptSnippet: "Close a tab or stop/disconnect the Chrome CDP browser session",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeCloseParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_close"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.close(params as ChromeCloseParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(formatStatus(details), details);
		},
	});
}

function createTabsTool(manager: BrowserManager) {
	return defineTool<typeof ChromeTabsParamsSchema, { tabs: TabSummary[]; currentTargetId?: string; message: string }>({
		name: "chrome_tabs",
		label: "Chrome Tabs",
		description: "List, open, select, activate, or close Chrome page tabs via CDP Target domain.",
		promptSnippet: "List/open/select/activate/close Chrome tabs",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeTabsParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_tabs"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.tabs(params as ChromeTabsParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(`${details.message}\n\n${formatTabs(details.tabs)}`, details);
		},
	});
}

function createNavigateTool(manager: BrowserManager) {
	return defineTool<typeof ChromeNavigateParamsSchema, { tab: TabSummary; navigation: unknown; message: string }>({
		name: "chrome_navigate",
		label: "Chrome Navigate",
		description: "Navigate the current or specified Chrome tab and wait for a basic load state.",
		promptSnippet: "Navigate a Chrome tab and wait for load/domcontentloaded/networkidle",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeNavigateParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_navigate"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.navigate(params as ChromeNavigateParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(`${details.message}\n\nCurrent tab:\n${formatTabs([details.tab])}`, details);
		},
	});
}

function createSearchTool(manager: BrowserManager) {
	return defineTool<typeof ChromeSearchParamsSchema, Awaited<ReturnType<BrowserManager["search"]>>>({
		name: "chrome_search",
		label: "Chrome Search",
		description: "Search the web in Chrome using Google or DuckDuckGo, parse organic results, and detect search-engine bot challenges. Use this as the default web-search tool.",
		promptSnippet: "Search the web with Google/DuckDuckGo; use by default for web searches",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeSearchParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.search(params as ChromeSearchParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(details.formatted, details);
		},
		renderCall(args, theme) {
			return renderCallText("chrome_search", truncateInline(args.query ?? "", 80), theme);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			return renderResultText(`${details?.results?.length ?? 0} result(s) via ${details?.engine ?? "search"}`, theme);
		},
	});
}

function createWaitForTool(manager: BrowserManager) {
	return defineTool<typeof ChromeWaitForParamsSchema, { matched: string[]; tab: TabSummary; message: string }>({
		name: "chrome_wait_for",
		label: "Chrome Wait",
		description: "Wait for time, page text, selector presence/absence, URL substring, or load state in the current/specified Chrome tab.",
		promptSnippet: "Wait for time/text/selector/url/load-state in a Chrome tab",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeWaitForParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_wait_for"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.waitFor(params as ChromeWaitForParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(`${details.message}\n\nCurrent tab:\n${formatTabs([details.tab])}`, details);
		},
	});
}

function createSnapshotTool(manager: BrowserManager) {
	return defineTool<typeof ChromeSnapshotParamsSchema, Awaited<ReturnType<BrowserManager["snapshot"]>>>({
		name: "chrome_snapshot",
		label: "Chrome Snapshot",
		description: "Return a compact semantic page snapshot with ephemeral refs for clickable/typeable elements.",
		promptSnippet: "Inspect the current Chrome page as semantic elements with refs",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeSnapshotParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_snapshot"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.snapshot(params as ChromeSnapshotParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(details.snapshot, details);
		},
	});
}

function createClickTool(manager: BrowserManager) {
	return defineTool<typeof ChromeClickParamsSchema, Awaited<ReturnType<BrowserManager["click"]>>>({
		name: "chrome_click",
		label: "Chrome Click",
		description: "Click a Chrome page element by snapshot ref, CSS selector, or viewport coordinates.",
		promptSnippet: "Click a Chrome page target by ref/selector/coordinates",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeClickParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_click"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.click(params as ChromeClickParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(details.message, details);
		},
	});
}

function createTypeTool(manager: BrowserManager) {
	return defineTool<typeof ChromeTypeParamsSchema, Awaited<ReturnType<BrowserManager["typeText"]>>>({
		name: "chrome_type",
		label: "Chrome Type",
		description: "Type or fill text into the focused element or a target selected by ref, selector, or coordinates.",
		promptSnippet: "Type/fill text into a Chrome page target",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeTypeParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_type"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.typeText(params as ChromeTypeParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(details.message, details);
		},
	});
}

function createPressKeyTool(manager: BrowserManager) {
	return defineTool<typeof ChromePressKeyParamsSchema, Awaited<ReturnType<BrowserManager["pressKey"]>>>({
		name: "chrome_press_key",
		label: "Chrome Key",
		description: "Press a keyboard key or chord in the current/specified Chrome tab.",
		promptSnippet: "Press a key or key chord in Chrome",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromePressKeyParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_press_key"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.pressKey(params as ChromePressKeyParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(details.message, details);
		},
	});
}

function createScrollTool(manager: BrowserManager) {
	return defineTool<typeof ChromeScrollParamsSchema, Awaited<ReturnType<BrowserManager["scroll"]>>>({
		name: "chrome_scroll",
		label: "Chrome Scroll",
		description: "Scroll a Chrome page or scroll over a target element/coordinate.",
		promptSnippet: "Scroll the Chrome page or a target area",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeScrollParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_scroll"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.scroll(params as ChromeScrollParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(details.message, details);
		},
	});
}

function createScreenshotTool(manager: BrowserManager) {
	return defineTool<typeof ChromeScreenshotParamsSchema, Awaited<ReturnType<BrowserManager["screenshot"]>>>({
		name: "chrome_screenshot",
		label: "Chrome Screenshot",
		description: "Capture a Chrome viewport, full-page, or element screenshot to a local artifact file.",
		promptSnippet: "Capture a Chrome screenshot to an artifact path",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeScreenshotParamsSchema,
		executionMode: "sequential",
		...chromeRenderers("chrome_screenshot"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.screenshot(params as ChromeScreenshotParams, ctx.cwd, signal);
			setChromeStatus(ctx, manager);
			return textResult(`${details.message}\nDimensions: ${details.width}x${details.height}`, details);
		},
	});
}

function createConsoleTool(manager: BrowserManager) {
	return defineTool<typeof ChromeConsoleParamsSchema, Awaited<ReturnType<BrowserManager["console"]>>>({
		name: "chrome_console",
		label: "Chrome Console",
		description: "Return buffered console, log, and exception entries from a Chrome tab.",
		promptSnippet: "Read Chrome console/log/exception entries",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeConsoleParamsSchema,
		...chromeRenderers("chrome_console"),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.console(params as ChromeConsoleParams, signal);
			setChromeStatus(ctx, manager);
			return textResult(`${details.message}\n\n${formatConsoleEntries(details.entries)}`, details);
		},
	});
}

function createNetworkTool(manager: BrowserManager) {
	return defineTool<typeof ChromeNetworkParamsSchema, Awaited<ReturnType<BrowserManager["network"]>>>({
		name: "chrome_network",
		label: "Chrome Network",
		description: "Return buffered network request metadata and optionally fetch a truncated response body by request id.",
		promptSnippet: "Read Chrome network requests and optional response body",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeNetworkParamsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await ensureSensitiveNetworkAllowed(params as ChromeNetworkParams, ctx);
			const details = await manager.network(params as ChromeNetworkParams, ctx.cwd, signal);
			setChromeStatus(ctx, manager);
			let text = `${details.message}\n\n${formatNetworkRequests(details.requests)}`;
			if (details.body) text += formatNetworkBodySummary(details.body);
			return textResult(text, details);
		},
		renderCall(args, theme) {
			return renderCallText("chrome_network", args.bodyRequestId ? `body ${args.bodyRequestId}` : args.filter ?? "list", theme);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			return renderResultText(`${details?.returned ?? 0} request(s)${details?.body ? ", body included" : ""}`, theme);
		},
	});
}

function createEvaluateTool(manager: BrowserManager) {
	return defineTool<typeof ChromeEvaluateParamsSchema, Awaited<ReturnType<BrowserManager["evaluate"]>>>({
		name: "chrome_evaluate",
		label: "Chrome Evaluate",
		description: "Evaluate scoped JavaScript in the current page for diagnostics. Prefer safer chrome_snapshot/console/network tools and never extract secrets.",
		promptSnippet: "Evaluate JavaScript in a Chrome page for diagnostics with truncation",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: ChromeEvaluateParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await manager.evaluate(params as ChromeEvaluateParams, ctx.cwd, signal);
			setChromeStatus(ctx, manager);
			let text = `${details.message}\nType: ${details.type ?? "unknown"}${details.subtype ? `/${details.subtype}` : ""}\n\n${details.resultText}`;
			if (details.truncation.truncated) {
				text += `\n\n[Result truncated: ${formatBytes(details.truncation.outputBytes)} of ${formatBytes(details.truncation.totalBytes)}. Full result saved to: ${details.artifactPath}]`;
			}
			return textResult(text, details);
		},
		renderCall(args, theme) {
			return renderCallText("chrome_evaluate", truncateInline(args.expression ?? "", 80), theme);
		},
		renderResult(result, _options, theme) {
			const details = result.details;
			const suffix = details?.truncation?.truncated ? " (truncated)" : "";
			return renderResultText(`${details?.type ?? "value"}${suffix}`, theme);
		},
	});
}

function registerChromeCommands(pi: ExtensionAPI, manager: BrowserManager): void {
	pi.registerCommand("chrome", {
		description: "Manage web-chrome: /chrome status|start|stop|tabs|login|risk|help",
		getArgumentCompletions: chromeCommandCompletions,
		handler: async (args, ctx) => {
			let parts = splitCommandArgs(args);
			if (parts.length === 0) {
				if (!ctx.hasUI) {
					ctx.ui.notify(chromeCommandHelp(), "info");
					return;
				}

				const selected = await ctx.ui.select("Chrome command", chromeCommandMenuOptions());
				if (!selected) return;
				const selectedCommand = selected.trim().split(/\s+/)[0] ?? "help";
				parts = [selectedCommand];
				if (selectedCommand === "start" || selectedCommand === "login") {
					const url = await ctx.ui.input("Initial URL (optional)", "about:blank");
					if (url?.trim()) parts.push(url.trim());
				}
				if (selectedCommand === "cleanup") {
					const scope = await ctx.ui.select("Cleanup scope", cleanupScopeOptions());
					if (!scope) return;
					parts.push(scope.trim().split(/\s+/)[0] ?? "all");
				}
			}
			const subcommand = parts[0] ?? "help";
			const rest = parts.slice(1).join(" ");

			try {
				switch (subcommand) {
					case "status":
					case "": {
						setChromeStatus(ctx, manager);
						ctx.ui.notify(formatStatus(manager.statusDetails()), "info");
						return;
					}
					case "start": {
						const launchInput = parseChromeLaunchArgs(rest, {});
						const details = await manager.launch(await ensureLaunchProfileAllowed(launchInput, ctx), ctx.cwd, ctx.signal);
						setChromeStatus(ctx, manager);
						ctx.ui.notify(`Chrome started. ${details.currentTargetId ? `Current tab: ${details.currentTargetId}` : ""}`, "info");
						return;
					}
					case "stop": {
						const details = await manager.close({ target: "browser" }, ctx.signal);
						setChromeStatus(ctx, manager);
						ctx.ui.notify(details.message ?? "Chrome stopped.", "info");
						return;
					}
					case "tabs": {
						const result = await manager.tabs({ action: "list" }, ctx.signal);
						setChromeStatus(ctx, manager);
						if (!ctx.hasUI || result.tabs.length === 0) {
							ctx.ui.notify(formatTabs(result.tabs), "info");
							return;
						}
						const options = result.tabs.map((tab) => `${tab.targetId} ${tab.current ? "*" : " "} ${tab.title || "(untitled)"} — ${tab.url || "about:blank"}`);
						const selected = await ctx.ui.select("Activate Chrome tab", options);
						if (!selected) return;
						const tabId = selected.trim().split(/\s+/)[0];
						if (!tabId) return;
						await manager.tabs({ action: "activate", tabId }, ctx.signal);
						setChromeStatus(ctx, manager);
						ctx.ui.notify(`Activated tab ${tabId}.`, "info");
						return;
					}
					case "login": {
						if (!ctx.hasUI) {
							ctx.ui.notify("/chrome login requires an interactive UI.", "warning");
							return;
						}
						const launchInput = parseChromeLaunchArgs(rest, { headless: false });
						const url = launchInput.url ?? "about:blank";
						if (!manager.isConnected()) await manager.launch(await ensureLaunchProfileAllowed(launchInput, ctx), ctx.cwd, ctx.signal);
						else if (url !== "about:blank") await manager.navigate({ url, waitUntil: "load" }, ctx.signal);
						setChromeStatus(ctx, manager);
						await ctx.ui.confirm("Manual login", "Complete login in the visible isolated Chrome window, then confirm to return control to Pi.");
						ctx.ui.notify("Manual login handoff complete. Credentials were not exposed to the model by this command.", "info");
						return;
					}
					case "risk": {
						ctx.ui.notify(chromeRiskText(), "warning");
						return;
					}
					case "cleanup": {
						const scope = parseCleanupScope(rest.trim() || "all");
						if (!scope) {
							ctx.ui.notify("Usage: /chrome cleanup [all|artifacts|tmp]", "warning");
							return;
						}
						const activeUserDataDir = manager.statusDetails().userDataDir;
						const result = await cleanupWebChromeStorage({ scope, activeUserDataDir });
						ctx.ui.notify(formatCleanupResult(result), "info");
						return;
					}
					case "help": {
						ctx.ui.notify(chromeCommandHelp(), "info");
						return;
					}
					default:
						ctx.ui.notify(`Unknown /chrome subcommand: ${subcommand}\n\n${chromeCommandHelp()}`, "warning");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

function splitCommandArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function parseChromeLaunchArgs(args: string, defaults: Partial<ChromeLaunchParams>): ChromeLaunchParams {
	const tokens = splitCommandArgs(args);
	const input: ChromeLaunchParams = { ...defaults };
	const urlParts: string[] = [];

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		switch (token) {
			case "--visible":
			case "--headed":
				input.headless = false;
				break;
			case "--headless":
				input.headless = true;
				break;
			case "--profile-mode":
				input.profileMode = parseProfileMode(tokens[++index]);
				break;
			case "--profile":
			case "--profile-name":
				input.profileMode ??= "named";
				input.profileName = tokens[++index];
				break;
			case "--user-data-dir":
				input.profileMode = "custom";
				input.userDataDir = tokens[++index];
				break;
			case "--allow-default-profile":
				input.allowDefaultProfile = true;
				break;
			default:
				urlParts.push(token);
		}
	}

	input.url = urlParts.join(" ") || input.url || "about:blank";
	return input;
}

function parseProfileMode(value: string | undefined): ChromeLaunchParams["profileMode"] {
	if (value === "ephemeral" || value === "project" || value === "named" || value === "custom") return value;
	throw new Error("--profile-mode must be one of: ephemeral, project, named, custom");
}

function chromeCommandCompletions(prefix: string): AutocompleteItem[] | null {
	const parts = splitCommandArgs(prefix);
	if (prefix.endsWith(" ")) parts.push("");
	if (parts.length <= 1) {
		const needle = parts[0] ?? "";
		return CHROME_SUBCOMMANDS.filter((value) => value.startsWith(needle)).map((value) => ({ value, label: value }));
	}
	return null;
}

function chromeCommandMenuOptions(): string[] {
	return [
		"status — Show connection/browser/tabs/profile risk",
		"start — Launch isolated Chrome, optionally at a URL",
		"stop — Close managed Chrome or disconnect existing endpoint",
		"tabs — List tabs and activate one interactively",
		"login — Open visible isolated Chrome for manual login",
		"risk — Explain CDP security and privacy risks",
		"cleanup — Remove web-chrome artifacts and temporary profiles",
		"help — Show command help",
	];
}

function cleanupScopeOptions(): string[] {
	return [
		"all — Remove artifacts and ephemeral temporary profiles",
		"artifacts — Remove screenshot/body/evaluation/protocol artifacts",
		"tmp — Remove ephemeral temporary Chrome profiles",
	];
}

function parseCleanupScope(value: string): CleanupScope | undefined {
	if (value === "all" || value === "artifacts" || value === "tmp") return value;
	return undefined;
}

function chromeCommandHelp(): string {
	return [
		"Usage: /chrome <subcommand>",
		"",
		"Run /chrome with no arguments to select a command interactively.",
		"",
		"Subcommands:",
		"  status         Show connection/browser/tabs/profile risk",
		"  start [url] [--visible|--headless] [--profile <name>]",
		"                 [--profile-mode <mode>] [--user-data-dir <path>] [--allow-default-profile]",
		"  stop           Close managed Chrome or disconnect existing endpoint",
		"  tabs           List tabs and activate one interactively when UI is available",
		"  login [url] [--profile <name>] [--user-data-dir <path>] Open visible Chrome for manual login/OAuth",
		"  risk           Explain CDP security and privacy risks",
		"  cleanup [scope] Remove artifacts and temp profiles (scope: all, artifacts, tmp)",
		"  help           Show this help",
	].join("\n");
}

async function ensureLaunchProfileAllowed(params: ChromeLaunchParams, ctx: ExtensionContext): Promise<ChromeLaunchParams> {
	const profileMode = params.profileMode ?? (process.env.PI_WEB_CHROME_PROFILE_MODE as ChromeLaunchParams["profileMode"] | undefined);
	const userDataDir = params.userDataDir ?? process.env.PI_WEB_CHROME_USER_DATA_DIR;
	const riskyDefaultProfile = profileMode === "custom" && !!userDataDir && looksLikeDefaultChromeProfile(userDataDir);
	if (!riskyDefaultProfile || params.allowDefaultProfile === true || envBoolean(process.env.PI_WEB_CHROME_ALLOW_DEFAULT_PROFILE) === true) return params;

	const warning = [
		"You are trying to launch Chrome with a userDataDir that looks like the default Chrome profile.",
		"This can expose your real cookies, Google account, browsing sessions, local storage, screenshots, network headers, and page contents to CDP tools.",
		"Chrome 136+ may ignore remote-debugging flags for default profiles, so this may fail even if allowed.",
		"For Google OAuth testing, prefer the default visible isolated named profile, or another named profile, and sign in once with /chrome login.",
	].join("\n\n");

	if (!ctx.hasUI) {
		throw new Error(`${warning}\n\nNon-interactive mode requires allowDefaultProfile=true or PI_WEB_CHROME_ALLOW_DEFAULT_PROFILE=1.`);
	}

	const ok = await ctx.ui.confirm("Use default Chrome profile?", warning);
	if (!ok) throw new Error("User declined launching against the default Chrome profile.");
	return { ...params, allowDefaultProfile: true };
}

async function ensureExistingBrowserAllowed(params: ChromeConnectParams, ctx: ExtensionContext): Promise<void> {
	if (params.allowRiskyExistingBrowser === true || allowExistingBrowserFromEnv()) return;
	const warning = [
		"Connecting to an existing Chrome CDP endpoint is risky.",
		"CDP can expose cookies, local/session storage, page contents, screenshots, authenticated sessions, network traffic, and JavaScript execution.",
		"Prefer chrome_launch for an isolated profile.",
	].join("\n\n");

	if (!ctx.hasUI) {
		throw new Error(`${warning}\n\nNon-interactive mode requires allowRiskyExistingBrowser=true or PI_WEB_CHROME_ALLOW_EXISTING=1.`);
	}

	const ok = await ctx.ui.confirm("Connect to existing Chrome?", warning);
	if (!ok) throw new Error("User declined existing-browser CDP connection.");
}

async function ensureSensitiveNetworkAllowed(params: ChromeNetworkParams, ctx: ExtensionContext): Promise<void> {
	if (params.includeSensitive !== true) return;
	const warning = "chrome_network includeSensitive=true may expose cookies, auth headers, API keys, tokens, and sensitive query parameters.";
	if (!ctx.hasUI) throw new Error(`${warning} Non-interactive mode cannot confirm this; omit includeSensitive.`);
	const ok = await ctx.ui.confirm("Include sensitive network data?", warning);
	if (!ok) throw new Error("User declined sensitive network output.");
}

function setChromeStatus(ctx: ExtensionContext, manager: BrowserManager): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus("web-chrome", manager.statusLine());
}

function textResult<T>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details };
}

function formatStatus(details: StatusDetails): string {
	const lines = [
		`Status: ${details.status}${details.connected ? " (connected)" : ""}`,
		`Risk: ${details.riskyExistingBrowser ? "⚠ connected to existing browser" : "isolated/managed or disconnected"}`,
	];
	if (details.version?.product) lines.push(`Browser: ${details.version.product}`);
	if (details.version?.protocolVersion) lines.push(`Protocol: ${details.version.protocolVersion}`);
	if (details.endpoint) lines.push(`Endpoint: ${details.endpoint}`);
	if (details.userDataDir) lines.push(`User data dir: ${details.userDataDir}`);
	if (details.pid) lines.push(`PID: ${details.pid}`);
	if (details.currentTargetId) lines.push(`Current tab: ${details.currentTargetId}`);
	lines.push(`Tabs: ${details.tabs.length}`);
	if (details.message) lines.push(`Message: ${details.message}`);
	if (details.tabs.length > 0) lines.push("", formatTabs(details.tabs));
	return lines.join("\n");
}

function formatTabs(tabs: TabSummary[]): string {
	if (tabs.length === 0) return "No tabs.";
	return tabs
		.map((tab, index) => {
			const marker = tab.current ? "*" : " ";
			const title = tab.title || "(untitled)";
			const url = tab.url || "about:blank";
			return `${marker} ${index + 1}. ${tab.targetId} [${tab.type}${tab.attached ? ", attached" : ""}] ${title}\n   ${url}`;
		})
		.join("\n");
}

function formatConsoleEntries(entries: Array<{ level: string; text: string; source: string; url?: string; lineNumber?: number }>): string {
	if (entries.length === 0) return "No console entries.";
	return entries
		.map((entry) => {
			const location = entry.url ? ` (${entry.url}${entry.lineNumber !== undefined ? `:${entry.lineNumber}` : ""})` : "";
			return `[${entry.level}] ${entry.source}${location}: ${entry.text}`;
		})
		.join("\n");
}

function formatNetworkRequests(
	requests: Array<{ requestId: string; method?: string; status?: number; failed?: boolean; errorText?: string; resourceType?: string; url: string; encodedDataLength?: number }>,
): string {
	if (requests.length === 0) return "No network requests.";
	return requests
		.map((request) => {
			const status = request.failed ? `FAILED ${request.errorText ?? ""}`.trim() : request.status ?? "pending";
			const size = request.encodedDataLength !== undefined ? ` ${request.encodedDataLength}B` : "";
			return `${request.requestId} ${request.method ?? "GET"} ${status} [${request.resourceType ?? "Other"}]${size}\n   ${request.url}`;
		})
		.join("\n");
}

function chromeRiskText(): string {
	return [
		"web-chrome uses Chrome DevTools Protocol (CDP), which is very powerful.",
		"Safe launch mode uses an isolated profile, localhost-only random port, and headless Chrome by default.",
		"Connecting to an existing browser can expose cookies, local/session storage, page contents, screenshots, network headers/bodies, and authenticated sessions.",
		"chrome_network redacts sensitive headers/query values by default. chrome_evaluate should never be used to extract credentials or bypass app logic.",
	].join("\n\n");
}

function chromeRenderers<TDetails = unknown>(toolName: string) {
	return {
		renderCall(args: unknown, theme: any) {
			return renderCallText(toolName, summarizeArgs(args), theme);
		},
		renderResult(result: AgentToolResult<TDetails>, _options: unknown, theme: any) {
			return renderResultText(firstText(result), theme);
		},
	};
}

function renderCallText(toolName: string, summary: string, theme: any): Text {
	const text = summary ? `${theme.fg("toolTitle", toolName)} ${theme.fg("muted", summary)}` : theme.fg("toolTitle", toolName);
	return new Text(text, 0, 0);
}

function renderResultText(summary: string, theme: any): Text {
	return new Text(`${theme.fg("success", "✓")} ${theme.fg("muted", truncateInline(summary, 120))}`, 0, 0);
}

function summarizeArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const priority = ["action", "url", "ref", "selector", "key", "text", "target", "path"];
	for (const key of priority) {
		const value = record[key];
		if (typeof value === "string" && value) return `${key}=${truncateInline(value, 80)}`;
	}
	return "";
}

function firstText(result: AgentToolResult<unknown>): string {
	const item = result.content?.find((entry) => entry.type === "text");
	return item?.type === "text" ? item.text.split(/\r?\n/)[0] ?? "Done" : "Done";
}

function truncateInline(value: string, max: number): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 1))}…`;
}
