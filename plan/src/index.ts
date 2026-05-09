import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerPlanCommand, registerPlanShortcut } from "./commands.js";
import { PLAN_FLAG_NAME } from "./constants.js";
import { checkPlanDependencies } from "./dependency-check.js";
import { registerPlanGuards } from "./guards.js";
import { buildPlanModeContextMessage, buildSparsePlanSystemPrompt, isPlanContextMessage } from "./prompts.js";
import {
	createRuntimeState,
	forkPlanStateForCurrentSession,
	needsPlanFileFork,
	persistPlanEntry,
	restorePlanStateFromBranch,
	snapshotAndPersistCurrentPlan,
} from "./state.js";
import { buildPlanModeActiveTools, enterPlanMode, registerEnterPlanModeTool, registerExitPlanModeTool } from "./tools.js";
import type { PlanRuntimeState } from "./types.js";
import { updatePlanWidgets } from "./widgets.js";

async function restoreRuntimeFromBranch(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: PlanRuntimeState,
	reason: "startup" | "reload" | "new" | "resume" | "fork" | "tree",
): Promise<void> {
	const previousState = runtime.current;
	runtime.dependencies = checkPlanDependencies(pi);
	let restored = await restorePlanStateFromBranch(ctx);

	if (restored && runtime.dependencies.ok && runtime.dependencies.tools) {
		restored = {
			...restored,
			dependencyTools: runtime.dependencies.tools,
		};

		if ((reason === "fork" || needsPlanFileFork(ctx, restored)) && needsPlanFileFork(ctx, restored)) {
			restored = await forkPlanStateForCurrentSession(ctx, restored, runtime.dependencies.tools);
			persistPlanEntry(pi, "forked", restored, `session-start:${reason}`);
		}
	}

	runtime.current = restored;

	if (runtime.current && runtime.dependencies.ok && runtime.dependencies.tools) {
		pi.setActiveTools(buildPlanModeActiveTools(pi, runtime.dependencies));
	} else if (!runtime.current && previousState && reason === "tree") {
		pi.setActiveTools(previousState.previousActiveTools);
	}

	updatePlanWidgets(ctx, runtime);
}

export default function planExtension(pi: ExtensionAPI): void {
	const runtime = createRuntimeState();

	pi.registerFlag(PLAN_FLAG_NAME, {
		description: "Start in pi-plan mode after dependency validation",
		type: "boolean",
		default: false,
	});

	registerEnterPlanModeTool(pi, runtime);
	registerExitPlanModeTool(pi, runtime);
	registerPlanCommand(pi, runtime);
	registerPlanShortcut(pi, runtime);
	registerPlanGuards(pi, runtime);

	pi.on("session_start", async (event, ctx) => {
		await restoreRuntimeFromBranch(pi, ctx, runtime, event.reason);

		if (runtime.current) {
			if (!runtime.dependencies?.ok) {
				ctx.ui.notify(runtime.dependencies?.message ?? "pi-plan dependencies are unavailable.", "warning");
			}
			return;
		}

		if (pi.getFlag(PLAN_FLAG_NAME) === true) {
			const outcome = await enterPlanMode(pi, ctx, runtime, { source: "flag" });
			ctx.ui.notify(outcome.message, outcome.ok ? "info" : "warning");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		await restoreRuntimeFromBranch(pi, ctx, runtime, "tree");
	});

	pi.on("session_shutdown", async () => {
		await snapshotAndPersistCurrentPlan(pi, runtime, "session-shutdown");
	});

	pi.on("context", async (event) => {
		if (runtime.current) return undefined;
		return {
			messages: event.messages.filter((message) => !isPlanContextMessage(message)),
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (!runtime.current) return undefined;
		return {
			message: buildPlanModeContextMessage(runtime.current),
			systemPrompt: event.systemPrompt + buildSparsePlanSystemPrompt(runtime.current),
		};
	});
}

export { buildPlanModeActiveTools, checkPlanDependencies, persistPlanEntry };
