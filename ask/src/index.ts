import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskCommands } from "./commands.js";
import { defaultAskConfig, registerAskFlags, resolveAskConfig } from "./config.js";
import { AskPreferencesStore } from "./preferences.js";
import { createAskUserQuestionTool, type AskExecutionOptions } from "./tool.js";
import type { AskConfig } from "./types.js";

export default function askExtension(pi: ExtensionAPI): void {
	registerAskFlags(pi);
	const config: AskConfig = defaultAskConfig();
	const preferences = new AskPreferencesStore();
	const getOptions = (): AskExecutionOptions => ({ config, preferences });

	pi.registerTool(createAskUserQuestionTool(getOptions));
	registerAskCommands(pi, getOptions);

	pi.on("session_start", async () => {
		Object.assign(config, resolveAskConfig(pi));
	});
}
