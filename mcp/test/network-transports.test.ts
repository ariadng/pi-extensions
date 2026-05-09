import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createMcpManager } from "../src/manager.ts";
import { convertMcpResourceResult, convertMcpToolResult } from "../src/output.ts";
import { createMcpRuntime, registerAuthTool, registerManifestTools } from "../src/tools.ts";

const fixture = fileURLToPath(new URL("./fixtures/network-server.mjs", import.meta.url));

type NetworkFixture = {
	child: ChildProcess;
	port: number;
	httpUrl: string;
	sseUrl: string;
	wsUrl: string;
	statsUrl: string;
	stop(): Promise<void>;
};

async function tempProject(prefix = "pi-mcp-network-"): Promise<string> {
	return mkdtemp(path.join(tmpdir(), prefix));
}

async function withStateFile<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
	const oldState = process.env.PI_MCP_STATE_FILE;
	const oldPiDir = process.env.PI_CODING_AGENT_DIR;
	const oldOpenBrowser = process.env.PI_MCP_OPEN_BROWSER;
	process.env.PI_MCP_STATE_FILE = path.join(cwd, "state.json");
	process.env.PI_CODING_AGENT_DIR = path.join(cwd, "pi-home");
	process.env.PI_MCP_OPEN_BROWSER = "0";
	try {
		return await fn();
	} finally {
		if (oldState === undefined) delete process.env.PI_MCP_STATE_FILE;
		else process.env.PI_MCP_STATE_FILE = oldState;
		if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiDir;
		if (oldOpenBrowser === undefined) delete process.env.PI_MCP_OPEN_BROWSER;
		else process.env.PI_MCP_OPEN_BROWSER = oldOpenBrowser;
	}
}

async function writeConfig(cwd: string, server: Record<string, unknown>): Promise<void> {
	await writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { network: server } }, null, 2), "utf8");
}

async function startNetworkServer(env: Record<string, string> = {}): Promise<NetworkFixture> {
	const child = spawn(process.execPath, [fixture], {
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const info = await new Promise<Omit<NetworkFixture, "child" | "stop">>((resolve, reject) => {
		let settled = false;
		let stdout = "";
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGTERM");
			reject(new Error(`Timed out starting network fixture. stderr:\n${stderr}`));
		}, 10_000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			if (settled) return;
			stdout += chunk;
			const newline = stdout.indexOf("\n");
			if (newline === -1) return;
			settled = true;
			clearTimeout(timeout);
			try {
				resolve(JSON.parse(stdout.slice(0, newline)) as Omit<NetworkFixture, "child" | "stop">);
			} catch (error) {
				reject(error);
			}
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(new Error(`Network fixture exited before startup: code=${code} signal=${signal}\n${stderr}`));
		});
	});

	return {
		child,
		...info,
		async stop() {
			if (child.exitCode !== null) return;
			await new Promise<void>((resolve) => {
				child.once("exit", () => resolve());
				child.kill("SIGTERM");
				setTimeout(resolve, 1500).unref();
			});
		},
	};
}

async function readStats(server: NetworkFixture): Promise<{ mcpRequests: number; headerFailures: number; authFailures: number; oauthAuthorize: number; oauthToken: number }> {
	const response = await fetch(server.statsUrl);
	assert.equal(response.ok, true);
	return (await response.json()) as { mcpRequests: number; headerFailures: number; authFailures: number; oauthAuthorize: number; oauthToken: number };
}

