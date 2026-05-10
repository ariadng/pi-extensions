import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { CdpConnection } from "../src/chrome/connection.js";

async function withServer(handler: (message: Record<string, unknown>, socket: import("ws").WebSocket) => void | Promise<void>) {
	const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(wss, "listening");
	wss.on("connection", (socket) => {
		socket.on("message", async (data) => {
			await handler(JSON.parse(data.toString()) as Record<string, unknown>, socket);
		});
	});
	const address = wss.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP WebSocket server address");
	const url = `ws://127.0.0.1:${address.port}/devtools/browser/test`;
	return { wss, url };
}

test("CdpConnection resolves command responses and routes events", async () => {
	const { wss, url } = await withServer((message, socket) => {
		if (message.method === "Browser.getVersion") {
			socket.send(JSON.stringify({ method: "Browser.downloadWillBegin", params: { guid: "b" } }));
			socket.send(JSON.stringify({ sessionId: "s1", method: "Runtime.consoleAPICalled", params: { type: "log" } }));
			socket.send(JSON.stringify({ id: message.id, result: { product: "Chrome/Test" } }));
		}
	});

	const connection = await CdpConnection.connect(url);
	try {
		const browserEvent = once(connection, "browserEvent");
		const sessionEvent = once(connection, "session:s1");
		const result = await connection.send<{ product: string }>("Browser.getVersion");
		assert.deepEqual(result, { product: "Chrome/Test" });
		assert.equal((await browserEvent)[0].method, "Browser.downloadWillBegin");
		assert.equal((await sessionEvent)[0].method, "Runtime.consoleAPICalled");
	} finally {
		connection.close();
		wss.close();
	}
});

test("CdpConnection rejects CDP error responses", async () => {
	const { wss, url } = await withServer((message, socket) => {
		socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "boom" } }));
	});
	const connection = await CdpConnection.connect(url);
	try {
		await assert.rejects(() => connection.send("Broken.method"), /Broken\.method failed: boom/);
	} finally {
		connection.close();
		wss.close();
	}
});

test("CdpConnection rejects pending commands on close", async () => {
	let connectedSocket: import("ws").WebSocket | undefined;
	let receivedResolve!: () => void;
	const received = new Promise<void>((resolve) => {
		receivedResolve = resolve;
	});
	const { wss, url } = await withServer((_message, socket) => {
		connectedSocket = socket;
		receivedResolve();
	});
	const connection = await CdpConnection.connect(url);
	try {
		const pending = connection.send("Never.responds", {}, { timeoutMs: 10_000 });
		await received;
		connectedSocket?.close();
		await assert.rejects(() => pending, /closed/i);
	} finally {
		connection.close();
		wss.close();
	}
});
