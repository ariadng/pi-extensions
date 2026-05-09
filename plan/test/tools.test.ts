import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exitPlanMode, mergeRequiredWorkflowTools } from "../src/tools.js";
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
		sessionId: "session",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		previousActiveTools: ["read", "bash"],
		dependencyTools: { ask: "AskUserQuestion", todo: "TodoWrite" },
		planSnapshot: "# Plan\n",
		entryReason: "command",
	};
}

test("mergeRequiredWorkflowTools preserves previous tools and adds required workflow tools", () => {
	assert.deepEqual(
		mergeRequiredWorkflowTools(["read", "bash", "AskUserQuestion"], { ask: "AskUserQuestion", todo: "TodoWrite" }),
		["read", "bash", "AskUserQuestion", "TodoWrite"],
	);
});

test("ExitPlanMode approval restores implementation tools and clears planning state", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-plan-test-"));
	const planFilePath = path.join(dir, "plan.md");
	const plan = "# Plan\n\n1. Do the thing.\n";
	await writeFile(planFilePath, plan, "utf8");

	const runtime: PlanRuntimeState = { current: state(planFilePath), dependencies: null };
	const appended: unknown[] = [];
	let activeTools: string[] = [];
	const pi = {
		getAllTools: () => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "AskUserQuestion" },
			{ name: "TodoWrite" },
			{ name: "EnterPlanMode" },
			{ name: "ExitPlanMode" },
		],
		setActiveTools: (tools: string[]) => {
			activeTools = tools;
		},
		appendEntry: (_customType: string, data?: unknown) => {
			appended.push(data);
		},
	} as Pick<ExtensionAPI, "getAllTools" | "setActiveTools" | "appendEntry">;

	const ctx = {
		hasUI: true,
		cwd: "/tmp/project",
		ui: {
			notify: () => undefined,
			select: async () => "Approve and start implementation",
			confirm: async () => true,
			editor: async (_title: string, prefill?: string) => prefill,
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
	} as unknown as ExtensionContext;

	const result = await exitPlanMode(pi, ctx, runtime);
	assert.equal(result.details.status, "approved");
	assert.equal(runtime.current, null);
	assert.deepEqual(activeTools, ["read", "bash", "AskUserQuestion", "TodoWrite"]);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /first call TodoWrite/);
	assert.ok(appended.some((entry) => (entry as { event?: string })?.event === "approved"));
});

test("ExitPlanMode rejection keeps planning state active", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-plan-test-"));
	const planFilePath = path.join(dir, "plan.md");
	await writeFile(planFilePath, "# Plan\n", "utf8");

	const runtime: PlanRuntimeState = { current: state(planFilePath), dependencies: null };
	const pi = {
		getAllTools: () => [{ name: "AskUserQuestion" }, { name: "TodoWrite" }],
		setActiveTools: () => undefined,
		appendEntry: () => undefined,
	} as unknown as Pick<ExtensionAPI, "getAllTools" | "setActiveTools" | "appendEntry">;
	const ctx = {
		hasUI: true,
		cwd: "/tmp/project",
		ui: {
			notify: () => undefined,
			select: async () => "Reject and keep planning",
			confirm: async () => true,
			editor: async () => "Please add tests.",
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
	} as unknown as ExtensionContext;

	const result = await exitPlanMode(pi, ctx, runtime);
	assert.equal(result.details.status, "rejected");
	assert.notEqual(runtime.current, null);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Please add tests/);
});

test("ExitPlanMode returns no_ui without hanging when UI is unavailable", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-plan-test-"));
	const planFilePath = path.join(dir, "plan.md");
	await writeFile(planFilePath, "# Plan\n", "utf8");

	const runtime: PlanRuntimeState = { current: state(planFilePath), dependencies: null };
	const pi = {
		getAllTools: () => [{ name: "AskUserQuestion" }, { name: "TodoWrite" }],
		setActiveTools: () => {
			throw new Error("should not restore tools without approval");
		},
		appendEntry: () => undefined,
	} as unknown as Pick<ExtensionAPI, "getAllTools" | "setActiveTools" | "appendEntry">;
	const ctx = {
		hasUI: false,
		cwd: "/tmp/project",
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
	} as unknown as ExtensionContext;

	const result = await exitPlanMode(pi, ctx, runtime);
	assert.equal(result.details.status, "no_ui");
	assert.notEqual(runtime.current, null);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /requires interactive or RPC UI/);
});

test("ExitPlanMode converts dialog failures into no_ui result", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-plan-test-"));
	const planFilePath = path.join(dir, "plan.md");
	await writeFile(planFilePath, "# Plan\n", "utf8");

	const runtime: PlanRuntimeState = { current: state(planFilePath), dependencies: null };
	const pi = {
		getAllTools: () => [{ name: "AskUserQuestion" }, { name: "TodoWrite" }],
		setActiveTools: () => undefined,
		appendEntry: () => undefined,
	} as unknown as Pick<ExtensionAPI, "getAllTools" | "setActiveTools" | "appendEntry">;
	const ctx = {
		hasUI: true,
		cwd: "/tmp/project",
		ui: {
			notify: () => undefined,
			select: async () => {
				throw new Error("client disconnected");
			},
			confirm: async () => true,
			editor: async () => "unused",
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
	} as unknown as ExtensionContext;

	const result = await exitPlanMode(pi, ctx, runtime);
	assert.equal(result.details.status, "no_ui");
	assert.notEqual(runtime.current, null);
	assert.match(result.details.message ?? "", /client disconnected/);
});
