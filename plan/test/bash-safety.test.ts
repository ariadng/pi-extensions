import assert from "node:assert/strict";
import test from "node:test";
import { checkBashSafety, isSafeBashCommand } from "../src/bash-safety.js";

test("allows read-only shell commands", () => {
	assert.equal(isSafeBashCommand("ls -la"), true);
	assert.equal(isSafeBashCommand("rg -n TODO src | head -20"), true);
	assert.equal(isSafeBashCommand("git status && git diff -- src/index.ts"), true);
});

test("blocks mutating shell commands", () => {
	for (const command of ["npm install lodash", "rm -rf dist", "echo test > out.txt", "git checkout -b test"]) {
		const result = checkBashSafety(command);
		assert.equal(result.safe, false, command);
		assert.ok(result.reason, command);
	}
});

test("blocks commands outside the read-only allowlist", () => {
	const result = checkBashSafety("python3 scripts/generate.py");
	assert.equal(result.safe, false);
	assert.match(result.reason ?? "", /not allowlisted/);
});

test("checks every newline-separated command segment", () => {
	const result = checkBashSafety("ls\npython3 scripts/generate.py");
	assert.equal(result.safe, false);
	assert.match(result.reason ?? "", /not allowlisted/);
});