function mockPi() {
	const tools = new Map<string, ToolDefinition<any, any>>();
	let activeTools: string[] = [];
	const pi = {
		registerTool(tool: ToolDefinition<any, any>) {
			tools.set(tool.name, tool);
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(names: string[]) {
			activeTools = names;
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, get activeTools() { return activeTools; } };
}

async function waitForConnected(manager: Awaited<ReturnType<typeof createMcpManager>>["manager"], serverName: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		if (manager.getServerState(serverName)?.type === "connected") return;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${serverName} to connect; state=${manager.getServerState(serverName)?.type}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function assertNetworkServerWorks(cwd: string, serverConfig: Record<string, unknown>, expectedText: string): Promise<void> {
	await writeConfig(cwd, serverConfig);
	await withStateFile(cwd, async () => {
		const { manager, errors } = await createMcpManager(cwd);
		assert.deepEqual(errors, []);
		assert.equal(manager.getServerState("network")?.type, "dormant");

		const connected = await manager.activateServer("network");
		assert.ok(connected.manifest.tools.some((tool) => tool.originalToolName === "echo"));
		assert.ok(connected.manifest.resources.some((resource) => resource.uri === "network://hello"));
		assert.ok(connected.manifest.prompts.some((prompt) => prompt.name === "echo_prompt"));

		const echoTool = connected.manifest.tools.find((tool) => tool.originalToolName === "echo");
		assert.ok(echoTool);
		const toolResult = await manager.callTool(echoTool, { message: expectedText });
		const convertedTool = await convertMcpToolResult(toolResult, "network");
		assert.match(convertedTool.text, new RegExp(`network echo: ${expectedText}`));

		const resourceResult = await manager.readResource("network", "network://hello");
		const convertedResource = await convertMcpResourceResult(resourceResult, "resource");
		assert.match(convertedResource.text, /hello from network resource/);

		const reconnected = await manager.reconnectServer("network");
		assert.equal(reconnected.type, "connected");
		await manager.closeAll();
	});
}

test("streamable HTTP transport is lazy and supports tools/resources/prompts/reconnect/static headers", async () => {
	const cwd = await tempProject();
	const server = await startNetworkServer({ PI_MCP_EXPECT_HEADER: "x-pi-mcp-test:ok" });
	try {
		await writeConfig(cwd, { type: "http", url: server.httpUrl, headers: { "x-pi-mcp-test": "ok" } });
		await withStateFile(cwd, async () => {
			const { manager } = await createMcpManager(cwd);
			assert.equal((await readStats(server)).mcpRequests, 0, "manager creation must not connect to network MCP servers");
			const connected = await manager.activateServer("network");
			assert.ok(connected.manifest.tools.some((tool) => tool.originalToolName === "echo"));
			assert.equal((await readStats(server)).headerFailures, 0);
			await manager.closeAll();
		});

		await assertNetworkServerWorks(cwd, { type: "http", url: server.httpUrl, headers: { "x-pi-mcp-test": "ok" } }, "hello-http");
	} finally {
		await server.stop();
	}
});

for (const transport of ["sse", "ws"] as const) {
	test(`${transport} transport supports activation, tool execution, resources, prompts, and reconnect`, async () => {
		const cwd = await tempProject();
		const server = await startNetworkServer();
		try {
			const url = transport === "sse" ? server.sseUrl : server.wsUrl;
			await assertNetworkServerWorks(cwd, { type: transport, url }, `hello-${transport}`);
			assert.ok((await readStats(server)).mcpRequests > 0);
		} finally {
			await server.stop();
		}
	});
}

test("headersHelper can supply network headers", async () => {
	const cwd = await tempProject();
	const server = await startNetworkServer({ PI_MCP_EXPECT_HEADER: "x-pi-mcp-test:ok" });
	try {
		const helper = path.join(cwd, "headers-helper.mjs");
		await writeFile(helper, "console.log(JSON.stringify({'x-pi-mcp-test':'ok'}));\n", "utf8");
		await assertNetworkServerWorks(cwd, { type: "http", url: server.httpUrl, headersHelper: `${process.execPath} ${helper}` }, "hello-helper");
		assert.equal((await readStats(server)).headerFailures, 0);
	} finally {
		await server.stop();
	}
});

test("headersHelper failures are actionable", async () => {
	const cwd = await tempProject();
	const server = await startNetworkServer();
	try {
		await writeConfig(cwd, { type: "http", url: server.httpUrl, headersHelper: `${process.execPath} -e "process.exit(2)"` });
		await withStateFile(cwd, async () => {
			const { manager } = await createMcpManager(cwd);
			await assert.rejects(() => manager.activateServer("network"), /headersHelper failed/);
		});
	} finally {
		await server.stop();
	}
});

test("OAuth flow exposes auth pseudo-tool, stores tokens, reconnects, reuses, and clears auth", async () => {
	const cwd = await tempProject();
	const server = await startNetworkServer({ PI_MCP_REQUIRE_AUTH: "1", PI_MCP_OAUTH: "1", PI_MCP_AUTH_TOKEN: "secret" });
	try {
		await writeConfig(cwd, { type: "http", url: server.httpUrl, oauth: { scope: "mcp" } });
		await withStateFile(cwd, async () => {
			const harness = mockPi();
			const runtime = createMcpRuntime();
			const { manager } = await createMcpManager(cwd, {
				onManifest: (serverName, manifest) => registerManifestTools(harness.pi, runtime, manager, serverName, manifest),
				onAuthRequired: (serverName) => registerAuthTool(harness.pi, runtime, manager, serverName),
			});
			runtime.manager = manager;

			await assert.rejects(() => manager.activateServer("network"), /requires authentication/);
			assert.equal(manager.getServerState("network")?.type, "needs-auth");
			assert.ok(harness.tools.has("mcp__network__authenticate"));

			const authTool = harness.tools.get("mcp__network__authenticate");
			assert.ok(authTool);
			const authResult = await authTool.execute("tool-call", {}, undefined, undefined, {} as never);
			const authText = authResult.content.find((content) => content.type === "text")?.text ?? "";
			const authUrl = authResult.details && typeof authResult.details === "object" && "authUrl" in authResult.details ? String(authResult.details.authUrl) : undefined;
			assert.ok(authUrl);
			assert.match(authText, /Open this URL/);

			const browserResponse = await fetch(authUrl);
			assert.equal(browserResponse.ok, true);
			await waitForConnected(manager, "network");
			assert.ok(harness.tools.has("mcp__network__echo"));

			const statsAfterAuth = await readStats(server);
			assert.equal(statsAfterAuth.oauthAuthorize, 1);
			assert.equal(statsAfterAuth.oauthToken, 1);

			await manager.closeAll();
			const { manager: secondManager } = await createMcpManager(cwd);
			const connected = await secondManager.activateServer("network");
			assert.equal(connected.type, "connected");
			assert.equal((await readStats(server)).oauthAuthorize, 1, "stored tokens should avoid starting OAuth again");

			await secondManager.clearAuth("network");
			await assert.rejects(() => secondManager.activateServer("network", { refresh: true }), /requires authentication/);
			assert.equal(secondManager.getServerState("network")?.type, "needs-auth");
			await secondManager.closeAll();
		});
	} finally {
		await server.stop();
	}
});

test("auth-required network responses produce an actionable diagnostic", async () => {
	const cwd = await tempProject();
	const server = await startNetworkServer({ PI_MCP_REQUIRE_AUTH: "1", PI_MCP_AUTH_TOKEN: "secret" });
	try {
		await writeConfig(cwd, { type: "http", url: server.httpUrl });
		await withStateFile(cwd, async () => {
			const { manager } = await createMcpManager(cwd);
			await assert.rejects(() => manager.activateServer("network"), /requires authentication/);
			assert.ok((await readStats(server)).authFailures > 0);
		});
	} finally {
		await server.stop();
	}
});
