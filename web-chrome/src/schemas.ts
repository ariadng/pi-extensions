import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";

export const EmptyParamsSchema = Type.Object({}, { additionalProperties: false });

export const ProfileModeSchema = StringEnum(["ephemeral", "project", "named", "custom"] as const, {
	description: "Isolated Chrome profile mode. Defaults to named.",
});

export const LoadStateSchema = StringEnum(["domcontentloaded", "load", "networkidle"] as const, {
	description: "Page load state to wait for.",
});

export const ChromeLaunchParamsSchema = Type.Object(
	{
		url: Type.Optional(Type.String({ description: "Initial URL. Allowed schemes: http, https, about. Default: about:blank." })),
		headless: Type.Optional(Type.Boolean({ description: "Launch headless Chrome with --headless=new. Default: true; pass false for a visible browser." })),
		profileMode: Type.Optional(ProfileModeSchema),
		profileName: Type.Optional(Type.String({ description: "Profile name for profileMode=named. Default: default." })),
		userDataDir: Type.Optional(Type.String({ description: "Dedicated user data dir for profileMode=custom. Default Chrome profiles are refused." })),
		chromePath: Type.Optional(Type.String({ description: "Explicit Chrome/Chromium executable path." })),
		forceNew: Type.Optional(Type.Boolean({ description: "Close the current managed/connected browser and launch a new one." })),
		allowDefaultProfile: Type.Optional(
			Type.Boolean({
				description:
					"Risky opt-in for profileMode=custom when userDataDir looks like the default Chrome profile. May still fail on Chrome 136+ because Chrome ignores remote debugging for default profiles.",
			}),
		),
		timeoutMs: Type.Optional(Type.Number({ minimum: 1000, description: "Launch/connect timeout in milliseconds. Default: 15000." })),
	},
	{ additionalProperties: false },
);

export const ChromeConnectParamsSchema = Type.Object(
	{
		endpoint: Type.String({ description: "Local CDP endpoint: http://127.0.0.1:9222 or ws://127.0.0.1:9222/devtools/browser/..." }),
		allowRiskyExistingBrowser: Type.Optional(
			Type.Boolean({ description: "Required in non-interactive mode to acknowledge existing-browser CDP privacy risks." }),
		),
		timeoutMs: Type.Optional(Type.Number({ minimum: 1000, description: "Connect timeout in milliseconds. Default: 10000." })),
	},
	{ additionalProperties: false },
);

export const ChromeCloseParamsSchema = Type.Object(
	{
		target: Type.Optional(
			StringEnum(["browser", "tab"] as const, {
				description: "What to close. browser closes managed Chrome or disconnects from existing endpoints; tab closes a tab.",
				default: "browser",
			}),
		),
		tabId: Type.Optional(Type.String({ description: "Target/tab id when target=tab." })),
	},
	{ additionalProperties: false },
);

export const ChromeTabsParamsSchema = Type.Object(
	{
		action: StringEnum(["list", "new", "select", "activate", "close"] as const, { description: "Tab operation to perform." }),
		tabId: Type.Optional(Type.String({ description: "Target/tab id for select, activate, or close." })),
		url: Type.Optional(Type.String({ description: "URL for action=new. Default: about:blank." })),
		includeAllTargets: Type.Optional(Type.Boolean({ description: "Include non-page CDP targets. Default: false." })),
	},
	{ additionalProperties: false },
);

export const ChromeNavigateParamsSchema = Type.Object(
	{
		url: Type.String({ description: "Destination URL. Allowed schemes: http, https, about." }),
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		waitUntil: Type.Optional(
			StringEnum(["none", "domcontentloaded", "load", "networkidle"] as const, {
				description: "State to wait for after navigation. Default: load.",
				default: "load",
			}),
		),
		timeoutMs: Type.Optional(Type.Number({ minimum: 1000, description: "Navigation timeout in milliseconds. Default: 30000." })),
	},
	{ additionalProperties: false },
);

