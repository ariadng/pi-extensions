import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AskConfig, AskPreviewMode } from "./types.js";

export function registerAskFlags(pi: ExtensionAPI): void {
	pi.registerFlag("ask-preview", {
		description: "AskUserQuestion preview mode: off, markdown, or html",
		type: "string",
		default: "markdown",
	});
	pi.registerFlag("ask-no-preferences", {
		description: "Disable persistent AskUserQuestion default answer preferences",
		type: "boolean",
		default: false,
	});
}

export function defaultAskConfig(): AskConfig {
	return {
		previewMode: normalizePreviewMode(process.env.PI_ASK_PREVIEW) ?? "markdown",
		preferences: process.env.PI_ASK_PREFERENCES !== "0",
	};
}

export function resolveAskConfig(pi: ExtensionAPI): AskConfig {
	const flagPreview = typeof pi.getFlag("ask-preview") === "string" ? normalizePreviewMode(pi.getFlag("ask-preview") as string) : undefined;
	return {
		previewMode: normalizePreviewMode(process.env.PI_ASK_PREVIEW) ?? flagPreview ?? "markdown",
		preferences: process.env.PI_ASK_PREFERENCES !== "0" && pi.getFlag("ask-no-preferences") !== true,
	};
}

function normalizePreviewMode(value: string | undefined): AskPreviewMode | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "off" || normalized === "markdown" || normalized === "html") return normalized;
	return undefined;
}
