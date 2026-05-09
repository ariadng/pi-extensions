import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { BASE_PLAN_MODE_TOOLS, ENTER_PLAN_MODE_TOOL, EXIT_PLAN_MODE_TOOL } from "./constants.js";
import { checkPlanDependencies } from "./dependency-check.js";
import { ensurePlanFile, readPlanFile, snapshotPlanFile, writePlanFile } from "./plan-file.js";
import { createActivePlanState, persistPlanEntry } from "./state.js";
import type {
	DependencyStatus,
	EnterPlanModeOptions,
	EnterPlanModeOutcome,
	ExitPlanModeDetails,
	PlanRuntimeState,
	RequiredDependencyNames,
} from "./types.js";
import { askEmptyPlanConfirmation, isPlanContentEmpty, requestPlanApproval } from "./ui.js";
import { updatePlanWidgets } from "./widgets.js";

const EnterPlanModeParams = Type.Object({
	description: Type.Optional(Type.String({ description: "Optional short description of the task to plan." })),
});

type EnterPlanModeParams = Static<typeof EnterPlanModeParams>;

const ExitPlanModeParams = Type.Object({
	allowedPrompts: Type.Optional(
		Type.Array(
			Type.Object({
				tool: Type.String(),
				prompt: Type.String(),
			}),
		),
	),
	plan: Type.Optional(Type.String({ description: "Optional plan content. Prefer writing the plan file directly." })),
});

type ExitPlanModeParams = Static<typeof ExitPlanModeParams>;

function textResult<TDetails = Record<string, unknown>>(text: string, details: TDetails): AgentToolResult<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function unique(items: Iterable<string>): string[] {
	return Array.from(new Set(items));
}

export function mergeRequiredWorkflowTools(
	previousActiveTools: readonly string[],
	dependencies: RequiredDependencyNames,
	allToolNames?: Iterable<string>,
): string[] {
	const merged = unique([...previousActiveTools, dependencies.ask, dependencies.todo]);
	if (!allToolNames) return merged;
	const all = new Set(allToolNames);
	return merged.filter((name) => all.has(name));
}

export function buildPlanModeActiveTools(pi: Pick<ExtensionAPI, "getAllTools">, dependencies: DependencyStatus): string[] {
	if (!dependencies.ok || !dependencies.tools) return [];
	const allTools = new Set(pi.getAllTools().map((tool) => tool.name));
	return unique([...BASE_PLAN_MODE_TOOLS, dependencies.tools.ask, dependencies.tools.todo]).filter((name) => allTools.has(name));
}

export async function enterPlanMode(
	pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools" | "appendEntry">,
	ctx: ExtensionContext,
	runtime: PlanRuntimeState,
	options: EnterPlanModeOptions,
): Promise<EnterPlanModeOutcome> {
	const dependencies = checkPlanDependencies(pi);
	runtime.dependencies = dependencies;

	if (!dependencies.ok || !dependencies.tools) {
		return {
			ok: false,
			message: dependencies.message,
			dependencies,
		};
	}

	if (runtime.current) {
		return {
			ok: true,
			message: `Plan mode is already active. Plan file: ${runtime.current.planFilePath}`,
			state: runtime.current,
			dependencies,
			activeTools: buildPlanModeActiveTools(pi, dependencies),
		};
	}

	const previousActiveTools = pi.getActiveTools();
	let state = createActivePlanState(ctx, previousActiveTools, dependencies, options);
	const initialContent = await ensurePlanFile(state);
	state = {
		...state,
		planSnapshot: initialContent,
		updatedAt: new Date().toISOString(),
	};

	runtime.current = state;
	persistPlanEntry(pi, "entered", state, options.source);

	const activeTools = buildPlanModeActiveTools(pi, dependencies);
	pi.setActiveTools(activeTools);
	updatePlanWidgets(ctx, runtime);

	return {
		ok: true,
		message: [
			"Plan mode is active.",
			`Plan file: ${state.planFilePath}`,
			"Explore read-only, use AskUserQuestion for needed clarification, use TodoWrite for non-trivial planning progress, and write the plan to the plan file.",
			"Call ExitPlanMode when ready for approval.",
		].join("\n"),
		state,
		dependencies,
		activeTools,
	};
}

export async function snapshotCurrentPlanIfNeeded(
	pi: Pick<ExtensionAPI, "appendEntry">,
	runtime: PlanRuntimeState,
): Promise<void> {
	if (!runtime.current) return;
	runtime.current = await snapshotPlanFile(runtime.current);
	persistPlanEntry(pi, "snapshot", runtime.current, "snapshot-current-plan");
}

