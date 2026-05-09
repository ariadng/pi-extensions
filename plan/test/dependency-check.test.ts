import assert from "node:assert/strict";
import test from "node:test";
import { detectPlanDependencies } from "../src/dependency-check.js";

test("detects required PascalCase dependencies", () => {
	const status = detectPlanDependencies(["read", "AskUserQuestion", "TodoWrite"]);
	assert.equal(status.ok, true);
	assert.equal(status.mode, "pascal");
	assert.deepEqual(status.tools, { ask: "AskUserQuestion", todo: "TodoWrite" });
});

test("fails closed when AskUserQuestion is missing", () => {
	const status = detectPlanDependencies(["read", "TodoWrite"]);
	assert.equal(status.ok, false);
	assert.ok(status.missing.includes("AskUserQuestion"));
	assert.match(status.message, /pi-ask and pi-todo|Missing: `AskUserQuestion`/);
});

test("fails closed when TodoWrite is missing", () => {
	const status = detectPlanDependencies(["read", "AskUserQuestion"]);
	assert.equal(status.ok, false);
	assert.ok(status.missing.includes("TodoWrite"));
	assert.match(status.message, /TodoWrite/);
});

test("accepts snake-case only when both dependencies use snake-case", () => {
	const status = detectPlanDependencies(["ask_user_question", "todo_write"]);
	assert.equal(status.ok, true);
	assert.equal(status.mode, "snake");
});

test("rejects mixed naming modes", () => {
	const status = detectPlanDependencies(["AskUserQuestion", "todo_write"]);
	assert.equal(status.ok, false);
	assert.match(status.message, /same tool naming mode/);
});
