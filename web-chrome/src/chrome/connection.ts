import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { abortError } from "../util/async-queue.js";
import { CdpError } from "../util/errors.js";
import { logProtocolMessage } from "../util/protocol-log.js";

export interface CdpEvent {
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

export interface CdpSendOptions {
	sessionId?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface PendingCommand {
	method: string;
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timer?: NodeJS.Timeout;
	onAbort?: () => void;
	signal?: AbortSignal;
}

export class CdpConnection extends EventEmitter {
	private ws: WebSocket;
	private nextId = 1;
	private pending = new Map<number, PendingCommand>();
	private closed = false;

	private constructor(ws: WebSocket) {
		super();
		this.ws = ws;
		this.ws.on("message", (data) => this.handleMessage(data));
		this.ws.on("close", (code, reason) => this.handleClose(`CDP WebSocket closed (${code}${reason.length ? `: ${reason.toString()}` : ""})`));
		this.ws.on("error", (error) => {
			this.emit("errorEvent", error);
			this.handleClose(`CDP WebSocket error: ${error.message}`);
		});
	}

	static async connect(webSocketDebuggerUrl: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CdpConnection> {
		const timeoutMs = options.timeoutMs ?? 10_000;
		if (options.signal?.aborted) throw abortError();

		const ws = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false });
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => cleanupReject(new Error(`Timed out after ${timeoutMs}ms connecting to CDP WebSocket.`)), timeoutMs);
			const onOpen = () => cleanupResolve();
			const onError = (error: Error) => cleanupReject(error);
			const onAbort = () => {
				try {
					ws.close();
				} catch {
					// Ignore close failure.
				}
				cleanupReject(abortError());
			};

			function cleanup() {
				clearTimeout(timer);
				ws.off("open", onOpen);
				ws.off("error", onError);
				options.signal?.removeEventListener("abort", onAbort);
			}

			function cleanupResolve() {
				cleanup();
				resolve();
			}

			function cleanupReject(error: Error) {
				cleanup();
				reject(error);
			}

			ws.once("open", onOpen);
			ws.once("error", onError);
			options.signal?.addEventListener("abort", onAbort, { once: true });
		});

		return new CdpConnection(ws);
	}

	isConnected(): boolean {
		return !this.closed && this.ws.readyState === WebSocket.OPEN;
	}

	async send<T = unknown>(method: string, params?: Record<string, unknown>, options: CdpSendOptions = {}): Promise<T> {
		if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw new Error("CDP WebSocket is not connected.");
		if (options.signal?.aborted) throw abortError();

		const id = this.nextId++;
		const message: Record<string, unknown> = { id, method };
		if (params !== undefined) message.params = params;
		if (options.sessionId) message.sessionId = options.sessionId;

		const timeoutMs = options.timeoutMs ?? 30_000;
		return new Promise<T>((resolve, reject) => {
			const pending: PendingCommand = {
				method,
				resolve: (value) => resolve(value as T),
				reject,
				signal: options.signal,
			};

			if (timeoutMs > 0) {
				pending.timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP command ${method}.`));
				}, timeoutMs);
			}

			if (options.signal) {
				pending.onAbort = () => {
					this.pending.delete(id);
					if (pending.timer) clearTimeout(pending.timer);
					reject(abortError());
				};
				options.signal.addEventListener("abort", pending.onAbort, { once: true });
			}

			this.pending.set(id, pending);
			try {
				logProtocolMessage("send", message);
				this.ws.send(JSON.stringify(message));
			} catch (error) {
				this.pending.delete(id);
				this.cleanupPending(pending);
				reject(error);
			}
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.ws.close();
		} catch {
			// Ignore close failure.
		}
		this.rejectAllPending(new Error("CDP connection closed."));
	}

	private handleMessage(data: WebSocket.RawData): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(data.toString()) as Record<string, unknown>;
		} catch {
			this.emit("protocolError", new Error("Received non-JSON CDP message."));
			return;
		}

		logProtocolMessage("recv", message);

		if (typeof message.id === "number") {
			this.handleResponse(message.id, message);
			return;
		}

		if (typeof message.method === "string") {
			const event: CdpEvent = {
				method: message.method,
				params: isRecord(message.params) ? message.params : undefined,
				sessionId: typeof message.sessionId === "string" ? message.sessionId : undefined,
			};
			if (event.sessionId) this.emit(`session:${event.sessionId}`, event);
			else this.emit("browserEvent", event);
			this.emit("event", event);
		}
	}

	private handleResponse(id: number, message: Record<string, unknown>): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		this.cleanupPending(pending);

		if (isRecord(message.error)) {
			const code = typeof message.error.code === "number" ? message.error.code : undefined;
			const cdpMessage = typeof message.error.message === "string" ? message.error.message : "Unknown CDP error";
			pending.reject(new CdpError(`${pending.method} failed: ${cdpMessage}`, { code, message: cdpMessage, data: message.error.data }));
			return;
		}

		pending.resolve(message.result);
	}

	private handleClose(message: string): void {
		if (this.closed) return;
		this.closed = true;
		this.rejectAllPending(new Error(message));
		this.emit("closeEvent", message);
	}

	private rejectAllPending(error: Error): void {
		for (const pending of this.pending.values()) {
			this.cleanupPending(pending);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private cleanupPending(pending: PendingCommand): void {
		if (pending.timer) clearTimeout(pending.timer);
		if (pending.onAbort && pending.signal) pending.signal.removeEventListener("abort", pending.onAbort);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
