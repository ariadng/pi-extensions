import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";

export type PiResultContent = TextContent | ImageContent;

export interface ConvertedMcpResult {
	content: PiResultContent[];
	details: Record<string, unknown>;
	text: string;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function extensionForMime(mimeType: string | undefined): string {
	if (!mimeType) return ".bin";
	if (mimeType.includes("json")) return ".json";
	if (mimeType.includes("text")) return ".txt";
	if (mimeType === "image/png") return ".png";
	if (mimeType === "image/jpeg") return ".jpg";
	if (mimeType === "image/gif") return ".gif";
	if (mimeType === "image/webp") return ".webp";
	if (mimeType === "audio/mpeg") return ".mp3";
	if (mimeType === "audio/wav") return ".wav";
	return ".bin";
}

async function saveTemp(content: string | Buffer, filename: string): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-mcp-"));
	const filePath = path.join(dir, filename);
	await writeFile(filePath, content);
	return filePath;
}

async function saveBase64(data: string, mimeType: string | undefined, basename: string): Promise<string> {
	const extension = extensionForMime(mimeType);
	return saveTemp(Buffer.from(data, "base64"), `${basename}${extension}`);
}

function blockLabel(block: Record<string, unknown>): string {
	if (typeof block.type === "string") return block.type;
	return "unknown";
}

async function collectBlocks(blocks: unknown[] | undefined, basename: string): Promise<{ textParts: string[]; images: ImageContent[]; files: string[] }> {
	const textParts: string[] = [];
	const images: ImageContent[] = [];
	const files: string[] = [];

	for (const raw of blocks ?? []) {
		if (!raw || typeof raw !== "object") {
			textParts.push(safeJson(raw));
			continue;
		}
		const block = raw as Record<string, unknown>;
		switch (block.type) {
			case "text": {
				textParts.push(typeof block.text === "string" ? block.text : safeJson(block));
				break;
			}
			case "image": {
				if (typeof block.data === "string" && typeof block.mimeType === "string") {
					images.push({ type: "image", data: block.data, mimeType: block.mimeType });
				} else {
					textParts.push(safeJson(block));
				}
				break;
			}
			case "audio": {
				if (typeof block.data === "string") {
					const filePath = await saveBase64(block.data, typeof block.mimeType === "string" ? block.mimeType : undefined, `${basename}-audio`);
					files.push(filePath);
					textParts.push(`[MCP audio content saved to: ${filePath}]`);
				} else {
					textParts.push(safeJson(block));
				}
				break;
			}
			case "resource": {
				const resource = block.resource;
				if (resource && typeof resource === "object") {
					const record = resource as Record<string, unknown>;
					if (typeof record.text === "string") {
						textParts.push(record.text);
					} else if (typeof record.blob === "string") {
						const filePath = await saveBase64(record.blob, typeof record.mimeType === "string" ? record.mimeType : undefined, `${basename}-resource`);
						files.push(filePath);
						textParts.push(`[MCP resource ${typeof record.uri === "string" ? record.uri : "blob"} saved to: ${filePath}]`);
					} else {
						textParts.push(safeJson(block));
					}
				} else {
					textParts.push(safeJson(block));
				}
				break;
			}
			case "resource_link": {
				const name = typeof block.name === "string" ? block.name : "resource";
				const uri = typeof block.uri === "string" ? block.uri : "unknown-uri";
				const description = typeof block.description === "string" ? ` — ${block.description}` : "";
				textParts.push(`[MCP resource link: ${name} <${uri}>${description}]`);
				break;
			}
			default: {
				textParts.push(`[MCP ${blockLabel(block)} block]\n${safeJson(block)}`);
			}
		}
	}

	return { textParts, images, files };
}

async function buildConvertedResult(input: {
	blocks?: unknown[];
	structuredContent?: unknown;
	meta?: unknown;
	basename: string;
	details?: Record<string, unknown>;
}): Promise<ConvertedMcpResult> {
	const collected = await collectBlocks(input.blocks, input.basename);
	const textParts = [...collected.textParts];
	if (input.structuredContent !== undefined) textParts.push(`[MCP structuredContent]\n${safeJson(input.structuredContent)}`);
	if (textParts.length === 0 && collected.images.length === 0) textParts.push("[MCP result contained no content]");

	const fullText = textParts.join("\n");
	const truncation = truncateHead(fullText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	let text = truncation.content;
	const details: Record<string, unknown> = {
		...input.details,
		_meta: input.meta,
		structuredContent: input.structuredContent,
		files: collected.files,
	};

	if (truncation.truncated) {
		const fullOutputPath = await saveTemp(fullText, `${input.basename}-output.txt`);
		details.truncation = truncation;
		details.fullOutputPath = fullOutputPath;
		text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
		text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
		text += ` Full output saved to: ${fullOutputPath}]`;
	}

	const content: PiResultContent[] = [{ type: "text", text }, ...collected.images];
	return { content, details, text };
}

export async function convertMcpToolResult(result: unknown, basename = "tool"): Promise<ConvertedMcpResult & { isError: boolean }> {
	if (!result || typeof result !== "object") {
		const converted = await buildConvertedResult({ blocks: [{ type: "text", text: safeJson(result) }], basename, details: { rawKind: typeof result } });
		return { ...converted, isError: false };
	}
	const record = result as Record<string, unknown>;
	if ("toolResult" in record) {
		const converted = await buildConvertedResult({
			blocks: [{ type: "text", text: safeJson(record.toolResult) }],
			meta: record._meta,
			basename,
			details: { compatibilityResult: true },
		});
		return { ...converted, isError: false };
	}
	const converted = await buildConvertedResult({
		blocks: Array.isArray(record.content) ? record.content : [],
		structuredContent: record.structuredContent,
		meta: record._meta,
		basename,
		details: { isError: record.isError === true },
	});
	return { ...converted, isError: record.isError === true };
}

export async function convertMcpResourceResult(result: unknown, basename = "resource"): Promise<ConvertedMcpResult> {
	if (!result || typeof result !== "object") {
		return buildConvertedResult({ blocks: [{ type: "text", text: safeJson(result) }], basename });
	}
	const record = result as Record<string, unknown>;
	const blocks = Array.isArray(record.contents)
		? record.contents.map((content) => {
				if (!content || typeof content !== "object") return { type: "text", text: safeJson(content) };
				const item = content as Record<string, unknown>;
				if (typeof item.text === "string") return { type: "text", text: item.text };
				if (typeof item.blob === "string") return { type: "resource", resource: item };
				return { type: "text", text: safeJson(item) };
			})
		: [];
	return buildConvertedResult({ blocks, meta: record._meta, basename });
}
