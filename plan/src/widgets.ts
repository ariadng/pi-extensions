import path from "node:path";
import { PLAN_STATUS_KEY, PLAN_WIDGET_KEY } from "./constants.js";
import type { ActivePlanState, PlanRuntimeState } from "./types.js";

type WidgetContext = {
	ui: {
		setStatus(key: string, text: string | undefined): void;
		setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	};
};

function planWidgetLines(state: ActivePlanState): string[] {
	return [
		"📋 Plan mode active",
		`File: ${state.planFilePath}`,
		"Allowed: read/search, safe bash, AskUserQuestion, TodoWrite, write/edit plan file",
		"Approval: call ExitPlanMode when ready",
	];
}

export function updatePlanWidgets(ctx: WidgetContext, runtime: PlanRuntimeState): void {
	const state = runtime.current;
	if (!state) {
		ctx.ui.setStatus(PLAN_STATUS_KEY, undefined);
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		return;
	}

	ctx.ui.setStatus(PLAN_STATUS_KEY, `⏸ plan: ${path.basename(state.planFilePath)}`);
	ctx.ui.setWidget(PLAN_WIDGET_KEY, planWidgetLines(state), { placement: "aboveEditor" });
}
