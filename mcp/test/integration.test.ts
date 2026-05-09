import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerMcpCommand } from "../src/commands.ts";
import { loadMcpConfig } from "../src/config.ts";
import { createMcpManager } from "../src/manager.ts";
import { convertMcpResourceResult, convertMcpToolResult } from "../src/output.ts";
import { registerManifestPrompts } from "../src/prompts.ts";
import { createMcpRuntime, registerCachedProxyTools, registerManifestTools } from "../src/tools.ts";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));

async function tempProject(prefix = "pi-mcp-integration-"): Promise<string> {
	return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeEchoConfig(cwd: string, marker: string, extraEnv: Record<string, string> = {}): Promise<void> {
	await writeFile(
		path.join(cwd, ".mcp.json"),
		JSON.stringify(
			{
				mcpServers: {
					echo: {
						type: "stdio",
						command: process.execPath,
						args: [fixture],
						env: { PI_MCP_ECHO_MARKER: marker, ...extraEnv },
					},
				},
			},
			null,
			2,
		),
		"utf8",
	);
}

async function withStateFile<T>(cwd: string, fn: (stateFile: string) => Promise<T>): Promise<T> {
	const oldState = process.env.PI_MCP_STATE_FILE;
	const oldPiDir = process.env.PI_CODING_AGENT_DIR;
	const stateFile = path.join(cwd, "state.json");
	process.env.PI_MCP_STATE_FILE = stateFile;
	process.env.PI_CODING_AGENT_DIR = path.join(cwd, "pi-home");
	try {
		return await fn(stateFile);
	} finally {
		if (oldState === undefined) delete process.env.PI_MCP_STATE_FILE;
		else process.env.PI_MCP_STATE_FILE = oldState;
		if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiDir;
	}
}

function mockPi() {
	const tools = new Map<string, ToolDefinition<any, any>>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	let activeTools: string[] = [];
	const pi = {
		registerTool(tool: ToolDefinition<any, any>) {
			tools.set(tool.name, tool);
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
		},
		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, options);
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(names: string[]) {
			activeTools = names;
		},
		getAllTools() {
			return [...tools.values()].map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, sourceInfo: {} }));
		},
	} as unknown as ExtensionAPI;
	return { pi, tools, commands, get activeTools() { return activeTools; } };
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		if (condition()) return;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

test("stdio echo server stays dormant until activation and then exposes tools/resources", async () => {
	const cwd = await tempProject();
	const marker = path.join(cwd, "spawned.txt");
	await writeEchoConfig(cwd, marker);

	await withStateFile(cwd, async () => {
		const loaded = await loadMcpConfig(cwd);
		assert.equal(loaded.servers.has("echo"), true);
		assert.equal(existsSync(marker), false, "config loading must not start stdio server");

		const { manager, errors } = await createMcpManager(cwd);
		assert.deepEqual(errors, []);
		assert.equal(manager.getServerState("echo")?.type, "dormant");

		const connected = await manager.activateServer("echo");
		assert.equal(connected.manifest.tools.some((tool) => tool.originalToolName === "echo"), true);
		assert.equal(connected.manifest.resources.some((resource) => resource.uri === "echo://hello"), true);
		assert.equal(existsSync(marker), true, "activation should start stdio server");

		const echoTool = connected.manifest.tools.find((tool) => tool.originalToolName === "echo");
		assert.ok(echoTool);
		const result = await manager.callTool(echoTool, { message: "hello from test" });
		const converted = await convertMcpToolResult(result, "echo");
		assert.match(converted.text, /echo: hello from test/);
		assert.equal(converted.details.structuredContent && typeof converted.details.structuredContent === "object", true);

		const resource = await manager.readResource("echo", "echo://hello");
		const convertedResource = await convertMcpResourceResult(resource, "resource");
		assert.match(convertedResource.text, /hello from echo resource/);

		await manager.closeAll();
	});
});

