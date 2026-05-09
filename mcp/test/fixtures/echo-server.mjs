#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.PI_MCP_ECHO_MARKER) {
  appendFileSync(process.env.PI_MCP_ECHO_MARKER, `started ${process.pid}\n`, "utf8");
}

const server = new McpServer({ name: "pi-mcp-echo", title: "Pi MCP Echo", version: "0.1.0" });

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo a message back to the caller.",
    inputSchema: { message: z.string().describe("Message to echo") },
    annotations: { readOnlyHint: true },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo: ${message}` }],
    structuredContent: { echoed: message },
  }),
);

server.registerTool(
  "fail",
  {
    title: "Fail",
    description: "Return an MCP tool error.",
    inputSchema: { message: z.string().optional() },
  },
  async ({ message }) => ({
    isError: true,
    content: [{ type: "text", text: message ?? "intentional failure" }],
  }),
);

if (process.env.PI_MCP_DYNAMIC === "1") {
  const dynamicTool = server.registerTool(
    "dynamic_echo",
    {
      title: "Dynamic Echo",
      description: "A dynamically enabled echo tool.",
      inputSchema: { message: z.string().describe("Message to echo dynamically") },
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `dynamic echo: ${message}` }],
      structuredContent: { echoed: message, dynamic: true },
    }),
  );
  const dynamicResource = server.registerResource(
    "dynamic",
    "echo://dynamic",
    {
      title: "Dynamic Resource",
      description: "A dynamically enabled resource.",
      mimeType: "text/plain",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: "hello from dynamic resource" }],
    }),
  );
  const dynamicPrompt = server.registerPrompt(
    "dynamic_prompt",
    {
      title: "Dynamic Prompt",
      description: "A dynamically enabled prompt.",
      argsSchema: { message: z.string().optional() },
    },
    async ({ message }) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `Dynamic prompt: ${message ?? "hello"}` },
        },
      ],
    }),
  );

  dynamicTool.disable();
  dynamicResource.disable();
  dynamicPrompt.disable();

  server.registerTool(
    "toggle_dynamic",
    {
      title: "Toggle Dynamic MCP Items",
      description: "Enable or disable dynamic tool/resource/prompt fixture items.",
      inputSchema: { enabled: z.boolean().describe("Whether dynamic items should be enabled") },
    },
    async ({ enabled }) => {
      if (enabled) {
        dynamicTool.enable();
        dynamicResource.enable();
        dynamicPrompt.enable();
      } else {
        dynamicTool.disable();
        dynamicResource.disable();
        dynamicPrompt.disable();
      }
      return { content: [{ type: "text", text: `dynamic items ${enabled ? "enabled" : "disabled"}` }] };
    },
  );
}

server.registerResource(
  "hello",
  "echo://hello",
  {
    title: "Hello Resource",
    description: "A small text resource from the echo test server.",
    mimeType: "text/plain",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: "hello from echo resource" }],
  }),
);

server.registerPrompt(
  "echo_prompt",
  {
    title: "Echo Prompt",
    description: "Prompt fixture for echo testing.",
    argsSchema: { message: z.string().optional() },
  },
  async ({ message }) => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: `Please echo: ${message ?? "hello"}` },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
