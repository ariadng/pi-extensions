import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Key } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLAN_COMMAND_NAME } from "./constants.js";
import { checkPlanDependencies } from "./dependency-check.js";
import { ensurePlanFile, readBestPlanContent, snapshotPlanFile, writePlanFile } from "./plan-file.js";
import { createReplacementPlanState, persistPlanEntry } from "./state.js";
import { buildPlanModeActiveTools, enterPlanMode, snapshotCurrentPlanIfNeeded } from "./tools.js";
import type { PlanRuntimeState } from "./types.js";
import { updatePlanWidgets } from "./widgets.js";

const PLAN_SUBCOMMANDS = [
	{ value: "status", label: "status", description: "Show current pi-plan status" },
	{ value: "show", label: "show", description: "Show current plan file content" },
	{ value: "open", label: "open", description: "Edit current plan file in a Pi editor dialog" },
	{ value: "cancel", label: "cancel", description: "Cancel plan mode and restore previous active tools" },
	{ value: "reset", label: "reset", description: "Create a fresh plan file and make it the only writable plan target" },
	{ value: "snapshot", label: "snapshot", description: "Persist the current plan file snapshot" },
] satisfies AutocompleteItem[];

function parseArgs(args: string): { subcommand?: string; rest: string; raw: string } {
	const raw = args.trim();
	if (!raw) return { rest: "", raw };
	const match = raw.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	return {
		subcommand: match?.[1],
		rest: match?.[2]?.trim() ?? "",
		raw,
	};
}

export function getPlanCommandCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const parsed = parseArgs(argumentPrefix);
	if (argumentPrefix.includes(" ")) return null;
	const prefix = parsed.subcommand ?? "";
	return PLAN_SUBCOMMANDS.filter((item) => item.value.startsWith(prefix));
}

function formatDependencyLine(runtime: PlanRuntimeState, pi: Pick<ExtensionAPI, "getAllTools">): string {
	const dependencies = runtime.dependencies ?? checkPlanDependencies(pi);
	if (dependencies.ok && dependencies.tools) {
		return `Dependencies: ok (${dependencies.tools.ask}, ${dependencies.tools.todo})`;
	}
	return `Dependencies: missing (${dependencies.message})`;
}

export function formatPlanStatus(runtime: PlanRuntimeState, pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">): string {
	const lines = [formatDependencyLine(runtime, pi)];
	if (runtime.current) {
		lines.push("Mode: planning");
		lines.push(`Plan file: ${runtime.current.planFilePath}`);
		lines.push(`Plan id: ${runtime.current.planId}`);
		lines.push(`Active tools: ${pi.getActiveTools().join(", ") || "none"}`);
	} else {
		lines.push("Mode: normal");
	}
	return lines.join("\n");
}

async function handlePlanStatus(
	pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">,
	runtime: PlanRuntimeState,
	ctx: ExtensionContext,
): Promise<void> {
	runtime.dependencies = checkPlanDependencies(pi);
	ctx.ui.notify(formatPlanStatus(runtime, pi), runtime.dependencies.ok ? "info" : "warning");
}

async function handlePlanShow(runtime: PlanRuntimeState, ctx: ExtensionContext): Promise<void> {
	if (!runtime.current) {
		ctx.ui.notify("No active plan. Use /plan <description> to enter plan mode.", "warning");
		return;
	}
	await ensurePlanFile(runtime.current);
	const content = await readBestPlanContent(runtime.current);
	ctx.ui.notify(`Plan file: ${runtime.current.planFilePath}\n\n${content}`, "info");
}

