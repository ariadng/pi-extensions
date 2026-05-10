export interface TruncationResult {
	content: string;
	truncated: boolean;
	totalBytes: number;
	outputBytes: number;
	totalLines: number;
	outputLines: number;
}

export function truncateText(value: string, options: { maxBytes?: number; maxLines?: number } = {}): TruncationResult {
	const maxBytes = options.maxBytes ?? 50 * 1024;
	const maxLines = options.maxLines ?? 2000;
	const totalBytes = Buffer.byteLength(value, "utf8");
	const lines = value.split(/\r?\n/);
	let content = lines.slice(0, maxLines).join("\n");
	if (Buffer.byteLength(content, "utf8") > maxBytes) content = truncateBytes(content, maxBytes);
	const outputBytes = Buffer.byteLength(content, "utf8");
	const outputLines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
	return {
		content,
		truncated: outputBytes < totalBytes || outputLines < lines.length,
		totalBytes,
		outputBytes,
		totalLines: lines.length,
		outputLines,
	};
}

function truncateBytes(value: string, maxBytes: number): string {
	let bytes = 0;
	let index = 0;
	for (const char of value) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		index += char.length;
	}
	return value.slice(0, index);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