function approvedPlanContent(planFilePath: string, plan: string, autoApproved = false): string {
	return [
		autoApproved
			? "Plan auto-approved after the approval timer elapsed with no user input. You can now start coding."
			: "User has approved your plan. You can now start coding.",
		"If the implementation has multiple steps, first call TodoWrite to convert the approved plan into execution todos.",
		"",
		`Your plan has been saved to: ${planFilePath}`,
		"",
		"## Approved Plan:",
		plan,
	].join("\n");
}

function rejectedPlanContent(feedback: string): string {
	return [
		"User rejected the plan and wants to keep planning.",
		"",
		"Feedback:",
		feedback,
		"",
		"Revise the plan file, then call ExitPlanMode again.",
	].join("\n");
}

async function readCurrentPlanContent(state: PlanRuntimeState["current"]): Promise<string> {
	if (!state) return "";
	await ensurePlanFile(state);
	return (await readPlanFile(state.planFilePath)) ?? state.planSnapshot;
}

export async function exitPlanMode(
	pi: Pick<ExtensionAPI, "getAllTools" | "setActiveTools" | "appendEntry">,
	ctx: ExtensionContext,
	runtime: PlanRuntimeState,
	params: ExitPlanModeParams = {},
): Promise<AgentToolResult<ExitPlanModeDetails>> {
	if (!runtime.current) {
		return textResult("Plan mode is not active. Continue normally.", {
			status: "not_planning",
			message: "Plan mode is not active.",
		});
	}

	const dependencies = checkPlanDependencies(pi);
	runtime.dependencies = dependencies;
	if (!dependencies.ok || !dependencies.tools) {
		return textResult(dependencies.message, {
			status: "missing_dependencies",
			planFilePath: runtime.current.planFilePath,
			dependencies,
			message: dependencies.message,
		});
	}

	let state = {
		...runtime.current,
		dependencyTools: dependencies.tools,
	};
	runtime.current = state;

	if (typeof params.plan === "string") {
		await writePlanFile(state.planFilePath, params.plan);
		state = {
			...state,
			planSnapshot: params.plan,
			updatedAt: new Date().toISOString(),
		};
		runtime.current = state;
		persistPlanEntry(pi, "snapshot", state, "exit-plan-mode-input");
	}

	let plan = await readCurrentPlanContent(state);
	state = await snapshotPlanFile(state);
	runtime.current = state;

	if (!ctx.hasUI) {
		return textResult("Plan approval requires interactive or RPC UI. Plan mode remains active and no implementation tools were restored.", {
			status: "no_ui",
			planFilePath: state.planFilePath,
			plan,
			dependencies,
			message: "Interactive/RPC UI is unavailable.",
		});
	}

	let emptyPlanApproved = false;
	if (isPlanContentEmpty(plan)) {
		const approveEmpty = await askEmptyPlanConfirmation(ctx);
		if (approveEmpty.status === "unavailable") {
			return textResult(`${approveEmpty.message} Plan mode remains active and no implementation tools were restored.`, {
				status: "no_ui",
				planFilePath: state.planFilePath,
				plan,
				dependencies,
				message: approveEmpty.message,
			});
		}
		if (approveEmpty.status === "declined") {
			return textResult("The plan file is empty. Write the plan file, then call ExitPlanMode again.", {
				status: "empty_plan",
				planFilePath: state.planFilePath,
				plan,
				dependencies,
				message: "Empty plan was not approved.",
			});
		}
		emptyPlanApproved = true;
	}

	const decision = await requestPlanApproval(ctx, state, plan);
	if (decision.plan !== plan) {
		await writePlanFile(state.planFilePath, decision.plan);
		plan = decision.plan;
		state = await snapshotPlanFile(state);
		runtime.current = state;
		persistPlanEntry(pi, "snapshot", state, "approval-edit");
	}

	if (decision.action === "unavailable") {
		return textResult(`${decision.message} Plan mode remains active and no implementation tools were restored.`, {
			status: "no_ui",
			planFilePath: state.planFilePath,
			plan,
			dependencies,
			message: decision.message,
		});
	}

	if (decision.action === "approve" && isPlanContentEmpty(plan) && !emptyPlanApproved) {
		const approveEmpty = await askEmptyPlanConfirmation(ctx);
		if (approveEmpty.status === "unavailable") {
			return textResult(`${approveEmpty.message} Plan mode remains active and no implementation tools were restored.`, {
				status: "no_ui",
				planFilePath: state.planFilePath,
				plan,
				dependencies,
				message: approveEmpty.message,
			});
		}
		if (approveEmpty.status === "declined") {
			return textResult("The plan file is empty. Write the plan file, then call ExitPlanMode again.", {
				status: "empty_plan",
				planFilePath: state.planFilePath,
				plan,
				dependencies,
				message: "Empty plan was not approved.",
			});
		}
	}

	if (decision.action === "cancel") {
		return textResult(decision.message ?? "Plan approval was cancelled. Plan mode remains active.", {
			status: "cancelled",
			planFilePath: state.planFilePath,
			plan,
			dependencies,
			message: decision.message ?? "Plan approval was cancelled.",
		});
	}

	if (decision.action === "reject") {
		state = await snapshotPlanFile(state);
		runtime.current = state;
		persistPlanEntry(pi, "rejected", state, decision.feedback);
		updatePlanWidgets(ctx, runtime);
		return textResult(rejectedPlanContent(decision.feedback), {
			status: "rejected",
			planFilePath: state.planFilePath,
			plan,
			feedback: decision.feedback,
			dependencies,
			message: "Plan rejected; planning continues.",
		});
	}

	state = await snapshotPlanFile(state);
	const activeTools = mergeRequiredWorkflowTools(
		state.previousActiveTools,
		dependencies.tools,
		pi.getAllTools().map((tool) => tool.name),
	);
	pi.setActiveTools(activeTools);
	persistPlanEntry(pi, "approved", state, "approved");
	runtime.current = null;
	updatePlanWidgets(ctx, runtime);
	const approvalMessage = decision.autoApproved
		? "Plan auto-approved after 60 seconds with no user input; implementation can start."
		: "Plan approved; implementation can start.";
	ctx.ui.notify(
		`${decision.autoApproved ? "Plan auto-approved" : "Plan approved"}. Implementation tools restored.\n${state.planFilePath}`,
		"info",
	);

	return textResult(approvedPlanContent(state.planFilePath, state.planSnapshot || plan, decision.autoApproved), {
		status: "approved",
		planFilePath: state.planFilePath,
		plan: state.planSnapshot || plan,
		activeTools,
		dependencies,
		autoApproved: decision.autoApproved,
		message: approvalMessage,
	});
}