async function handlePlanOpen(
	pi: Pick<ExtensionAPI, "appendEntry">,
	runtime: PlanRuntimeState,
	ctx: ExtensionContext,
): Promise<void> {
	if (!runtime.current) {
		ctx.ui.notify("No active plan. Use /plan <description> to enter plan mode.", "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("/plan open requires interactive UI.", "warning");
		return;
	}

	await ensurePlanFile(runtime.current);
	const currentContent = await readBestPlanContent(runtime.current);
	const edited = await ctx.ui.editor(`Edit plan: ${runtime.current.planFilePath}`, currentContent);
	if (edited === undefined) {
		ctx.ui.notify("Plan edit cancelled.", "info");
		return;
	}

	await writePlanFile(runtime.current.planFilePath, edited);
	runtime.current = await snapshotPlanFile(runtime.current);
	persistPlanEntry(pi, "snapshot", runtime.current, "command-open");
	updatePlanWidgets(ctx, runtime);
	ctx.ui.notify(`Plan updated: ${runtime.current.planFilePath}`, "info");
}

async function handlePlanCancel(
	pi: Pick<ExtensionAPI, "setActiveTools" | "appendEntry">,
	runtime: PlanRuntimeState,
	ctx: ExtensionContext,
): Promise<void> {
	if (!runtime.current) {
		ctx.ui.notify("No active plan to cancel.", "info");
		return;
	}

	const state = await snapshotPlanFile(runtime.current);
	persistPlanEntry(pi, "cancelled", state, "command-cancel");
	pi.setActiveTools(state.previousActiveTools);
	runtime.current = null;
	updatePlanWidgets(ctx, runtime);
	ctx.ui.notify("Plan mode cancelled. Previous active tools restored.", "info");
}

async function handlePlanReset(
	pi: Pick<ExtensionAPI, "getAllTools" | "setActiveTools" | "appendEntry">,
	runtime: PlanRuntimeState,
	ctx: ExtensionContext,
	description?: string,
): Promise<void> {
	if (!runtime.current) {
		ctx.ui.notify("No active plan to reset. Use /plan <description> to enter plan mode.", "warning");
		return;
	}

	const dependencies = checkPlanDependencies(pi);
	runtime.dependencies = dependencies;
	if (!dependencies.ok || !dependencies.tools) {
		ctx.ui.notify(dependencies.message, "warning");
		return;
	}

	const oldState = await snapshotPlanFile(runtime.current);
	persistPlanEntry(pi, "snapshot", oldState, "before-reset");
	let nextState = createReplacementPlanState(ctx, oldState, dependencies.tools, "command", description || oldState.description);
	const initialContent = await ensurePlanFile(nextState);
	nextState = {
		...nextState,
		planSnapshot: initialContent,
		updatedAt: new Date().toISOString(),
	};

	runtime.current = nextState;
	persistPlanEntry(pi, "reset", nextState, "command-reset");
	pi.setActiveTools(buildPlanModeActiveTools(pi, dependencies));
	updatePlanWidgets(ctx, runtime);
	ctx.ui.notify(`Plan reset.\nOld plan file: ${oldState.planFilePath}\nNew plan file: ${nextState.planFilePath}`, "info");
}

async function enterFromCommand(
	pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools" | "appendEntry" | "sendUserMessage">,
	runtime: PlanRuntimeState,
	ctx: ExtensionCommandContext,
	description?: string,
): Promise<void> {
	const outcome = await enterPlanMode(pi, ctx, runtime, {
		source: "command",
		description,
	});

	ctx.ui.notify(outcome.message, outcome.ok ? "info" : "warning");
	updatePlanWidgets(ctx, runtime);

	if (outcome.ok && description && outcome.state) {
		pi.sendUserMessage(description);
	}
}

async function enterFromShortcut(
	pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools" | "appendEntry">,
	runtime: PlanRuntimeState,
	ctx: ExtensionContext,
): Promise<void> {
	if (runtime.current) {
		await handlePlanStatus(pi, runtime, ctx);
		return;
	}
	const outcome = await enterPlanMode(pi, ctx, runtime, { source: "shortcut" });
	ctx.ui.notify(outcome.message, outcome.ok ? "info" : "warning");
	updatePlanWidgets(ctx, runtime);
}

export function registerPlanCommand(pi: ExtensionAPI, runtime: PlanRuntimeState): void {
	pi.registerCommand(PLAN_COMMAND_NAME, {
		description: "Enter plan mode or manage the active plan",
		getArgumentCompletions: getPlanCommandCompletions,
		handler: async (args, ctx) => {
			const parsed = parseArgs(args);
			switch (parsed.subcommand) {
				case "status":
					await handlePlanStatus(pi, runtime, ctx);
					return;
				case "show":
					await handlePlanShow(runtime, ctx);
					return;
				case "open":
					await handlePlanOpen(pi, runtime, ctx);
					return;
				case "cancel":
					await handlePlanCancel(pi, runtime, ctx);
					return;
				case "reset":
					await handlePlanReset(pi, runtime, ctx, parsed.rest || undefined);
					return;
				case "snapshot":
					await snapshotCurrentPlanIfNeeded(pi, runtime);
					ctx.ui.notify(runtime.current ? `Snapshot saved for ${runtime.current.planFilePath}` : "No active plan to snapshot.", "info");
					return;
				default:
					await enterFromCommand(pi, runtime, ctx, parsed.raw || undefined);
			}
		},
	});
}

export function registerPlanShortcut(pi: ExtensionAPI, runtime: PlanRuntimeState): void {
	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Enter plan mode or show active plan status",
		handler: async (ctx) => {
			await enterFromShortcut(pi, runtime, ctx);
		},
	});
}
