import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultArtifactRoot } from "./artifacts.js";
import { nowIsoForFile } from "./time.js";

let protocolLogPath: string | undefined;
let writeTail: Promise<unknown> = Promise.resolve();

export function isProtocolLoggingEnabled(): boolean {
	const value = process.env.PI_WEB_CHROME_DEBUG_PROTOCOL?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function getProtocolLogPath(): string | undefined {
	if (!isProtocolLoggingEnabled()) return undefined;
	protocolLogPath ??= join(defaultArtifactRoot(), `${nowIsoForFile()}-protocol.jsonl`);
	return protocolLogPath;
}

export function logProtocolMessage(direction: "send" | "recv", payload: unknown): void {
	const path = getProtocolLogPath();
	if (!path) return;
	const line = JSON.stringify({ timestamp: new Date().toISOString(), direction, payload }) + "\n";
	writeTail = writeTail
		.then(async () => {
			await mkdir(dirname(path), { recursive: true });
			await appendFile(path, line, "utf8");
		})
		.catch(() => undefined);
}
