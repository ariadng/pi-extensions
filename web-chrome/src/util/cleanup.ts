import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { defaultWebChromeRoot } from "../config.js";
import { defaultArtifactBase } from "./artifacts.js";

export type CleanupScope = "all" | "artifacts" | "tmp";

export interface CleanupResult {
	scope: CleanupScope;
	removed: string[];
	skipped: string[];
	missing: string[];
}

export async function cleanupWebChromeStorage(input: { scope?: CleanupScope; activeUserDataDir?: string }): Promise<CleanupResult> {
	const scope = input.scope ?? "all";
	const result: CleanupResult = { scope, removed: [], skipped: [], missing: [] };

	if (scope === "all" || scope === "artifacts") {
		await removePath(defaultArtifactBase(), result);
	}

	if (scope === "all" || scope === "tmp") {
		await cleanupTempProfiles(input.activeUserDataDir, result);
	}

	return result;
}

async function cleanupTempProfiles(activeUserDataDir: string | undefined, result: CleanupResult): Promise<void> {
	const tmpRoot = join(defaultWebChromeRoot(), "tmp");
	const entries = await readdir(tmpRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!entries) {
		result.missing.push(tmpRoot);
		return;
	}

	const active = activeUserDataDir ? resolve(activeUserDataDir) : undefined;
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("profile-")) continue;
		const path = resolve(tmpRoot, entry.name);
		if (active && path === active) {
			result.skipped.push(`${path} (active profile)`);
			continue;
		}
		await removePath(path, result);
	}
}

async function removePath(path: string, result: CleanupResult): Promise<void> {
	const exists = await stat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return false;
		throw error;
	});
	if (!exists) {
		result.missing.push(path);
		return;
	}
	await rm(path, { recursive: true, force: true });
	result.removed.push(path);
}

export function formatCleanupResult(result: CleanupResult): string {
	const lines = [`Cleanup scope: ${result.scope}`];
	lines.push(result.removed.length ? "Removed:" : "Removed: none");
	lines.push(...result.removed.map((path) => `- ${path}`));
	if (result.skipped.length) lines.push("Skipped:", ...result.skipped.map((path) => `- ${path}`));
	if (result.missing.length) lines.push("Missing:", ...result.missing.map((path) => `- ${path}`));
	return lines.join("\n");
}
