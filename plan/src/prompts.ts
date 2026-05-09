import { PLAN_CONTEXT_CUSTOM_TYPE } from "./constants.js";
import type { ActivePlanState } from "./types.js";

export function buildPlanModeInstructions(state: ActivePlanState): string {
	return `[PI PLAN MODE ACTIVE]\nYou are in plan mode. This is read-only except plan file and session bookkeeping.\n\nPlan file: ${state.planFilePath}\n\nAllowed planning work:\n- Inspect the repository with read/search tools and safe read-only bash commands.\n- Write and edit only the plan file above. Do not modify project source files before approval.\n- Use AskUserQuestion for concrete clarification or preference decisions that cannot be answered from the code.\n- Use TodoWrite for non-trivial planning progress tracking.\n\nPlan requirements:\n1. Keep the plan in the dedicated plan file.\n2. Capture goal, relevant findings, implementation steps, tests, risks, and open questions.\n3. If you need user input, call AskUserQuestion; do not ask final approval with AskUserQuestion.\n4. When the plan is ready, call ExitPlanMode for approval.\n5. After approval, convert multi-step implementation work into TodoWrite items before editing code.\n`;
}

export function buildSparsePlanSystemPrompt(state: ActivePlanState): string {
	return `\n\n[pi-plan]\nPlan mode is active: read-only except plan file. Plan file: ${state.planFilePath}. Use AskUserQuestion for necessary clarification and TodoWrite for non-trivial progress tracking. Do not edit project code until ExitPlanMode approval.`;
}

export function buildPlanModeContextMessage(state: ActivePlanState) {
	return {
		customType: PLAN_CONTEXT_CUSTOM_TYPE,
		content: buildPlanModeInstructions(state),
		display: false,
		details: {
			planId: state.planId,
			planFilePath: state.planFilePath,
		},
	};
}

export function isPlanContextMessage(message: unknown): boolean {
	const candidate = message as { customType?: unknown; content?: unknown };
	if (candidate.customType === PLAN_CONTEXT_CUSTOM_TYPE) return true;
	if (typeof candidate.content === "string" && candidate.content.includes("[PI PLAN MODE ACTIVE]")) return true;
	return false;
}
