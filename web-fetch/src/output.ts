import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteLength, formatBytes } from "./utils.js";

export const DEFAULT_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_OUTPUT_MAX_LINES = 2000;

export type TruncationResult = {
	content: string;
	truncated: boolean;
	totalBytes: number;
	outputBytes: number;
	totalLines: number;
	outputLines: number;
};

export function truncateHead(
	text: string,
	options: { maxBytes?: number; maxLines?: number } = {},
): TruncationResult {
	const maxBytes = options.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_OUTPUT_MAX_LINES;
	const lines = text.split(/\r?\n/u);
	const totalLines = lines.length;
	const totalBytes = byteLength(text);
	let outputLines = Math.min(totalLines, maxLines);
	let content = lines.slice(0, outputLines).join("\n");
	let outputBytes = byteLength(content);

	while (outputBytes > maxBytes && content.length > 0) {
		const ratio = Math.max(0.1, maxBytes / outputBytes);
		content = content.slice(0, Math.max(0, Math.floor(content.length * ratio) - 1));
		content = Buffer.from(content, "utf8").toString("utf8");
		outputBytes = byteLength(content);
		outputLines = content.length === 0 ? 0 : content.split(/\r?\n/u).length;
	}

	return {
		content,
		truncated: totalLines > outputLines || totalBytes > outputBytes,
		totalBytes,
		outputBytes,
		totalLines,
		outputLines,
	};
}

export async function writeTempTextFile(prefix: string, filename: string, content: string): Promise<string> {
	const path = await makeTempPath(prefix, filename || "content.txt");
	await writeFile(path, content, "utf8");
	return path;
}

export async function writeTempBytesFile(prefix: string, filename: string, content: Uint8Array): Promise<string> {
	const path = await makeTempPath(prefix, filename || "content.bin");
	await writeFile(path, content);
	return path;
}

async function makeTempPath(prefix: string, filename: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	const safeName = filename.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "content.txt";
	return join(dir, safeName);
}

export function formatTruncationNotice(truncation: TruncationResult, fullPath?: string): string {
	const omittedLines = Math.max(0, truncation.totalLines - truncation.outputLines);
	const omittedBytes = Math.max(0, truncation.totalBytes - truncation.outputBytes);
	let notice = `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatBytes(truncation.outputBytes)} of ${formatBytes(truncation.totalBytes)}). ${omittedLines} lines (${formatBytes(omittedBytes)}) omitted.`;
	if (fullPath) notice += ` Full content saved to: ${fullPath}.`;
	return `${notice}]`;
}
