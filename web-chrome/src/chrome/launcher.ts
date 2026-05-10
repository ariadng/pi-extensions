import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverChromeExecutable } from "./executable.js";
import { resolveProfile, type ProfileMode, type ResolvedProfile } from "../config.js";
import { abortError } from "../util/async-queue.js";
import { sleep } from "../util/time.js";

export interface ChromeLaunchInput {
	url?: string;
	headless?: boolean;
	profileMode?: ProfileMode;
	profileName?: string;
	userDataDir?: string;
	chromePath?: string;
	timeoutMs?: number;
}

type ChromeProcess = ChildProcessByStdio<null, null, Readable>;

export interface LaunchedChrome {
	process: ChromeProcess;
	pid?: number;
	executablePath: string;
	args: string[];
	endpoint: string;
	webSocketDebuggerUrl: string;
	profile: ResolvedProfile;
	stderrTail: () => string;
	close: (options?: { graceful?: boolean; timeoutMs?: number }) => Promise<void>;
}

export async function launchChrome(input: ChromeLaunchInput, cwd: string, signal?: AbortSignal): Promise<LaunchedChrome> {
	const timeoutMs = input.timeoutMs ?? 15_000;
	const executablePath = await discoverChromeExecutable(input.chromePath);
	const profile = await resolveProfile(input, cwd);
	const headless = input.headless ?? defaultHeadless();
	const initialUrl = input.url ?? "about:blank";
	const args = buildChromeArgs(profile.userDataDir, initialUrl, headless);
	const stderrLines: string[] = [];

	const child = spawn(executablePath, args, {
		stdio: ["ignore", "ignore", "pipe"],
		detached: false,
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		for (const line of chunk.split(/\r?\n/)) {
			if (!line) continue;
			stderrLines.push(line);
			while (stderrLines.length > 80) stderrLines.shift();
		}
	});

	try {
		const endpoint = await waitForDevToolsEndpoint(child, profile.userDataDir, timeoutMs, signal, () => stderrLines.join("\n"));
		return {
			process: child,
			pid: child.pid,
			executablePath,
			args,
			endpoint: endpoint.httpEndpoint,
			webSocketDebuggerUrl: endpoint.webSocketDebuggerUrl,
			profile,
			stderrTail: () => stderrLines.join("\n"),
			close: async (options = {}) => {
				await closeLaunchedChrome(child, profile, options);
			},
		};
	} catch (error) {
		try {
			child.kill("SIGTERM");
		} catch {
			// Ignore cleanup failures.
		}
		await profile.cleanup().catch(() => undefined);
		throw error;
	}
}

function buildChromeArgs(userDataDir: string, initialUrl: string, headless: boolean): string[] {
	const args = [
		"--remote-debugging-port=0",
		"--remote-debugging-address=127.0.0.1",
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--disable-sync",
	];
	if (headless) args.push("--headless=new");
	args.push(initialUrl);
	return args;
}

function defaultHeadless(): boolean {
	const value = process.env.PI_WEB_CHROME_HEADLESS?.trim().toLowerCase();
	if (value === undefined) return true;
	return !(value === "0" || value === "false" || value === "no" || value === "off");
}

async function waitForDevToolsEndpoint(
	child: ChromeProcess,
	userDataDir: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	stderrTail: () => string,
): Promise<{ httpEndpoint: string; webSocketDebuggerUrl: string }> {
	const started = Date.now();
	let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	child.once("exit", (code, signalName) => {
		exitInfo = { code, signal: signalName };
	});

	while (Date.now() - started < timeoutMs) {
		if (signal?.aborted) throw abortError();
		if (exitInfo) {
			throw new Error(
				`Chrome exited before opening DevTools (code=${exitInfo.code}, signal=${exitInfo.signal}). Stderr tail:\n${stderrTail()}`,
			);
		}

		const fromFile = await readDevToolsActivePort(userDataDir).catch(() => undefined);
		if (fromFile) return fromFile;

		const fromStderr = parseDevToolsListeningLine(stderrTail());
		if (fromStderr) return fromStderr;

		await sleep(100, signal);
	}

	throw new Error(`Timed out after ${timeoutMs}ms waiting for Chrome DevTools endpoint. Stderr tail:\n${stderrTail()}`);
}

async function readDevToolsActivePort(userDataDir: string): Promise<{ httpEndpoint: string; webSocketDebuggerUrl: string } | undefined> {
	const file = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8");
	const [portLine, pathLine] = file.split(/\r?\n/).filter(Boolean);
	if (!portLine || !pathLine) return undefined;
	const port = Number(portLine);
	if (!Number.isFinite(port) || port <= 0) return undefined;
	const path = pathLine.startsWith("/") ? pathLine : `/${pathLine}`;
	return {
		httpEndpoint: `http://127.0.0.1:${port}`,
		webSocketDebuggerUrl: `ws://127.0.0.1:${port}${path}`,
	};
}

function parseDevToolsListeningLine(stderr: string): { httpEndpoint: string; webSocketDebuggerUrl: string } | undefined {
	const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
	if (!match) return undefined;
	const webSocketDebuggerUrl = match[1];
	const parsed = new URL(webSocketDebuggerUrl);
	return { httpEndpoint: `http://${parsed.host}`, webSocketDebuggerUrl };
}

async function closeLaunchedChrome(
	child: ChromeProcess,
	profile: ResolvedProfile,
	options: { graceful?: boolean; timeoutMs?: number },
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 2_000;
	if (!child.killed && child.exitCode === null) {
		if (options.graceful !== false) child.kill("SIGTERM");
		const finished = await waitForExit(child, timeoutMs).catch(() => false);
		if (!finished && child.exitCode === null) {
			try {
				child.kill("SIGKILL");
			} catch {
				// Ignore cleanup failures.
			}
		}
	}
	await profile.cleanup().catch(() => undefined);
}

function waitForExit(child: ChromeProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = () => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}
