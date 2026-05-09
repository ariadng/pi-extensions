import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { expandEnvInString, hashConfig, loadMcpConfig, stableStringify } from "../src/config.ts";
import { buildMcpToolName, normalizeNameForMCP } from "../src/names.ts";

async function tempProject(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "pi-mcp-config-"));
}

test("name normalization builds fully qualified MCP tool names", () => {
	assert.equal(normalizeNameForMCP("GitHub Issues!"), "GitHub_Issues_");
	assert.equal(buildMcpToolName("github", "create issue"), "mcp__github__create_issue");
});

test("stable config hashing is key-order independent", () => {
	const a = { type: "stdio" as const, command: "node", args: ["a"], env: { B: "2", A: "1" } };
	const b = { env: { A: "1", B: "2" }, args: ["a"], command: "node", type: "stdio" as const };
	assert.equal(stableStringify(a), stableStringify(b));
	assert.equal(hashConfig(a), hashConfig(b));
});

test("env expansion supports defaults and reports missing variables", () => {
	const result = expandEnvInString("${PRESENT}-${MISSING:-fallback}-${ABSENT}", { PRESENT: "ok" });
	assert.equal(result.value, "ok-fallback-");
	assert.deepEqual(result.missing, ["ABSENT"]);
});

test("loads project MCP config without spawning stdio server", async () => {
	const cwd = await tempProject();
	const marker = path.join(cwd, "spawned.txt");
	await writeFile(
		path.join(cwd, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				echo: {
					type: "stdio",
					command: process.execPath,
					args: ["/definitely/not/run.js"],
					env: { PI_MCP_ECHO_MARKER: marker },
				},
			},
		}),
		"utf8",
	);

	const oldPiDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(cwd, "pi-home");
	try {
		const loaded = await loadMcpConfig(cwd);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.servers.get("echo")?.scope, "project");
		assert.equal(existsSync(marker), false);
	} finally {
		if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiDir;
	}
});

test("scope precedence is user < project < local", async () => {
	const cwd = await tempProject();
	const piDir = path.join(cwd, "pi-home");
	const oldPiDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = piDir;
	try {
		await mkdir(piDir, { recursive: true });
		await writeFile(
			path.join(piDir, "mcp.json"),
			JSON.stringify({ mcpServers: { same: { type: "stdio", command: "user" }, userOnly: { type: "stdio", command: "user" } } }),
			"utf8",
		);
		await writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { same: { type: "stdio", command: "project" } } }), "utf8");
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(path.join(cwd, ".pi", "mcp.local.json"), JSON.stringify({ mcpServers: { same: { type: "stdio", command: "local" } } }), "utf8");

		const loaded = await loadMcpConfig(cwd);
		assert.equal((loaded.servers.get("same") as { command?: string } | undefined)?.command, "local");
		assert.equal(loaded.servers.get("userOnly")?.scope, "user");
	} finally {
		if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiDir;
	}
});

test("validates stdio, http, sse, and ws server shapes", async () => {
	const cwd = await tempProject();
	await writeFile(
		path.join(cwd, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				stdio: { command: "node", args: ["server.js"] },
				http: { type: "http", url: "http://localhost:3000/mcp", headers: { Authorization: "Bearer token" } },
				sse: { type: "sse", url: "https://example.com/sse" },
				ws: { type: "ws", url: "ws://localhost:3000/mcp" },
			},
		}),
		"utf8",
	);
	const oldPiDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(cwd, "pi-home");
	try {
		const loaded = await loadMcpConfig(cwd);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.servers.size, 4);
		assert.equal(loaded.servers.get("stdio")?.type, undefined);
		assert.equal(loaded.servers.get("http")?.type, "http");
		assert.equal(loaded.servers.get("sse")?.type, "sse");
		assert.equal(loaded.servers.get("ws")?.type, "ws");
	} finally {
		if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiDir;
	}
});

test("invalid and missing-env configs produce clear diagnostics", async () => {
	const cwd = await tempProject();
	await writeFile(
		path.join(cwd, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				bad: { type: "http", url: "not a url" },
				missingEnv: { type: "stdio", command: "${PI_MCP_TEST_MISSING}" },
			},
		}),
		"utf8",
	);
	const oldPiDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(cwd, "pi-home");
	try {
		const loaded = await loadMcpConfig(cwd);
		assert.ok(loaded.errors.some((error) => error.includes("bad") && error.includes("url")));
		assert.ok(loaded.warnings.some((warning) => warning.includes("PI_MCP_TEST_MISSING")));
	} finally {
		if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiDir;
	}
});