export const ChromeSearchParamsSchema = Type.Object(
	{
		query: Type.String({ minLength: 1, description: "Search query." }),
		engine: Type.Optional(StringEnum(["auto", "google", "duckduckgo"] as const, { description: "Search engine. Default: auto (DuckDuckGo then Google)." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Maximum results to return. Default: 10." })),
		language: Type.Optional(Type.String({ description: "Language hint for search, e.g. en. Default: en." })),
		region: Type.Optional(Type.String({ description: "Region hint, used by DuckDuckGo as kl when provided." })),
		duckDuckGoMode: Type.Optional(StringEnum(["html", "lite", "web"] as const, { description: "DuckDuckGo variant. Default: html for lightweight results." })),
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		timeoutMs: Type.Optional(Type.Number({ minimum: 1000, description: "Search navigation/extraction timeout in milliseconds. Default: 30000." })),
	},
	{ additionalProperties: false },
);

export const ChromeWaitForParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		timeMs: Type.Optional(Type.Number({ minimum: 0, description: "Sleep for this many milliseconds." })),
		text: Type.Optional(Type.String({ description: "Wait until page visible text contains this value." })),
		textGone: Type.Optional(Type.String({ description: "Wait until page visible text does not contain this value." })),
		selector: Type.Optional(Type.String({ description: "Wait until document.querySelector(selector) exists." })),
		selectorGone: Type.Optional(Type.String({ description: "Wait until document.querySelector(selector) is absent." })),
		urlContains: Type.Optional(Type.String({ description: "Wait until location.href contains this substring." })),
		loadState: Type.Optional(LoadStateSchema),
		timeoutMs: Type.Optional(Type.Number({ minimum: 100, description: "Overall timeout in milliseconds. Default: 30000." })),
	},
	{ additionalProperties: false },
);

const TargetFields = {
	ref: Type.Optional(Type.String({ description: "Element ref from the most recent chrome_snapshot." })),
	selector: Type.Optional(Type.String({ description: "CSS selector target." })),
	x: Type.Optional(Type.Number({ description: "Viewport x coordinate target. Requires y." })),
	y: Type.Optional(Type.Number({ description: "Viewport y coordinate target. Requires x." })),
};

export const ModifierSchema = StringEnum(["Alt", "Control", "Ctrl", "Meta", "Command", "Shift"] as const, {
	description: "Keyboard/mouse modifier key.",
});

export const ChromeSnapshotParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		includeBoxes: Type.Optional(Type.Boolean({ description: "Include element bounding boxes. Default: true." })),
		maxNodes: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Maximum semantic nodes to return. Default: 120." })),
		includeText: Type.Optional(Type.Boolean({ description: "Include body text summary. Default: false." })),
		selector: Type.Optional(Type.String({ description: "Snapshot only a subtree matching this selector." })),
	},
	{ additionalProperties: false },
);

export const ChromeClickParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		...TargetFields,
		button: Type.Optional(StringEnum(["left", "right", "middle"] as const, { description: "Mouse button. Default: left." })),
		doubleClick: Type.Optional(Type.Boolean({ description: "Double-click instead of single-click." })),
		modifiers: Type.Optional(Type.Array(ModifierSchema, { description: "Modifier keys to hold for the click." })),
		waitAfterMs: Type.Optional(Type.Number({ minimum: 0, description: "Delay after click. Default: 100." })),
	},
	{ additionalProperties: false },
);

export const ChromeTypeParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		...TargetFields,
		text: Type.String({ description: "Text to insert." }),
		clear: Type.Optional(Type.Boolean({ description: "Clear target before inserting text." })),
		submit: Type.Optional(Type.Boolean({ description: "Press Enter after inserting text." })),
		slowly: Type.Optional(Type.Boolean({ description: "Insert one character at a time." })),
	},
	{ additionalProperties: false },
);

export const ChromePressKeyParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		key: Type.String({ description: "Key or chord, e.g. Enter, Escape, Tab, Backspace, Meta+A, Control+L." }),
		modifiers: Type.Optional(Type.Array(ModifierSchema, { description: "Additional modifier keys." })),
		waitAfterMs: Type.Optional(Type.Number({ minimum: 0, description: "Delay after key press. Default: 50." })),
	},
	{ additionalProperties: false },
);

