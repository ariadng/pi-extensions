#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocketServer } from "ws";
import { z } from "zod";

const requireAuth = process.env.PI_MCP_REQUIRE_AUTH === "1";
const oauthEnabled = process.env.PI_MCP_OAUTH === "1";
const authToken = process.env.PI_MCP_AUTH_TOKEN ?? "secret";
const expectedHeader = process.env.PI_MCP_EXPECT_HEADER;
const stats = { mcpRequests: 0, http: 0, sse: 0, ws: 0, authFailures: 0, headerFailures: 0, oauthAuthorize: 0, oauthToken: 0, oauthRegister: 0 };

function createEchoMcpServer() {
	const server = new McpServer({ name: "pi-mcp-network-fixture", title: "Pi MCP Network Fixture", version: "0.1.0" });

	server.registerTool(
		"echo",
		{
			title: "Echo",
			description: "Echo a message back to the caller.",
			inputSchema: { message: z.string().describe("Message to echo") },
			annotations: { readOnlyHint: true },
		},
		async ({ message }) => ({
			content: [{ type: "text", text: `network echo: ${message}` }],
			structuredContent: { echoed: message },
		}),
	);

	server.registerResource(
		"hello",
		"network://hello",
		{
			title: "Network Hello Resource",
			description: "A small network fixture resource.",
			mimeType: "text/plain",
		},
		async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: "hello from network resource" }] }),
	);

	server.registerPrompt(
		"echo_prompt",
		{
			title: "Network Echo Prompt",
			description: "Prompt fixture for network transport tests.",
			argsSchema: { message: z.string().optional() },
		},
		async ({ message }) => ({
			messages: [
				{
					role: "user",
					content: { type: "text", text: `Network prompt: ${message ?? "hello"}` },
				},
			],
		}),
	);

	return server;
}

function record(kind) {
	stats.mcpRequests++;
	stats[kind]++;
}

function headerValue(req, name) {
	const value = req.headers[name.toLowerCase()];
	return Array.isArray(value) ? value.join(",") : value;
}

function checkExpectedHeader(req) {
	if (!expectedHeader) return true;
	const split = expectedHeader.indexOf(":");
	const name = split === -1 ? expectedHeader : expectedHeader.slice(0, split);
	const value = split === -1 ? "" : expectedHeader.slice(split + 1);
	return headerValue(req, name) === value;
}

function checkAccess(req, res) {
	if (!checkExpectedHeader(req)) {
		stats.headerFailures++;
		res.writeHead(400, { "content-type": "text/plain" });
		res.end("Missing expected test header");
		return false;
	}
	if (requireAuth && headerValue(req, "authorization") !== `Bearer ${authToken}`) {
		stats.authFailures++;
		const resourceMetadata = oauthEnabled ? `, resource_metadata=\"http://${req.headers.host}/.well-known/oauth-protected-resource\"` : "";
		res.writeHead(401, { "content-type": "text/plain", "www-authenticate": `Bearer${resourceMetadata}` });
		res.end("Unauthorized");
		return false;
	}
	return true;
}

