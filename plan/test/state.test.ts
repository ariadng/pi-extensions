import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PLAN_STATE_CUSTOM_TYPE } from "../src/constants.js";
import { forkPlanStateForCurrentSession, needsPlanFileFork, reconstructPlanStateFromBranch } from "../src/state.js";
import type { ActivePlanState, PersistedPlanEntry } from "../src/types.js";

function state(planId: string): ActivePlanState {
	return {
		version: 1,
		mode: "planning",
		planId,
		slug: "plan",
		planFilePath: `/tmp/${planId}.md`,
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

function entry(event: PersistedPlanEntry["event"], current: ActivePlanState | null) {
	return {
		type: "custom",
		customType: PLAN_STATE_CUSTOM_TYPE,
		data: {
			version: 1,
			event,
			timestamp: "2026-01-01T00:00:00.000Z",
			state: current,
		} satisfies PersistedPlanEntry,
	};
}

test("latest branch plan entry wins", () => {
	const restored = reconstructPlanStateFromBranch([entry("entered", state("old")), entry("snapshot", state("new"))]);
	assert.equal(restored?.planId, "new");
});

test("approved and cancelled states reconstruct as normal mode", () => {
	assert.equal(reconstructPlanStateFromBranch([entry("entered", state("old")), entry("approved", null)]), null);
	assert.equal(reconstructPlanStateFromBranch([entry("entered", state("old")), entry("cancelled", null)]), null);
});

test("rejected state keeps plan mode active", () => {
	const restored = reconstructPlanStateFromBranch([entry("entered", state("old")), entry("rejected", state("revised"))]);
	assert.equal(restored?.planId, "revised");
});

test("ignores unrelated custom entries", () => {
	const restored = reconstructPlanStateFromBranch([
		{ type: "custom", customType: "other", data: { mode: "planning" } },
		entry("entered", state("active")),
	]);
	assert.equal(restored?.planId, "active");
});

test("forkPlanStateForCurrentSession creates a different plan file path and copies content", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pi-plan-state-"));
	const oldPath = path.join(dir, "old.md");
	await writeFile(oldPath, "# Parent plan\n", "utf8");
	const parentState = { ...state("parent"), planFilePath: oldPath, sessionId: "parent-session" };
	const ctx = {
		cwd: "/tmp/project",
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionId: () => "fork-session",
		},
	} as unknown as ExtensionContext;

	assert.equal(needsPlanFileFork(ctx, parentState), true);
	const forked = await forkPlanStateForCurrentSession(ctx, parentState, { ask: "AskUserQuestion", todo: "TodoWrite" });
	assert.notEqual(forked.planFilePath, oldPath);
	assert.equal(forked.sessionId, "fork-session");
	assert.equal(await readFile(forked.planFilePath, "utf8"), "# Parent plan\n");
	assert.equal(forked.planSnapshot, "# Parent plan\n");
});