export const ChromeScrollParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		...TargetFields,
		deltaX: Type.Optional(Type.Number({ description: "Horizontal wheel delta. Default: 0." })),
		deltaY: Type.Optional(Type.Number({ description: "Vertical wheel delta. Default: 600." })),
	},
	{ additionalProperties: false },
);

export const ChromeScreenshotParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		path: Type.Optional(Type.String({ description: "Optional output path. Defaults to web-chrome artifact directory." })),
		fullPage: Type.Optional(Type.Boolean({ description: "Capture the full page instead of viewport." })),
		selector: Type.Optional(Type.String({ description: "Optional element selector to screenshot." })),
		format: Type.Optional(StringEnum(["png", "jpeg", "webp"] as const, { description: "Image format. Default: png." })),
		quality: Type.Optional(Type.Number({ minimum: 0, maximum: 100, description: "JPEG/WebP quality." })),
	},
	{ additionalProperties: false },
);

export const ChromeConsoleParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		level: Type.Optional(StringEnum(["debug", "info", "warning", "error"] as const, { description: "Filter by console level." })),
		all: Type.Optional(Type.Boolean({ description: "Return all buffered entries instead of entries since last call/navigation." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Maximum entries. Default: 100." })),
	},
	{ additionalProperties: false },
);

export const ChromeNetworkParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		filter: Type.Optional(Type.String({ description: "String or regex filter matched against redacted request URLs." })),
		includeStatic: Type.Optional(Type.Boolean({ description: "Include images, fonts, CSS, and media. Default: false." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000, description: "Maximum requests. Default: 100." })),
		bodyRequestId: Type.Optional(Type.String({ description: "Request id whose response body should be fetched when includeBody=true." })),
		includeHeaders: Type.Optional(Type.Boolean({ description: "Include request/response headers with sensitive values redacted by default." })),
		includeBody: Type.Optional(Type.Boolean({ description: "Fetch response body for bodyRequestId and truncate output." })),
		includeSensitive: Type.Optional(Type.Boolean({ description: "Include sensitive headers/query values; requires confirmation/explicit opt-in." })),
	},
	{ additionalProperties: false },
);

export const ChromeEvaluateParamsSchema = Type.Object(
	{
		tabId: Type.Optional(Type.String({ description: "Target/tab id. Defaults to current tab." })),
		expression: Type.String({ description: "JavaScript expression to evaluate in the page. Do not extract secrets." }),
		awaitPromise: Type.Optional(Type.Boolean({ description: "Await promise results. Default: true." })),
		returnByValue: Type.Optional(Type.Boolean({ description: "Return JSON-serializable value when possible. Default: true; false returns a summary only." })),
		timeoutMs: Type.Optional(Type.Number({ minimum: 100, description: "Evaluation timeout in milliseconds. Default: 5000." })),
	},
	{ additionalProperties: false },
);

export type ChromeLaunchParams = Static<typeof ChromeLaunchParamsSchema>;
export type ChromeConnectParams = Static<typeof ChromeConnectParamsSchema>;
export type ChromeCloseParams = Static<typeof ChromeCloseParamsSchema>;
export type ChromeTabsParams = Static<typeof ChromeTabsParamsSchema>;
export type ChromeNavigateParams = Static<typeof ChromeNavigateParamsSchema>;
export type ChromeSearchParams = Static<typeof ChromeSearchParamsSchema>;
export type ChromeWaitForParams = Static<typeof ChromeWaitForParamsSchema>;
export type ChromeSnapshotParams = Static<typeof ChromeSnapshotParamsSchema>;
export type ChromeClickParams = Static<typeof ChromeClickParamsSchema>;
export type ChromeTypeParams = Static<typeof ChromeTypeParamsSchema>;
export type ChromePressKeyParams = Static<typeof ChromePressKeyParamsSchema>;
export type ChromeScrollParams = Static<typeof ChromeScrollParamsSchema>;
export type ChromeScreenshotParams = Static<typeof ChromeScreenshotParamsSchema>;
export type ChromeConsoleParams = Static<typeof ChromeConsoleParamsSchema>;
export type ChromeNetworkParams = Static<typeof ChromeNetworkParamsSchema>;
export type ChromeEvaluateParams = Static<typeof ChromeEvaluateParamsSchema>;
