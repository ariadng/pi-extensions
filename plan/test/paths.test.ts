import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createPlanPath, createPlanSlug, createProjectKey, safeSegment } from "../src/paths.js";

test("safeSegment creates filesystem-safe names", () => {
	assert.equal(safeSegment("Add OAuth Login!", "plan"), "add-oauth-login");
	assert.equal(safeSegment("", "fallback"), "fallback");
});

test("createProjectKey includes a readable slug and hash", () => {
	const key = createProjectKey("/tmp/My Project");
	assert.match(key, /^my-project-[a-f0-9]{12}$/);
});

test("createPlanSlug falls back to plan", () => {
	assert.equal(createPlanSlug(), "plan");
});

test("createPlanPath is stable for a supplied plan id", () => {
	const first = createPlanPath({
		cwd: "/tmp/example",
		sessionId: "session:1",
		description: "Do the work",
		planId: "plan-123",
		plansRoot: "/plans",
	});
	const second = createPlanPath({
		cwd: "/tmp/example",
		sessionId: "session:1",
		description: "Do the work",
		planId: "plan-123",
		plansRoot: "/plans",
	});

	assert.deepEqual(first, second);
	assert.equal(path.dirname(first.planFilePath), path.join("/plans", first.projectKey));
	assert.match(path.basename(first.planFilePath), /^session-1-plan-123-do-the-work\.md$/);
});
