import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { getPlanCommandCompletions, registerPlanCommand } from "../src/commands.js";
import { evaluatePlanModeToolCall } from "../src/guards.js";
import type { ActivePlanState, PlanRuntimeState } from "../src/types.js";

function state(planFilePath: string): ActivePlanState {
	return {
		version: 1,
		mode: "planning",
		planId: "plan-id",
		slug: "plan",
		planFilePath,
		projectKey: "project",
		cwd: "/tmp/project",
		sessionId: "session-old",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		previousActiveTools: ["read", "bash", "write"],
		dependencyTools: { ask: "AskUserQuestion", todo: "TodoWrite" },
		planSnapshot: "# Plan\n",
		entryReason: "command",
		description: "Old plan",
	};
}

function commandHarness(runtime: PlanRuntimeState, editorResult?: string) {
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	let activeTools: string[] = [];
	const appended: unknown[] = [];
	const notifications: string[] = [];
	const pi = {
		registerCommand: (_name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			command = options;
		},
		getAllTools: () => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "write" },
			{ name: "edit" },
			{ name: "AskUserQuestion" },
			{ name: "TodoWrite" },
			{ name: "EnterPlanMode" },
			{ name: "ExitPlanMode" },
		],
		getActiveTools: () => activeTools,
		setActiveTools: (tools: string[]) => {
			activeTools = tools;
		},
		appendEntry: (_customType: string, data?: unknown) => {
			appended.push(data);
		},
		sendUserMessage: () => undefined,
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		cwd: "/tmp/project",
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionId: () => "session-new",
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			editor: async () => editorResult,
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
	} as unknown as ExtensionCommandContext;

	registerPlanCommand(pi, runtime);
	assert.ok(command);
	return { command: command!, pi, ctx, get activeTools() { return activeTools; }, appended, notifications };
}

test("plan command completions include subcommands", () => {
	assert.deepEqual(getPlanCommandCompletions("sta")?.map((item) => item.value), ["status"]);
	assert.equal(getPlanCommandCompletions("reset "), null);
});

test("/plan open edits the active plan file and persists a snapshot", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-plan-command-"));
	const planFilePath = path.join(dir, "plan.md");
	await writeFile(planFilePath, "# Old\n", "utf8");
	const runtime: PlanRuntimeState = { current: state(planFilePath), dependencies: null };
	const harness = commandHarness(runtime, "# Edited\n");

	await harness.command.handler("open", harness.ctx);

	assert.equal(await readFile(planFilePath, "utf8"), "# Edited\n");
	assert.equal(runtime.current?.planSnapshot, "# Edited\n");
	assert.ok(harness.appended.some((entry) => (entry as { event?: string })?.event === "snapshot"));
});

test("/plan cancel restores previous active tools and clears plan state", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-plan-command-"));
	const planFilePath = path.join(dir, "plan.md");
	await writeFile(planFilePath, "# Plan\n", "utf8");
	const runtime: PlanRuntimeState = { current: state(planFilePath), dependencies: null };
	const harness = commandHarness(runtime);

	await harness.command.handler("cancel", harness.ctx);

	assert.equal(runtime.current, null);
	assert.deepEqual(harness.activeTools, ["read", "bash", "write"]);
	assert.ok(harness.appended.some((entry) => (entry as { event?: string })?.event === "cancelled"));
});

test("/plan reset creates a new active plan file and old path is no longer writable", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-plan-command-"));
	const oldPlanFilePath = path.join(dir, "old-plan.md");
	await writeFile(oldPlanFilePath, "# Old plan\n", "utf8");
	const runtime: PlanRuntimeState = { current: state(oldPlanFilePath), dependencies: null };
	const harness = commandHarness(runtime);

	await harness.command.handler("reset New approach", harness.ctx);

	assert.ok(runtime.current);
	assert.notEqual(runtime.current.planFilePath, oldPlanFilePath);
	assert.match(await readFile(runtime.current.planFilePath, "utf8"), /# Plan: New approach/);
	assert.ok(harness.appended.some((entry) => (entry as { event?: string })?.event === "reset"));

	const blocked = evaluatePlanModeToolCall(
		{ type: "tool_call", toolCallId: "tool-call", toolName: "write", input: { path: oldPlanFilePath } } as never,
		runtime,
		"/tmp/project",
	);
	assert.equal(blocked?.block, true);
});
