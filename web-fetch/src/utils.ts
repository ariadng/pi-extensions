export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`;
}

export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function stripSingleLeadingWww(hostname: string): string {
	return hostname.toLowerCase().replace(/^www\./u, "");
}

export function normalizeHostnameForPolicy(hostname: string): string {
	let host = hostname.trim().toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	while (host.endsWith(".")) host = host.slice(0, -1);
	return host;
}
