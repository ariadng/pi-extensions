import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import serialize from "dom-serializer";
import { parseDocument } from "htmlparser2";
import { extension as mimeExtension } from "mime-types";
import TurndownService from "turndown";
import { writeTempBytesFile } from "./output.js";
import { byteLength, formatBytes, normalizeHostnameForPolicy } from "./utils.js";

export type ConvertedContent = {
	markdown: string;
	markdownBytes: number;
	contentKind: "text" | "binary";
	title?: string;
	persistedBinaryPath?: string;
};

export type ConvertResponseOptions = {
	bytes: Uint8Array;
	contentType: string;
	finalUrl: string;
	signal?: AbortSignal;
};

type DomNode = {
	type?: string;
	name?: string;
	attribs?: Record<string, string | undefined>;
	children?: DomNode[];
	data?: string;
};

const STRIP_TAGS = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"iframe",
	"canvas",
	"svg",
	"nav",
	"header",
	"footer",
	"aside",
	"form",
]);

export async function convertResponseBody(options: ConvertResponseOptions): Promise<ConvertedContent> {
	throwIfAborted(options.signal);
	const contentType = options.contentType || "";
	const mime = getMimeType(contentType);

	if (!isTextualContentType(contentType) && !(mime === "" && looksTextLike(options.bytes))) {
		return persistBinaryContent(options.bytes, contentType, options.finalUrl, options.signal);
	}

	const text = decodeBytes(options.bytes, contentType).replace(/\u0000/gu, "");
	throwIfAborted(options.signal);

	let markdown: string;
	let title: string | undefined;
	if (mime === "text/html" || mime === "application/xhtml+xml") {
		const html = sanitizeHtml(text);
		title = extractTitle(html);
		markdown = htmlToMarkdown(html);
	} else if (isJsonContentType(mime)) {
		markdown = formatJson(text);
	} else {
		markdown = text;
	}

	markdown = normalizeMarkdown(markdown);
	return {
		markdown,
		markdownBytes: byteLength(markdown),
		contentKind: "text",
		title,
	};
}

export function sanitizeHtml(html: string): string {
	const document = parseDocument(html, {
		decodeEntities: true,
		lowerCaseAttributeNames: true,
		lowerCaseTags: true,
		recognizeSelfClosing: true,
	}) as DomNode;
	document.children = pruneNodes(document.children ?? []);
	return serialize(document as never, { encodeEntities: "utf8" });
}

export function htmlToMarkdown(html: string): string {
	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "*",
		strongDelimiter: "**",
	});
	turndown.remove(["script", "style", "noscript", "template"]);
	turndown.addRule("dropEmptyLinks", {
		filter: (node) => node.nodeName === "A" && !node.textContent.trim(),
		replacement: () => "",
	});
	return turndown.turndown(html);
}

