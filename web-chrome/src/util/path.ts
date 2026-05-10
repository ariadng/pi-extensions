import { homedir } from "node:os";
import { resolve } from "node:path";

export function expandHomePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homedir(), value.slice(2));
	return value;
}

export function sanitizeFilePart(value: string): string {
	return value
		.trim()
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80) || "default";
}
