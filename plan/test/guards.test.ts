import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { evaluatePlanModeToolCall, shouldSnapshotPlanToolResult } from "../src/guards.js";
import type { ActivePlanState, PlanRuntimeState } from "../src/types.js";

function state(planFilePath = "/tmp/pi-plan/plan.md"): ActivePlanState {
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
		planSnapshot: "# Plan",
		entryReason: "command",
	};
}

function runtime(current: ActivePlanState | null = state()): PlanRuntimeState {
	return { current, dependencies: null };
}

function call(toolName: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolCallId: "tool-call", toolName, input } as ToolCallEvent;
}

function result(toolName: string, input: Record<string, unknown>, isError = false): ToolResultEvent {
	return { type: "tool_result", toolCallId: "tool-call", toolName, input, content: [], isError, details: undefined } as ToolResultEvent;
}

test("does not block tools in normal mode", () => {
	assert.equal(evaluatePlanModeToolCall(call("write", { path: "README.md" }), runtime(null), "/tmp/project"), undefined);
});

test("allows write and edit only for the active plan file", () => {
	const current = state("/tmp/pi-plan/plan.md");
	assert.equal(evaluatePlanModeToolCall(call("write", { path: "/tmp/pi-plan/plan.md" }), runtime(current), "/tmp/project"), undefined);
	assert.equal(evaluatePlanModeToolCall(call("edit", { path: "/tmp/pi-plan/plan.md" }), runtime(current), "/tmp/project"), undefined);

	assert.match(evaluatePlanModeToolCall(call("write", { path: "README.md" }), runtime(current), "/tmp/project")?.reason ?? "", /Allowed plan file/);
	assert.match(evaluatePlanModeToolCall(call("edit", { path: "/tmp/project/src/index.ts" }), runtime(current), "/tmp/project")?.reason ?? "", /Allowed plan file/);
});

test("allows dependency and control tools", () => {
	for (const toolName of ["AskUserQuestion", "TodoWrite", "EnterPlanMode", "ExitPlanMode", "read", "grep", "find", "ls"]) {
		assert.equal(evaluatePlanModeToolCall(call(toolName, {}), runtime(), "/tmp/project"), undefined, toolName);
	}
});

test("blocks unsafe bash and unknown tools in plan mode", () => {
	assert.equal(evaluatePlanModeToolCall(call("bash", { command: "ls -la" }), runtime(), "/tmp/project"), undefined);
	assert.match(evaluatePlanModeToolCall(call("bash", { command: "rm -rf dist" }), runtime(), "/tmp/project")?.reason ?? "", /unsafe bash/);
	assert.match(evaluatePlanModeToolCall(call("web_search", { query: "x" }), runtime(), "/tmp/project")?.reason ?? "", /blocks tool/);
});

test("snapshots only successful plan-file write/edit results", () => {
	const current = state("/tmp/pi-plan/plan.md");
	assert.equal(shouldSnapshotPlanToolResult(result("write", { path: "/tmp/pi-plan/plan.md" }), runtime(current), "/tmp/project"), true);
	assert.equal(shouldSnapshotPlanToolResult(result("edit", { path: "/tmp/pi-plan/plan.md" }, true), runtime(current), "/tmp/project"), false);
	assert.equal(shouldSnapshotPlanToolResult(result("write", { path: "/tmp/project/README.md" }), runtime(current), "/tmp/project"), false);
});