export function getMimeType(contentType: string): string {
	return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isTextualContentType(contentType: string): boolean {
	const type = getMimeType(contentType);
	if (!type) return false;
	if (type.startsWith("text/")) return true;
	return [
		"application/json",
		"application/ld+json",
		"application/xml",
		"application/xhtml+xml",
		"application/rss+xml",
		"application/atom+xml",
		"image/svg+xml",
	].includes(type) || type.endsWith("+json") || type.endsWith("+xml");
}

export function isJsonContentType(mime: string): boolean {
	return mime === "application/json" || mime === "application/ld+json" || mime.endsWith("+json");
}

function pruneNodes(nodes: DomNode[]): DomNode[] {
	const kept: DomNode[] = [];
	for (const node of nodes) {
		if (shouldDropNode(node)) continue;
		if (node.children) node.children = pruneNodes(node.children);
		kept.push(node);
	}
	return kept;
}

function shouldDropNode(node: DomNode): boolean {
	if (node.type === "comment" || node.type === "directive") return true;
	const name = node.name?.toLowerCase();
	if (name && STRIP_TAGS.has(name)) return true;
	const attribs = node.attribs ?? {};
	if (attribs.hidden !== undefined) return true;
	if (attribs["aria-hidden"]?.toLowerCase() === "true") return true;
	if (attribs.type?.toLowerCase() === "hidden") return true;
	const style = attribs.style?.toLowerCase() ?? "";
	if (/display\s*:\s*none/u.test(style) || /visibility\s*:\s*hidden/u.test(style)) return true;
	if (name === "img" && isLikelyTrackingPixel(attribs)) return true;
	return false;
}

function isLikelyTrackingPixel(attribs: Record<string, string | undefined>): boolean {
	const width = attribs.width?.trim();
	const height = attribs.height?.trim();
	const style = attribs.style?.toLowerCase() ?? "";
	return (width === "1" && height === "1") || /width\s*:\s*1px/u.test(style) || /height\s*:\s*1px/u.test(style);
}

function extractTitle(html: string): string | undefined {
	const document = parseDocument(html, { decodeEntities: true, lowerCaseTags: true }) as DomNode;
	const title = findFirstTextInTag(document.children ?? [], "title")?.trim().replace(/\s+/gu, " ");
	return title || undefined;
}

function findFirstTextInTag(nodes: DomNode[], tag: string): string | undefined {
	for (const node of nodes) {
		if (node.name?.toLowerCase() === tag) return collectText(node.children ?? []);
		const nested = findFirstTextInTag(node.children ?? [], tag);
		if (nested) return nested;
	}
	return undefined;
}

function collectText(nodes: DomNode[]): string {
	let output = "";
	for (const node of nodes) {
		if (typeof node.data === "string") output += node.data;
		if (node.children) output += collectText(node.children);
	}
	return output;
}

function decodeBytes(bytes: Uint8Array, contentType: string): string {
	const charset = charsetFromContentType(contentType) ?? "utf-8";
	try {
		return new TextDecoder(charset, { fatal: false }).decode(bytes);
	} catch {
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	}
}

function charsetFromContentType(contentType: string): string | undefined {
	const match = contentType.match(/(?:^|;)\s*charset=([^;]+)/iu);
	return match?.[1]?.trim().replace(/^"|"$/gu, "");
}

function formatJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

function normalizeMarkdown(markdown: string): string {
	return markdown
		.replace(/\r\n?/gu, "\n")
		.replace(/[ \t]+\n/gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

function looksTextLike(bytes: Uint8Array): boolean {
	if (bytes.length === 0) return true;
	let printable = 0;
	const limit = Math.min(bytes.length, 4096);
	for (let index = 0; index < limit; index += 1) {
		const byte = bytes[index];
		if (byte === 0) return false;
		if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 0xc2) printable += 1;
	}
	return printable / limit > 0.85;
}

async function persistBinaryContent(bytes: Uint8Array, contentType: string, finalUrl: string, signal?: AbortSignal): Promise<ConvertedContent> {
	throwIfAborted(signal);
	const mime = getMimeType(contentType) || "application/octet-stream";
	const extension = mimeExtension(mime) || extensionFromUrl(finalUrl) || "bin";
	const host = safeHost(finalUrl);
	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
	const path = await writeTempBytesFile("pi-webfetch-", `${host}-${hash}.${extension}`, bytes);
	throwIfAborted(signal);
	const markdown = `Fetched binary content (${mime}, ${formatBytes(bytes.byteLength)}). Saved to ${path}.\nUse the read tool on that file if you need to inspect it.`;
	return {
		markdown,
		markdownBytes: byteLength(markdown),
		contentKind: "binary",
		persistedBinaryPath: path,
	};
}

function extensionFromUrl(url: string): string | undefined {
	try {
		const pathname = new URL(url).pathname;
		const match = pathname.match(/\.([a-zA-Z0-9]{1,8})$/u);
		return match?.[1]?.toLowerCase();
	} catch {
		return undefined;
	}
}

function safeHost(url: string): string {
	try {
		return normalizeHostnameForPolicy(new URL(url).hostname).replace(/[^a-zA-Z0-9.-]+/gu, "-") || "webfetch";
	} catch {
		return "webfetch";
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new Error("WebFetch conversion was aborted");
}

export const _test = {
	looksTextLike,
};
