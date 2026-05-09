import type { AskPreviewMode } from "./types.js";

export interface PreviewProcessResult {
	preview?: string;
	error?: string;
	warning?: string;
}

export function processPreview(preview: string | undefined, mode: AskPreviewMode, location: string): PreviewProcessResult {
	if (!preview) return {};
	if (mode === "off") return { warning: `${location} preview ignored because ask-preview=off.` };
	if (mode === "markdown") return { preview };
	return sanitizeHtmlPreview(preview, location);
}

export function sanitizeHtmlPreview(preview: string, location = "HTML preview"): PreviewProcessResult {
	if (/<\s*!doctype\b/i.test(preview)) return { error: `${location} must be an HTML fragment, not a full document with <!DOCTYPE>.` };
	if (/<\s*\/?\s*(html|body)\b/i.test(preview)) return { error: `${location} must be an HTML fragment and must not include <html> or <body>.` };
	if (/<\s*(script|style)\b/i.test(preview)) return { error: `${location} must not include <script> or <style>.` };
	if (!/<\s*[a-z][\w:-]*(\s|>|\/)/i.test(preview)) return { error: `${location} in html mode must contain at least one HTML tag.` };

	const text = decodeBasicEntities(
		preview
			.replace(/<!--[\s\S]*?-->/gu, "")
			.replace(/<\s*br\s*\/?\s*>/giu, "\n")
			.replace(/<\s*\/\s*(p|div|section|article|header|footer|li|ul|ol|h[1-6]|blockquote|pre|tr)\s*>/giu, "\n")
			.replace(/<\s*(li|p|div|section|article|header|footer|h[1-6]|blockquote|pre|tr|td|th)\b[^>]*>/giu, "\n")
			.replace(/<[^>]+>/gu, "")
			.replace(/[ \t]+\n/gu, "\n")
			.replace(/\n{3,}/gu, "\n\n")
			.trim(),
	);

	return { preview: text || "(empty sanitized HTML preview)" };
}

function decodeBasicEntities(value: string): string {
	return value
		.replace(/&nbsp;/giu, " ")
		.replace(/&amp;/giu, "&")
		.replace(/&lt;/giu, "<")
		.replace(/&gt;/giu, ">")
		.replace(/&quot;/giu, '"')
		.replace(/&#39;/giu, "'");
}
