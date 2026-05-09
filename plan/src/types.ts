export type DependencyNamingMode = "pascal" | "snake";

export interface RequiredDependencyNames {
	ask: string;
	todo: string;
}

export interface DependencyStatus {
	ok: boolean;
	mode?: DependencyNamingMode;
	tools?: RequiredDependencyNames;
	missing: string[];
	present: string[];
	allToolNames: string[];
	message: string;
}

export type PlanEntryReason = "command" | "shortcut" | "tool" | "flag" | "restore";
export type PlanStateEvent = "entered" | "snapshot" | "restored" | "reset" | "forked" | "rejected" | "cancelled" | "approved";

export interface ActivePlanState {
	version: 1;
	mode: "planning";
	planId: string;
	slug: string;
	planFilePath: string;
	projectKey: string;
	cwd: string;
	sessionId: string;
	createdAt: string;
	updatedAt: string;
	previousActiveTools: string[];
	dependencyTools: RequiredDependencyNames;
	planSnapshot: string;
	entryReason: PlanEntryReason;
	description?: string;
}

export interface PersistedPlanEntry {
	version: 1;
	event: PlanStateEvent;
	timestamp: string;
	state: ActivePlanState | null;
	reason?: string;
}

export interface PlanRuntimeState {
	current: ActivePlanState | null;
	dependencies: DependencyStatus | null;
}

export interface EnterPlanModeOptions {
	source: PlanEntryReason;
	description?: string;
	askPrompt?: string;
}

export interface EnterPlanModeOutcome {
	ok: boolean;
	message: string;
	state?: ActivePlanState;
	dependencies: DependencyStatus;
	activeTools?: string[];
}

export type ExitPlanModeStatus = "approved" | "rejected" | "cancelled" | "not_planning" | "missing_dependencies" | "no_ui" | "empty_plan";

export interface ExitPlanModeDetails {
	status: ExitPlanModeStatus;
	planFilePath?: string;
	plan?: string;
	feedback?: string;
	activeTools?: string[];
	autoApproved?: boolean;
	dependencies?: DependencyStatus;
	message?: string;
}
