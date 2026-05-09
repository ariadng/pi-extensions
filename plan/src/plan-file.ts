import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PLAN_FILE_HEADING } from "./constants.js";
import type { ActivePlanState } from "./types.js";

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

export function buildInitialPlanContent(state: Pick<ActivePlanState, "description" | "planFilePath" | "createdAt">): string {
	const description = state.description?.trim();
	const title = description ? `${DEFAULT_PLAN_FILE_HEADING}: ${description}` : DEFAULT_PLAN_FILE_HEADING;
	return `${title}\n\n<!-- Managed by pi-plan. Edit this file while in plan mode. -->\n\n## Goal\n\n${
		description ?? "Describe the goal here."
	}\n\n## Plan\n\n1. Inspect the relevant files and constraints.\n2. Update this plan with the intended implementation steps.\n3. Call ExitPlanMode when the plan is ready for approval.\n\n---\n\nPlan file: ${state.planFilePath}\nCreated: ${state.createdAt}\n`;
}

export async function readPlanFile(planFilePath: string): Promise<string | null> {
	try {
		return await readFile(planFilePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function writePlanFile(planFilePath: string, content: string): Promise<void> {
	await mkdir(path.dirname(planFilePath), { recursive: true });
	await writeFile(planFilePath, content, "utf8");
}

export async function readBestPlanContent(state: Pick<ActivePlanState, "planFilePath" | "planSnapshot">): Promise<string> {
	return (await readPlanFile(state.planFilePath)) ?? state.planSnapshot ?? "";
}

export async function copyPlanFileOrSnapshot(
	fromState: Pick<ActivePlanState, "planFilePath" | "planSnapshot">,
	toPlanFilePath: string,
): Promise<string> {
	await mkdir(path.dirname(toPlanFilePath), { recursive: true });
	try {
		await copyFile(fromState.planFilePath, toPlanFilePath);
		return (await readPlanFile(toPlanFilePath)) ?? fromState.planSnapshot ?? "";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const content = fromState.planSnapshot ?? "";
		await writeFile(toPlanFilePath, content, "utf8");
		return content;
	}
}

export async function ensurePlanFile(state: ActivePlanState): Promise<string> {
	await mkdir(path.dirname(state.planFilePath), { recursive: true });
	const existing = await readPlanFile(state.planFilePath);
	if (existing !== null) return existing;

	const content = state.planSnapshot || buildInitialPlanContent(state);
	await writeFile(state.planFilePath, content, "utf8");
	return content;
}

export async function snapshotPlanFile(state: ActivePlanState): Promise<ActivePlanState> {
	const snapshot = await readPlanFile(state.planFilePath);
	if (snapshot === null) return state;
	return {
		...state,
		planSnapshot: snapshot,
		updatedAt: new Date().toISOString(),
	};
}

export async function recreateMissingPlanFileFromSnapshot(state: ActivePlanState): Promise<boolean> {
	if (await exists(state.planFilePath)) return false;
	if (!state.planSnapshot) return false;
	await writePlanFile(state.planFilePath, state.planSnapshot);
	return true;
}