function rejectUpgrade(socket, status, message) {
	socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: ${message.length}\r\n\r\n${message}`);
	socket.destroy();
}

async function readBody(req) {
	let body = "";
	for await (const chunk of req) body += chunk.toString("utf8");
	return body;
}

function sendJson(res, value, status = 200) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

function checkUpgradeAccess(req, socket) {
	if (!checkExpectedHeader(req)) {
		stats.headerFailures++;
		rejectUpgrade(socket, 400, "Missing expected test header");
		return false;
	}
	if (requireAuth && headerValue(req, "authorization") !== `Bearer ${authToken}`) {
		stats.authFailures++;
		rejectUpgrade(socket, 401, "Unauthorized");
		return false;
	}
	return true;
}

const streamableTransports = new Map();
const sseTransports = new Map();
const webSocketServer = new WebSocketServer({ noServer: true });

function wsResult(id, result) {
	return { jsonrpc: "2.0", id, result };
}

function wsError(id, code, message) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function wsTools() {
	return [
		{
			name: "echo",
			title: "Echo",
			description: "Echo a message back to the caller.",
			inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
			annotations: { readOnlyHint: true },
		},
	];
}

function wsResources() {
	return [{ uri: "network://hello", name: "hello", title: "Network Hello Resource", description: "A small network fixture resource.", mimeType: "text/plain" }];
}

function wsPrompts() {
	return [{ name: "echo_prompt", title: "Network Echo Prompt", description: "Prompt fixture for network transport tests.", arguments: [{ name: "message", required: false }] }];
}

function handleWsRequest(ws, message) {
	if (!message || typeof message !== "object") return;
	const id = message.id;
	const method = message.method;
	if (id === undefined) return;

	switch (method) {
		case "initialize":
			ws.send(
				JSON.stringify(
					wsResult(id, {
						protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
						capabilities: { tools: {}, resources: {}, prompts: {} },
						serverInfo: { name: "pi-mcp-ws-fixture", title: "Pi MCP WS Fixture", version: "0.1.0" },
					}),
				),
			);
			break;
		case "ping":
			ws.send(JSON.stringify(wsResult(id, {})));
			break;
		case "tools/list":
			ws.send(JSON.stringify(wsResult(id, { tools: wsTools() })));
			break;
		case "tools/call": {
			const name = message.params?.name;
			if (name !== "echo") {
				ws.send(JSON.stringify(wsError(id, -32602, `Unknown tool: ${name}`)));
				break;
			}
			const text = String(message.params?.arguments?.message ?? "");
			ws.send(JSON.stringify(wsResult(id, { content: [{ type: "text", text: `network echo: ${text}` }], structuredContent: { echoed: text } })));
			break;
		}
		case "resources/list":
			ws.send(JSON.stringify(wsResult(id, { resources: wsResources() })));
			break;
		case "resources/read":
			ws.send(JSON.stringify(wsResult(id, { contents: [{ uri: message.params?.uri ?? "network://hello", mimeType: "text/plain", text: "hello from network resource" }] })));
			break;
		case "prompts/list":
			ws.send(JSON.stringify(wsResult(id, { prompts: wsPrompts() })));
			break;
		case "prompts/get":
			ws.send(
				JSON.stringify(
					wsResult(id, {
						messages: [{ role: "user", content: { type: "text", text: `Network prompt: ${message.params?.arguments?.message ?? "hello"}` } }],
					}),
				),
			);
			break;
		default:
			ws.send(JSON.stringify(wsError(id, -32601, `Method not found: ${method}`)));
	}
}

webSocketServer.on("connection", (ws) => {
	ws.on("message", (data) => {
		const parsed = JSON.parse(data.toString("utf8"));
		const messages = Array.isArray(parsed) ? parsed : [parsed];
		for (const message of messages) handleWsRequest(ws, message);
	});
});

const httpServer = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	try {
		if (url.pathname === "/stats") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(stats));
			return;
		}
		if (oauthEnabled && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")) {
			const base = `http://${req.headers.host}`;
			sendJson(res, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["mcp"] });
			return;
		}
		if (oauthEnabled && (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration")) {
			const base = `http://${req.headers.host}`;
			sendJson(res, {
				issuer: base,
				authorization_endpoint: `${base}/oauth/authorize`,
				token_endpoint: `${base}/oauth/token`,
				registration_endpoint: `${base}/oauth/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
				code_challenge_methods_supported: ["S256"],
			});
			return;
		}
		if (oauthEnabled && url.pathname === "/oauth/register" && req.method === "POST") {
			stats.oauthRegister++;
			const metadata = JSON.parse(await readBody(req));
			sendJson(res, { ...metadata, client_id: "pi-mcp-test-client", client_secret: "pi-mcp-test-secret", token_endpoint_auth_method: "client_secret_post" }, 201);
			return;
		}
		if (oauthEnabled && url.pathname === "/oauth/authorize") {
			stats.oauthAuthorize++;
			const redirectUri = url.searchParams.get("redirect_uri");
			if (!redirectUri) {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end("missing redirect_uri");
				return;
			}
			const redirect = new URL(redirectUri);
			redirect.searchParams.set("code", "pi-mcp-test-code");
			const state = url.searchParams.get("state");
			if (state) redirect.searchParams.set("state", state);
			res.writeHead(302, { location: redirect.toString() });
			res.end();
			return;
		}
		if (oauthEnabled && url.pathname === "/oauth/token" && req.method === "POST") {
			stats.oauthToken++;
			const params = new URLSearchParams(await readBody(req));
			const grantType = params.get("grant_type");
			if (grantType !== "authorization_code" && grantType !== "refresh_token") {
				sendJson(res, { error: "unsupported_grant_type" }, 400);
				return;
			}
			sendJson(res, { access_token: authToken, token_type: "Bearer", expires_in: 3600, refresh_token: "pi-mcp-refresh-token", scope: "mcp" });
			return;
		}
		if (url.pathname === "/mcp") {
			record("http");
			if (!checkAccess(req, res)) return;
			const sessionId = headerValue(req, "mcp-session-id");
			let transport = sessionId ? streamableTransports.get(sessionId) : undefined;
			if (!transport) {
				transport = new StreamableHTTPServerTransport({
					sessionIdGenerator: () => randomUUID(),
					onsessioninitialized: (newSessionId) => streamableTransports.set(newSessionId, transport),
				});
				transport.onclose = () => {
					if (transport.sessionId) streamableTransports.delete(transport.sessionId);
				};
				await createEchoMcpServer().connect(transport);
			}
			await transport.handleRequest(req, res);
			return;
		}
		if (url.pathname === "/sse" && req.method === "GET") {
			record("sse");
			if (!checkAccess(req, res)) return;
			const transport = new SSEServerTransport("/message", res);
			sseTransports.set(transport.sessionId, transport);
			transport.onclose = () => sseTransports.delete(transport.sessionId);
			await createEchoMcpServer().connect(transport);
			return;
		}
		if (url.pathname === "/message" && req.method === "POST") {
			record("sse");
			if (!checkAccess(req, res)) return;
			const sessionId = url.searchParams.get("sessionId");
			const transport = sessionId ? sseTransports.get(sessionId) : undefined;
			if (!transport) {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("Unknown SSE session");
				return;
			}
			await transport.handlePostMessage(req, res);
			return;
		}
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("Not found");
	} catch (error) {
		res.writeHead(500, { "content-type": "text/plain" });
		res.end(error instanceof Error ? error.stack : String(error));
	}
});

httpServer.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (url.pathname !== "/ws") {
		rejectUpgrade(socket, 404, "Not found");
		return;
	}
	record("ws");
	if (!checkUpgradeAccess(req, socket)) return;
	webSocketServer.handleUpgrade(req, socket, head, (ws) => webSocketServer.emit("connection", ws, req));
});

await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const address = httpServer.address();
const port = typeof address === "object" && address ? address.port : 0;
console.log(
	JSON.stringify({
		port,
		httpUrl: `http://127.0.0.1:${port}/mcp`,
		sseUrl: `http://127.0.0.1:${port}/sse`,
		wsUrl: `ws://127.0.0.1:${port}/ws`,
		statsUrl: `http://127.0.0.1:${port}/stats`,
	}),
);

async function shutdown() {
	for (const transport of streamableTransports.values()) await transport.close().catch(() => undefined);
	for (const transport of sseTransports.values()) await transport.close().catch(() => undefined);
	webSocketServer.close();
	httpServer.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
