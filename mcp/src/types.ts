import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

export type ConfigScope = "user" | "project" | "local" | "dynamic";
export type McpTransport = "stdio" | "http" | "sse" | "ws";

export interface McpStdioServerConfig {
	type?: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface McpOAuthConfig {
	scope?: string;
	clientId?: string;
	clientSecret?: string;
	clientMetadataUrl?: string;
	clientMetadata?: Record<string, unknown>;
}

export interface McpHTTPServerConfig {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	headersHelper?: string;
	oauth?: McpOAuthConfig;
}

export interface McpSSEServerConfig {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
	headersHelper?: string;
	oauth?: McpOAuthConfig;
}

export interface McpWSServerConfig {
	type: "ws";
	url: string;
	headers?: Record<string, string>;
	headersHelper?: string;
	oauth?: McpOAuthConfig;
}

export type McpServerConfig = McpStdioServerConfig | McpHTTPServerConfig | McpSSEServerConfig | McpWSServerConfig;

export type ScopedMcpServerConfig = McpServerConfig & {
	scope: ConfigScope;
	configPath?: string;
	configHash: string;
};

export interface ScopedServerEntry {
	name: string;
	config: ScopedMcpServerConfig;
}

export interface LoadedMcpConfig {
	servers: Map<string, ScopedMcpServerConfig>;
	byScope: Record<ConfigScope, ScopedServerEntry[]>;
	warnings: string[];
	errors: string[];
	paths: Partial<Record<ConfigScope, string>>;
}

export interface McpCachedTool {
	piToolName: string;
	serverName: string;
	originalToolName: string;
	title?: string;
	description?: string;
	inputSchema: unknown;
	annotations?: Record<string, unknown>;
}

export interface McpCachedResource {
	serverName: string;
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
}

export interface McpCachedPrompt {
	piCommandName?: string;
	serverName: string;
	name: string;
	title?: string;
	description?: string;
	arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpManifest {
	configHash: string;
	discoveredAt: string;
	capabilities: ServerCapabilities;
	tools: McpCachedTool[];
	resources: McpCachedResource[];
	prompts: McpCachedPrompt[];
}

export type McpServerState =
	| { type: "dormant"; name: string; config: ScopedMcpServerConfig; manifest?: McpManifest }
	| { type: "activating"; name: string; config: ScopedMcpServerConfig; manifest?: McpManifest }
	| {
			type: "connected";
			name: string;
			config: ScopedMcpServerConfig;
			client: Client;
			capabilities: ServerCapabilities;
			manifest: McpManifest;
			activatedAt: string;
			cleanup(): Promise<void>;
		}
	| { type: "needs-auth"; name: string; config: ScopedMcpServerConfig; error: string; authUrl?: string; manifest?: McpManifest }
	| { type: "failed"; name: string; config: ScopedMcpServerConfig; error: string; manifest?: McpManifest }
	| { type: "disabled"; name: string; config: ScopedMcpServerConfig; manifest?: McpManifest };

export interface McpProjectState {
	disabledServers: string[];
	manifestCache: Record<string, McpManifest>;
}

export interface McpStateFile {
	version: 1;
	projects: Record<string, McpProjectState>;
	global: McpProjectState;
}

export interface McpToolMapping {
	piToolName: string;
	serverName: string;
	originalToolName: string;
}

export interface McpPromptMapping {
	piCommandName: string;
	serverName: string;
	originalPromptName: string;
}

export interface RuntimeToolRegistry {
	registeredProxyTools: Set<string>;
	toolMappings: Map<string, McpToolMapping>;
	registeredPromptCommands: Set<string>;
	promptMappings: Map<string, McpPromptMapping>;
	registeredAuthTools: Set<string>;
}

export interface ServerSummary {
	name: string;
	scope: ConfigScope;
	transport: McpTransport;
	status: McpServerState["type"];
	configPath?: string;
	toolCount: number;
	resourceCount: number;
	promptCount: number;
	error?: string;
}