export function registerEnterPlanModeTool(pi: ExtensionAPI, runtime: PlanRuntimeState): void {
	pi.registerTool({
		name: ENTER_PLAN_MODE_TOOL,
		label: "Enter Plan Mode",
		description: "Request permission to enter read-only planning mode before implementation.",
		promptSnippet: "Enter plan mode for non-trivial implementation tasks that should be approved before coding.",
		promptGuidelines: [
			"Use EnterPlanMode for non-trivial implementation tasks when the approach should be approved before coding.",
			"Do not use EnterPlanMode for simple read-only questions or tiny edits.",
		],
		parameters: EnterPlanModeParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: EnterPlanModeParams, _signal, _onUpdate, ctx) {
			const dependencies = checkPlanDependencies(pi);
			runtime.dependencies = dependencies;
			if (!dependencies.ok) {
				return textResult(dependencies.message, { dependencies });
			}

			if (runtime.current) {
				return textResult(`Plan mode is already active. Plan file: ${runtime.current.planFilePath}`, {
					planFilePath: runtime.current.planFilePath,
					dependencies,
				});
			}

			if (!ctx.hasUI) {
				return textResult(
					"Plan mode requires user confirmation when requested by the model. Use /plan or --plan to enter plan mode without this confirmation.",
					{ dependencies },
				);
			}

			const choice = await ctx.ui.select("Enter plan mode?", [
				"Yes, enter plan mode",
				"No, start implementing now",
			]);

			if (choice !== "Yes, enter plan mode") {
				return textResult("The user declined plan mode. Continue without changing tools.", { dependencies });
			}

			const outcome = await enterPlanMode(pi, ctx, runtime, {
				source: "tool",
				description: params.description,
			});
			return textResult(outcome.message, {
				ok: outcome.ok,
				planFilePath: outcome.state?.planFilePath,
				activeTools: outcome.activeTools,
				dependencies: outcome.dependencies,
			});
		},
	});
}

export function registerExitPlanModeTool(pi: ExtensionAPI, runtime: PlanRuntimeState): void {
	pi.registerTool({
		name: EXIT_PLAN_MODE_TOOL,
		label: "Exit Plan Mode",
		description: "Present the current plan file for user approval before implementation.",
		promptSnippet: "Use ExitPlanMode after writing the plan file to ask the user for approval before coding.",
		promptGuidelines: [
			"Use ExitPlanMode only after the plan file has been written with a concrete implementation plan.",
			"Do not ask for final plan approval with AskUserQuestion; ExitPlanMode owns approval.",
		],
		parameters: ExitPlanModeParams,
		executionMode: "sequential",
		async execute(_toolCallId, params: ExitPlanModeParams, _signal, _onUpdate, ctx) {
			return exitPlanMode(pi, ctx, runtime, params);
		},
	});
}
