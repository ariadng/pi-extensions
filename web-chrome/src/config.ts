import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath, sanitizeFilePart } from "./util/path.js";

export type ProfileMode = "ephemeral" | "project" | "named" | "custom";

export interface ResolvedProfile {
	mode: ProfileMode;
	userDataDir: string;
	cleanup: () => Promise<void>;
	ephemeral: boolean;
}

export interface LaunchProfileInput {
	profileMode?: ProfileMode;
	profileName?: string;
	userDataDir?: string;
	allowDefaultProfile?: boolean;
}

export function envBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

export function defaultWebChromeRoot(): string {
	return join(homedir(), ".pi", "agent", "web-chrome");
}

export function projectProfileHash(cwd: string): string {
	return createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 16);
}

export async function resolveProfile(input: LaunchProfileInput, cwd: string): Promise<ResolvedProfile> {
	const mode = input.profileMode ?? envProfileMode(process.env.PI_WEB_CHROME_PROFILE_MODE) ?? "named";
	const root = defaultWebChromeRoot();

	if (mode === "ephemeral") {
		await mkdir(join(root, "tmp"), { recursive: true });
		const userDataDir = await mkdtemp(join(root, "tmp", "profile-"));
		return {
			mode,
			userDataDir,
			ephemeral: true,
			cleanup: async () => {
				await rm(userDataDir, { recursive: true, force: true });
			},
		};
	}

	if (mode === "project") {
		const userDataDir = join(root, "profiles", `project-${projectProfileHash(cwd)}`);
		await mkdir(userDataDir, { recursive: true });
		return { mode, userDataDir, ephemeral: false, cleanup: async () => undefined };
	}

	if (mode === "named") {
		const profileName = sanitizeFilePart(input.profileName ?? process.env.PI_WEB_CHROME_PROFILE_NAME ?? "default");
		const userDataDir = join(root, "profiles", `named-${profileName}`);
		await mkdir(userDataDir, { recursive: true });
		return { mode, userDataDir, ephemeral: false, cleanup: async () => undefined };
	}

	const rawUserDataDir = input.userDataDir ?? process.env.PI_WEB_CHROME_USER_DATA_DIR;
	if (!rawUserDataDir) {
		throw new Error("profileMode=custom requires userDataDir or PI_WEB_CHROME_USER_DATA_DIR.");
	}
	const userDataDir = resolve(expandHomePath(rawUserDataDir));
	if (looksLikeDefaultChromeProfile(userDataDir) && !input.allowDefaultProfile && envBoolean(process.env.PI_WEB_CHROME_ALLOW_DEFAULT_PROFILE) !== true) {
		throw new Error(
			"Refusing to launch against a default Chrome profile without explicit opt-in. Use named/project/ephemeral profile mode, choose a dedicated custom --user-data-dir, or pass allowDefaultProfile=true / set PI_WEB_CHROME_ALLOW_DEFAULT_PROFILE=1. Note: Chrome 136+ may ignore remote debugging against the default profile even with opt-in.",
		);
	}
	await mkdir(userDataDir, { recursive: true });
	return { mode, userDataDir, ephemeral: false, cleanup: async () => undefined };
}

export function envProfileMode(value: string | undefined): ProfileMode | undefined {
	if (value === "ephemeral" || value === "project" || value === "named" || value === "custom") return value;
	return undefined;
}

export function looksLikeDefaultChromeProfile(userDataDir: string): boolean {
	const normalized = userDataDir.replace(/\\/g, "/").toLowerCase();
	return (
		normalized.endsWith("/library/application support/google/chrome") ||
		normalized.endsWith("/library/application support/chromium") ||
		normalized.endsWith("/.config/google-chrome") ||
		normalized.endsWith("/.config/chromium") ||
		normalized.includes("/appdata/local/google/chrome/user data") ||
		normalized.includes("/appdata/local/chromium/user data")
	);
}