test("cached proxy tools register without spawning and auto-activate on call", async () => {
	const cwd = await tempProject();
	const marker = path.join(cwd, "spawned.txt");
	await writeEchoConfig(cwd, marker);

	await withStateFile(cwd, async (stateFile) => {
		{
			const harness = mockPi();
			const runtime = createMcpRuntime();
			const { manager } = await createMcpManager(cwd);
			runtime.manager = manager;
			const connected = await manager.activateServer("echo");
			registerManifestTools(harness.pi, runtime, manager, "echo", connected.manifest);
			assert.ok(harness.tools.has("mcp__echo__echo"));
			await manager.closeAll();
		}

		assert.ok(existsSync(stateFile), "manifest cache should be saved");
		await rm(marker, { force: true });
		assert.equal(existsSync(marker), false);

		const harness = mockPi();
		const runtime = createMcpRuntime();
		const { manager } = await createMcpManager(cwd);
		runtime.manager = manager;
		registerCachedProxyTools(harness.pi, runtime);
		assert.ok(harness.tools.has("mcp__echo__echo"), "cached proxy should be registered");
		assert.equal(existsSync(marker), false, "cached proxy registration must not spawn server");

		const tool = harness.tools.get("mcp__echo__echo");
		assert.ok(tool);
		const result = await tool.execute("tool-call", { message: "cached hello" }, undefined, undefined, {} as never);
		const text = result.content.find((content) => content.type === "text")?.text ?? "";
		assert.match(text, /echo: cached hello/);
		assert.equal(existsSync(marker), true, "cached proxy call should auto-activate server");
		await manager.closeAll();
	});
});

test("no-arg /mcp opens an interactive manager for activation, tool details, and disable", async () => {
	const cwd = await tempProject();
	const marker = path.join(cwd, "spawned.txt");
	await writeEchoConfig(cwd, marker);

	await withStateFile(cwd, async () => {
		const harness = mockPi();
		const runtime = createMcpRuntime();
		const { manager } = await createMcpManager(cwd, {
			onManifest: (serverName, manifest) => registerManifestTools(harness.pi, runtime, manager, serverName, manifest),
		});
		try {
			runtime.manager = manager;
			registerMcpCommand(harness.pi, runtime);
			const command = harness.commands.get("mcp");
			assert.ok(command);

			const notifications: string[] = [];
			let serverSelections = 0;
			let serverMenuSelections = 0;
			let toolSelections = 0;
			await command.handler("", {
				signal: new AbortController().signal,
				ui: {
					async select(title: string, options: string[]) {
						if (title === "MCP servers") {
							serverSelections++;
							return serverSelections === 1 ? options.find((option) => option.includes(" echo ")) : "Close";
						}
						if (title.startsWith("MCP server")) {
							serverMenuSelections++;
							if (serverMenuSelections === 1) return "Activate";
							if (serverMenuSelections === 2) return options.find((option) => option.startsWith("View tools"));
							return "Disable";
						}
						if (title === "MCP tools for echo") {
							toolSelections++;
							return toolSelections === 1 ? options.find((option) => option.startsWith("mcp__echo__echo")) : "Back";
						}
						throw new Error(`Unexpected select: ${title}`);
					},
					notify(message: string) {
						notifications.push(message);
					},
				},
			} as never);

			assert.ok(notifications.some((message) => message.includes("Activated echo")));
			assert.ok(notifications.some((message) => message.includes("Original MCP tool: echo")));
			assert.equal(manager.getServerState("echo")?.type, "disabled");
			assert.equal(harness.activeTools.includes("mcp__echo__echo"), false);
		} finally {
			await manager.closeAll();
		}
	});
});

