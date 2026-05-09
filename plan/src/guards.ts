import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { ENTER_PLAN_MODE_TOOL, EXIT_PLAN_MODE_TOOL } from "./constants.js";
import { checkBashSafety } from "./bash-safety.js";
import { isExactPlanFilePath, normalizeToolPath } from "./paths.js";
import { snapshotAndPersistCurrentPlan } from "./state.js";
import type { ActivePlanState, PlanRuntimeState } from "./types.js";

const READ_ONLY_BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface GuardDecision {
	block: boolean;
	reason: string;
}

function getToolTargetPath(input: Record<string, unknown>): string | undefined {
	const value = input.path;
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function isPlanDependencyTool(toolName: string, state: ActivePlanState): boolean {
	return toolName === state.dependencyTools.ask || toolName === state.dependencyTools.todo;
}

export function isPlanControlTool(toolName: string): boolean {
	return toolName === ENTER_PLAN_MODE_TOOL || toolName === EXIT_PLAN_MODE_TOOL;
}

export function isPlanWriteToolCall(event: Pick<ToolCallEvent, "toolName" | "input">): boolean {
	return event.toolName === "write" || event.toolName === "edit";
}

export function isToolTargetingPlanFile(
	event: Pick<ToolCallEvent, "input"> | Pick<ToolResultEvent, "input">,
	state: ActivePlanState,
	cwd: string,
): boolean {
	const targetPath = getToolTargetPath(event.input);
	if (!targetPath) return false;
	return isExactPlanFilePath(targetPath, state.planFilePath, cwd);
}

export function evaluatePlanModeToolCall(event: ToolCallEvent, runtime: PlanRuntimeState, cwd: string): GuardDecision | undefined {
	const state = runtime.current;
	if (!state) return undefined;

	if (READ_ONLY_BUILTIN_TOOLS.has(event.toolName)) return undefined;
	if (isPlanControlTool(event.toolName)) return undefined;
	if (isPlanDependencyTool(event.toolName, state)) return undefined;

	if (event.toolName === "bash") {
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const safety = checkBashSafety(command);
		if (safety.safe) return undefined;
		return {
			block: true,
			reason: `Plan mode blocks unsafe bash before approval: ${safety.reason ?? "not read-only"}. Command: ${command}`,
		};
	}

	if (isPlanWriteToolCall(event)) {
		const targetPath = getToolTargetPath(event.input);
		if (!targetPath) {
			return {
				block: true,
				reason: `Plan mode blocks ${event.toolName}: missing target path. Only the active plan file may be modified: ${state.planFilePath}`,
			};
		}

		if (isExactPlanFilePath(targetPath, state.planFilePath, cwd)) return undefined;

		return {
			block: true,
			reason: [
				`Plan mode blocks ${event.toolName} before approval.`,
				`Target: ${normalizeToolPath(targetPath, cwd)}`,
				`Allowed plan file: ${normalizeToolPath(state.planFilePath, cwd)}`,
				"Write or edit the plan file only, then call ExitPlanMode for approval.",
			].join("\n"),
		};
	}

	return {
		block: true,
		reason: `Plan mode blocks tool '${event.toolName}' before approval. Allowed tools are read/search, safe bash, AskUserQuestion, TodoWrite, EnterPlanMode, ExitPlanMode, and write/edit to the active plan file: ${state.planFilePath}`,
	};
}

export function shouldSnapshotPlanToolResult(event: ToolResultEvent, runtime: PlanRuntimeState, cwd: string): boolean {
	const state = runtime.current;
	if (!state || event.isError) return false;
	if (event.toolName !== "write" && event.toolName !== "edit") return false;
	return isToolTargetingPlanFile(event, state, cwd);
}

export function registerPlanGuards(pi: ExtensionAPI, runtime: PlanRuntimeState): void {
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const decision = evaluatePlanModeToolCall(event, runtime, ctx.cwd);
		if (!decision?.block) return undefined;
		return { block: true, reason: decision.reason };
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!shouldSnapshotPlanToolResult(event, runtime, ctx.cwd)) return undefined;
		await snapshotAndPersistCurrentPlan(pi, runtime, `tool-result:${event.toolName}`);
		return undefined;
	});
}
