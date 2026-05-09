import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function hashText(input: string, length = 12): string {
	return createHash("sha256").update(input).digest("hex").slice(0, length);
}

export function safeSegment(input: string | undefined, fallback: string, maxLength = 64): string {
	const cleaned = (input ?? "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, maxLength)
		.replace(/^-+|-+$/g, "");
	return cleaned || fallback;
}

export function resolveCwdForKey(cwd: string): string {
	try {
		return existsSync(cwd) ? realpathSync.native(cwd) : path.resolve(cwd);
	} catch {
		return path.resolve(cwd);
	}
}

export function createProjectKey(cwd: string): string {
	const resolved = resolveCwdForKey(cwd);
	const name = safeSegment(path.basename(resolved), "project", 40);
	return `${name}-${hashText(resolved, 12)}`;
}

export function createPlanSlug(description?: string): string {
	return safeSegment(description, "plan", 48);
}

export function createPlanId(now = new Date()): string {
	const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z");
	return `${timestamp}-${randomBytes(4).toString("hex")}`;
}

export function defaultAgentDir(): string {
	return path.join(homedir(), ".pi", "agent");
}

export function getPlansRoot(env: NodeJS.ProcessEnv = process.env, agentDir = defaultAgentDir()): string {
	return path.resolve(env.PI_PLAN_DIR?.trim() || path.join(agentDir, "plans"));
}

export interface PlanPathInput {
	cwd: string;
	sessionId: string;
	description?: string;
	planId?: string;
	plansRoot?: string;
}

export interface CreatedPlanPath {
	planId: string;
	slug: string;
	projectKey: string;
	planFilePath: string;
}

export function createPlanPath(input: PlanPathInput): CreatedPlanPath {
	const projectKey = createProjectKey(input.cwd);
	const sessionSegment = safeSegment(input.sessionId, "session", 48);
	const slug = createPlanSlug(input.description);
	const planId = input.planId ?? createPlanId();
	const planIdSegment = safeSegment(planId, "plan-id", 80);
	const root = input.plansRoot ?? getPlansRoot();
	const filename = `${sessionSegment}-${planIdSegment}-${slug}.md`;
	return {
		planId,
		slug,
		projectKey,
		planFilePath: path.join(root, projectKey, filename),
	};
}

export function expandHomePath(inputPath: string): string {
	if (inputPath === "~") return homedir();
	if (inputPath.startsWith(`~${path.sep}`)) return path.join(homedir(), inputPath.slice(2));
	return inputPath;
}

export function normalizeToolPath(inputPath: string, cwd: string): string {
	const expanded = expandHomePath(inputPath.trim());
	const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
	return path.normalize(absolute);
}

export function isExactPlanFilePath(targetPath: string, planFilePath: string, cwd: string): boolean {
	return normalizeToolPath(targetPath, cwd) === normalizeToolPath(planFilePath, cwd);
}