test("MCP prompts register as slash commands and insert rendered prompt text", async () => {
	const cwd = await tempProject();
	const marker = path.join(cwd, "spawned.txt");
	await writeEchoConfig(cwd, marker);

	await withStateFile(cwd, async () => {
		const harness = mockPi();
		const runtime = createMcpRuntime();
		const { manager } = await createMcpManager(cwd);
		try {
			runtime.manager = manager;
			const connected = await manager.activateServer("echo");
			registerManifestPrompts(harness.pi, runtime, manager, "echo", connected.manifest);

			const command = harness.commands.get("mcp__echo__echo_prompt");
			assert.ok(command);
			let editorText = "";
			const notifications: string[] = [];
			await command.handler("message='hello prompt'", {
				ui: {
					setEditorText(text: string) {
						editorText = text;
					},
					notify(message: string) {
						notifications.push(message);
					},
				},
			} as never);

			assert.match(editorText, /# MCP prompt: echo\/echo_prompt/);
			assert.match(editorText, /Please echo: hello prompt/);
			assert.ok(notifications.some((message) => message.includes("Inserted MCP prompt")));
		} finally {
			await manager.closeAll();
		}
	});
});

test("list_changed notifications refresh manifests and deactivate stale tools", async () => {
	const cwd = await tempProject();
	const marker = path.join(cwd, "spawned.txt");
	await writeEchoConfig(cwd, marker, { PI_MCP_DYNAMIC: "1" });

	await withStateFile(cwd, async () => {
		const harness = mockPi();
		const runtime = createMcpRuntime();
		const { manager } = await createMcpManager(cwd, {
			onManifest: (serverName, manifest) => {
				registerManifestTools(harness.pi, runtime, manager, serverName, manifest);
				registerManifestPrompts(harness.pi, runtime, manager, serverName, manifest);
			},
		});
		try {
			runtime.manager = manager;
			await manager.activateServer("echo");
			assert.ok(harness.tools.has("mcp__echo__toggle_dynamic"));
			assert.equal(manager.getManifest("echo")?.tools.some((tool) => tool.originalToolName === "dynamic_echo"), false);

			const toggleTool = harness.tools.get("mcp__echo__toggle_dynamic");
			assert.ok(toggleTool);
			await toggleTool.execute("tool-call", { enabled: true }, undefined, undefined, {} as never);

			await waitFor(() => manager.getManifest("echo")?.tools.some((tool) => tool.originalToolName === "dynamic_echo") === true, "dynamic MCP tool to appear");
			await waitFor(() => manager.getManifest("echo")?.resources.some((resource) => resource.uri === "echo://dynamic") === true, "dynamic MCP resource to appear");
			await waitFor(() => manager.getManifest("echo")?.prompts.some((prompt) => prompt.name === "dynamic_prompt") === true, "dynamic MCP prompt to appear");
			assert.ok(harness.tools.has("mcp__echo__dynamic_echo"));
			assert.ok(harness.activeTools.includes("mcp__echo__dynamic_echo"));
			assert.ok(harness.commands.has("mcp__echo__dynamic_prompt"));

			const dynamicTool = harness.tools.get("mcp__echo__dynamic_echo");
			assert.ok(dynamicTool);
			const dynamicResult = await dynamicTool.execute("tool-call", { message: "hello dynamic" }, undefined, undefined, {} as never);
			const dynamicText = dynamicResult.content.find((content) => content.type === "text")?.text ?? "";
			assert.match(dynamicText, /dynamic echo: hello dynamic/);

			await toggleTool.execute("tool-call", { enabled: false }, undefined, undefined, {} as never);
			await waitFor(() => manager.getManifest("echo")?.tools.some((tool) => tool.originalToolName === "dynamic_echo") === false, "dynamic MCP tool to disappear");
			await waitFor(() => manager.getManifest("echo")?.resources.some((resource) => resource.uri === "echo://dynamic") === false, "dynamic MCP resource to disappear");
			await waitFor(() => manager.getManifest("echo")?.prompts.some((prompt) => prompt.name === "dynamic_prompt") === false, "dynamic MCP prompt to disappear");
			assert.equal(harness.activeTools.includes("mcp__echo__dynamic_echo"), false);
			assert.equal(runtime.registry.toolMappings.has("mcp__echo__dynamic_echo"), false);
		} finally {
			await manager.closeAll();
		}
	});
});

test("disabled servers cannot be activated until enabled", async () => {
	const cwd = await tempProject();
	const marker = path.join(cwd, "spawned.txt");
	await writeEchoConfig(cwd, marker);

	await withStateFile(cwd, async () => {
		const { manager } = await createMcpManager(cwd);
		await manager.disableServer("echo");
		await assert.rejects(() => manager.activateServer("echo"), /disabled/);
		assert.equal(existsSync(marker), false);
		await manager.enableServer("echo");
		await manager.activateServer("echo");
		assert.equal(existsSync(marker), true);
		await manager.closeAll();
	});
});
