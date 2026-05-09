import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WebFetchCache } from "./cache.js";
import { registerWebFetchCommands } from "./commands.js";
import { defaultWebFetchConfig, registerWebFetchFlags, resolveWebFetchConfig } from "./config.js";
import { createWebFetchTool, type WebFetchRuntime } from "./tool.js";

export default function webFetchExtension(pi: ExtensionAPI): void {
	registerWebFetchFlags(pi);

	const initialConfig = defaultWebFetchConfig();
	const runtime: WebFetchRuntime = {
		config: initialConfig,
		cache: new WebFetchCache(initialConfig.cacheTtlMs, initialConfig.cacheBytes),
	};

	pi.registerTool(createWebFetchTool(() => runtime));
	registerWebFetchCommands(pi, runtime);

	pi.on("session_start", async (_event, ctx) => {
		runtime.config = resolveWebFetchConfig(pi, ctx.cwd);
		runtime.cache.configure({ ttlMs: runtime.config.cacheTtlMs, maxBytes: runtime.config.cacheBytes });
	});
}
