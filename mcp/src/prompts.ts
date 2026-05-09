import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { buildMcpToolName, withStableSuffix } from "./names.js";
import type { McpConnectionManager } from "./manager.js";
import type { McpCachedPrompt, McpManifest, McpPromptMapping } from "./types.js";
import type { McpExtensionRuntime } from "./tools.js";

function requireManager(runtime: McpExtensionRuntime): McpConnectionManager {
	if (!runtime.manager) throw new Error("MCP extension is not initialized yet");
	return runtime.manager;
}

function splitArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (quote) {
			if (char === "\\" && index + 1 < input.length) {
				current += input[++index];
			} else if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

export function parsePromptArgs(input: string, prompt: McpCachedPrompt): Record<string, string> {
	const tokens = splitArgs(input);
	const args: Record<string, string> = {};
	const positional: string[] = [];

	for (const token of tokens) {
		const equals = token.indexOf("=");
		if (equals > 0) {
			args[token.slice(0, equals)] = token.slice(equals + 1);
		} else {
			positional.push(token);
		}
	}

	const declared = (prompt.arguments ?? []).map((argument) => argument.name).filter(Boolean);
	const remainingDeclared = declared.filter((name) => args[name] === undefined);
	if (remainingDeclared.length === 1 && positional.length > 0) {
		args[remainingDeclared[0]] = positional.join(" ");
		return args;
	}

	for (let index = 0; index < positional.length && index < remainingDeclared.length; index++) {
		args[remainingDeclared[index]] = positional[index];
	}
	return args;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function renderContentBlock(content: unknown): string {
	if (!content || typeof content !== "object") return safeJson(content);
	const block = content as Record<string, unknown>;
	switch (block.type) {
		case "text":
			return typeof block.text === "string" ? block.text : safeJson(block);
		case "image": {
			const mime = typeof block.mimeType === "string" ? block.mimeType : "unknown mime";
			const bytes = typeof block.data === "string" ? Math.ceil((block.data.length * 3) / 4) : undefined;
			return `[MCP prompt image: ${mime}${bytes ? `, ~${bytes} bytes` : ""}]`;
		}
		case "audio": {
			const mime = typeof block.mimeType === "string" ? block.mimeType : "unknown mime";
			const bytes = typeof block.data === "string" ? Math.ceil((block.data.length * 3) / 4) : undefined;
			return `[MCP prompt audio: ${mime}${bytes ? `, ~${bytes} bytes` : ""}]`;
		}
		case "resource": {
			const resource = block.resource;
			if (resource && typeof resource === "object") {
				const record = resource as Record<string, unknown>;
				if (typeof record.text === "string") return record.text;
				if (typeof record.blob === "string") return `[MCP prompt resource blob: ${typeof record.uri === "string" ? record.uri : "unknown-uri"}]`;
			}
			return safeJson(block);
		}
		case "resource_link": {
			const name = typeof block.name === "string" ? block.name : "resource";
			const uri = typeof block.uri === "string" ? block.uri : "unknown-uri";
			const description = typeof block.description === "string" ? ` — ${block.description}` : "";
			return `[MCP prompt resource link: ${name} <${uri}>${description}]`;
		}
		default:
			return safeJson(block);
	}
}

function renderMessageContent(content: unknown): string {
	if (Array.isArray(content)) return content.map((block) => renderContentBlock(block)).join("\n");
	return renderContentBlock(content);
}

export function renderPromptResult(result: unknown, mapping: McpPromptMapping, args: Record<string, string>): string {
	const lines = [`# MCP prompt: ${mapping.serverName}/${mapping.originalPromptName}`];
	if (Object.keys(args).length > 0) lines.push("", "Arguments:", ...Object.entries(args).map(([key, value]) => `- ${key}: ${value}`));

	if (!result || typeof result !== "object") {
		lines.push("", safeJson(result));
		return lines.join("\n");
	}

	const record = result as Record<string, unknown>;
	if (typeof record.description === "string" && record.description.trim()) lines.push("", record.description.trim());
	const messages = Array.isArray(record.messages) ? record.messages : [];
	if (messages.length === 0) {
		lines.push("", "[MCP prompt returned no messages]", safeJson(result));
		return lines.join("\n");
	}

	for (const message of messages) {
		if (!message || typeof message !== "object") {
			lines.push("", "## Message", safeJson(message));
			continue;
		}
		const entry = message as Record<string, unknown>;
		const role = typeof entry.role === "string" ? entry.role : "message";
		lines.push("", `## ${role.charAt(0).toUpperCase()}${role.slice(1)}`, renderMessageContent(entry.content));
	}
	return lines.join("\n");
}

function basePromptCommandName(prompt: McpCachedPrompt): string {
	return prompt.piCommandName ?? buildMcpToolName(prompt.serverName, prompt.name);
}

function chooseRegisteredCommandName(runtime: McpExtensionRuntime, prompt: McpCachedPrompt): string {
	const base = basePromptCommandName(prompt);
	const existing = runtime.registry.promptMappings.get(base);
	if (!existing || (existing.serverName === prompt.serverName && existing.originalPromptName === prompt.name)) return base;
	let candidate = withStableSuffix(base, prompt.serverName, prompt.name);
	let counter = 1;
	while (runtime.registry.promptMappings.has(candidate)) candidate = withStableSuffix(base, prompt.serverName, prompt.name, String(counter++));
	return candidate;
}

function promptCompletions(prompt: McpCachedPrompt, prefix: string): AutocompleteItem[] {
	const names = (prompt.arguments ?? []).map((argument) => `${argument.name}=`);
	return names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
}

function findPrompt(manager: McpConnectionManager, mapping: McpPromptMapping): McpCachedPrompt | undefined {
	return manager.getManifest(mapping.serverName)?.prompts.find((prompt) => prompt.name === mapping.originalPromptName);
}

async function runPromptCommand(runtime: McpExtensionRuntime, commandName: string, rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const manager = requireManager(runtime);
	const mapping = runtime.registry.promptMappings.get(commandName);
	if (!mapping) {
		ctx.ui.notify(`MCP prompt command ${commandName} is stale. Run /mcp reconnect or /mcp reload to refresh MCP prompts.`, "warning");
		return;
	}
	const prompt = findPrompt(manager, mapping);
	if (!prompt) {
		ctx.ui.notify(`MCP prompt ${mapping.serverName}/${mapping.originalPromptName} is no longer available.`, "warning");
		return;
	}
	const args = parsePromptArgs(rawArgs, prompt);
	const result = await manager.getPrompt(mapping, args, ctx.signal);
	ctx.ui.setEditorText(renderPromptResult(result, mapping, args));
	ctx.ui.notify(`Inserted MCP prompt ${mapping.serverName}/${mapping.originalPromptName} into the editor for review.`);
}

export function registerManifestPrompts(pi: ExtensionAPI, runtime: McpExtensionRuntime, _manager: McpConnectionManager, serverName: string, manifest: McpManifest): void {
	const newNames = new Set<string>();
	for (const prompt of manifest.prompts) {
		const piCommandName = chooseRegisteredCommandName(runtime, prompt);
		const mapping: McpPromptMapping = { piCommandName, serverName: prompt.serverName, originalPromptName: prompt.name };
		newNames.add(piCommandName);
		runtime.registry.promptMappings.set(piCommandName, mapping);
		runtime.registry.registeredPromptCommands.add(piCommandName);

		const title = prompt.title ?? prompt.name;
		const description = prompt.description ?? `Insert MCP prompt ${prompt.name} from server ${prompt.serverName}`;
		pi.registerCommand(piCommandName, {
			description: `MCP ${title}: ${description}`,
			getArgumentCompletions: (prefix) => promptCompletions(prompt, prefix),
			handler: async (args, ctx) => runPromptCommand(runtime, piCommandName, args, ctx),
		});
	}

	for (const [commandName, mapping] of runtime.registry.promptMappings) {
		if (mapping.serverName === serverName && !newNames.has(commandName)) runtime.registry.promptMappings.delete(commandName);
	}
}

export function registerCachedPromptCommands(pi: ExtensionAPI, runtime: McpExtensionRuntime): void {
	const manager = requireManager(runtime);
	for (const serverName of manager.getServerNames()) {
		const manifest = manager.getManifest(serverName);
		if (manifest) registerManifestPrompts(pi, runtime, manager, serverName, manifest);
	}
}
