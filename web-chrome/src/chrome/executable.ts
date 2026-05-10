import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { expandHomePath } from "../util/path.js";

export async function discoverChromeExecutable(explicitPath?: string): Promise<string> {
	const candidates = buildCandidates(explicitPath);
	for (const candidate of candidates) {
		if (await isExecutable(candidate)) return candidate;
	}

	throw new Error(
		[
			"Could not find a Chrome/Chromium executable.",
			"Pass chromePath to chrome_launch or set PI_WEB_CHROME_PATH.",
			"Checked common Google Chrome, Chrome for Testing, Chromium, and PATH locations.",
		].join(" "),
	);
}

function buildCandidates(explicitPath?: string): string[] {
	const candidates: string[] = [];
	if (explicitPath) candidates.push(expandHomePath(explicitPath));
	if (process.env.PI_WEB_CHROME_PATH) candidates.push(expandHomePath(process.env.PI_WEB_CHROME_PATH));

	if (process.platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
			expandHomePath("~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
			expandHomePath("~/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
			expandHomePath("~/Applications/Chromium.app/Contents/MacOS/Chromium"),
		);
	}

	if (process.platform === "linux") {
		candidates.push(
			"/usr/bin/google-chrome-stable",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
		);
	}

	if (process.platform === "win32") {
		const pf = process.env.ProgramFiles;
		const pf86 = process.env["ProgramFiles(x86)"];
		const local = process.env.LOCALAPPDATA;
		for (const root of [pf, pf86, local]) {
			if (!root) continue;
			candidates.push(
				join(root, "Google", "Chrome", "Application", "chrome.exe"),
				join(root, "Google", "Chrome for Testing", "Application", "chrome.exe"),
				join(root, "Chromium", "Application", "chrome.exe"),
			);
		}
	}

	candidates.push(...pathCandidates(["google-chrome-stable", "google-chrome", "chrome", "chromium", "chromium-browser"]));
	return [...new Set(candidates.filter(Boolean))];
}

function pathCandidates(commands: string[]): string[] {
	const path = process.env.PATH ?? "";
	const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	const result: string[] = [];
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		for (const command of commands) {
			for (const extension of extensions) result.push(join(dir, command + extension));
		}
	}
	return result;
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
