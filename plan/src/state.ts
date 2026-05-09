import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLAN_STATE_CUSTOM_TYPE, PLAN_STATE_VERSION } from "./constants.js";
import { checkPlanDependencies } from "./dependency-check.js";
import { copyPlanFileOrSnapshot, ensurePlanFile, recreateMissingPlanFileFromSnapshot, snapshotPlanFile } from "./plan-file.js";
import { createPlanPath } from "./paths.js";
import type {
	ActivePlanState,
	DependencyStatus,
	EnterPlanModeOptions,
	PersistedPlanEntry,
	PlanRuntimeState,
	PlanEntryReason,
	PlanStateEvent,
	RequiredDependencyNames,
} from "./types.js";

type MaybeCustomEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
};

export function createRuntimeState(): PlanRuntimeState {
	return {
		current: null,
		dependencies: null,
	};
}

export function clonePlanState(state: ActivePlanState): ActivePlanState {
	return {
		...state,
		previousActiveTools: [...state.previousActiveTools],
		dependencyTools: { ...state.dependencyTools },
	};
}

function createPlanStateForCurrentSession(input: {
	ctx: ExtensionContext;
	previousActiveTools: string[];
	dependencyTools: RequiredDependencyNames;
	entryReason: PlanEntryReason;
	description?: string;
	planSnapshot?: string;
}): ActivePlanState {
	const cwd = input.ctx.cwd || input.ctx.sessionManager.getCwd();
	const sessionId = input.ctx.sessionManager.getSessionId();
	const createdAt = new Date().toISOString();
	const planPath = createPlanPath({ cwd, sessionId, description: input.description });

	return {
		version: PLAN_STATE_VERSION,
		mode: "planning",
		planId: planPath.planId,
		slug: planPath.slug,
		planFilePath: planPath.planFilePath,
		projectKey: planPath.projectKey,
		cwd,
		sessionId,
		createdAt,
		updatedAt: createdAt,
		previousActiveTools: [...input.previousActiveTools],
		dependencyTools: { ...input.dependencyTools },
		planSnapshot: input.planSnapshot ?? "",
		entryReason: input.entryReason,
		description: input.description,
	};
}

export function createActivePlanState(
	ctx: ExtensionContext,
	previousActiveTools: string[],
	dependencies: DependencyStatus,
	options: EnterPlanModeOptions,
): ActivePlanState {
	if (!dependencies.ok || !dependencies.tools) {
		throw new Error(dependencies.message);
	}

	return createPlanStateForCurrentSession({
		ctx,
		previousActiveTools,
		dependencyTools: dependencies.tools,
		entryReason: options.source,
		description: options.description,
	});
}

export function createReplacementPlanState(
	ctx: ExtensionContext,
	previousState: ActivePlanState,
	dependencyTools: RequiredDependencyNames,
	entryReason: PlanEntryReason,
	description = previousState.description,
	planSnapshot = "",
): ActivePlanState {
	return createPlanStateForCurrentSession({
		ctx,
		previousActiveTools: previousState.previousActiveTools,
		dependencyTools,
		entryReason,
		description,
		planSnapshot,
	});
}

export function persistPlanEntry(
	pi: Pick<ExtensionAPI, "appendEntry">,
	event: PlanStateEvent,
	state: ActivePlanState | null,
	reason?: string,
): void {
	const entry: PersistedPlanEntry = {
		version: PLAN_STATE_VERSION,
		event,
		timestamp: new Date().toISOString(),
		state: state ? clonePlanState(state) : null,
		reason,
	};
	pi.appendEntry(PLAN_STATE_CUSTOM_TYPE, entry);
}

function isPersistedPlanEntry(value: unknown): value is PersistedPlanEntry {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PersistedPlanEntry>;
	return candidate.version === PLAN_STATE_VERSION && typeof candidate.event === "string" && "state" in candidate;
}

export function reconstructPlanStateFromBranch(entries: Iterable<unknown>): ActivePlanState | null {
	let latest: PersistedPlanEntry | null = null;
	for (const entry of entries) {
		const custom = entry as MaybeCustomEntry;
		if (custom.type !== "custom" || custom.customType !== PLAN_STATE_CUSTOM_TYPE) continue;
		if (!isPersistedPlanEntry(custom.data)) continue;
		latest = custom.data;
	}

	if (!latest) return null;
	if (latest.event === "cancelled" || latest.event === "approved") return null;
	if (latest.state?.mode !== "planning") return null;
	return clonePlanState(latest.state);
}

export async function restorePlanStateFromBranch(ctx: ExtensionContext): Promise<ActivePlanState | null> {
	const branchEntries = ctx.sessionManager.getBranch();
	const restored = reconstructPlanStateFromBranch(branchEntries);
	if (!restored) return null;
	await recreateMissingPlanFileFromSnapshot(restored);
	await ensurePlanFile(restored);
	return restored;
}

export function needsPlanFileFork(ctx: ExtensionContext, state: ActivePlanState): boolean {
	return state.sessionId !== ctx.sessionManager.getSessionId();
}

export async function forkPlanStateForCurrentSession(
	ctx: ExtensionContext,
	state: ActivePlanState,
	dependencyTools: RequiredDependencyNames,
): Promise<ActivePlanState> {
	const forked = createReplacementPlanState(ctx, state, dependencyTools, "restore", state.description, state.planSnapshot);
	const copiedContent = await copyPlanFileOrSnapshot(state, forked.planFilePath);
	return {
		...forked,
		planSnapshot: copiedContent,
		updatedAt: new Date().toISOString(),
	};
}

export async function snapshotAndPersistCurrentPlan(
	pi: Pick<ExtensionAPI, "appendEntry">,
	runtime: PlanRuntimeState,
	reason = "snapshot",
): Promise<void> {
	if (!runtime.current) return;
	runtime.current = await snapshotPlanFile(runtime.current);
	persistPlanEntry(pi, "snapshot", runtime.current, reason);
}

export function refreshDependencyStatus(pi: Pick<ExtensionAPI, "getAllTools">, runtime: PlanRuntimeState): DependencyStatus {
	const dependencies = checkPlanDependencies(pi);
	runtime.dependencies = dependencies;
	return dependencies;
}
