import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cloneTasks } from "./format.js";
import type { Task, TodoExtensionState } from "./types.js";

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
const POLL_MS = 3_000;

type OnExternalChange = (ctx: ExtensionContext) => void;

export class TaskFileBackend {
	private dir: string | undefined;
	private listId: string | undefined;
	private watcher: ReturnType<typeof import("node:fs").watch> | undefined;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private lastFingerprint = "";
	private ctx: ExtensionContext | undefined;
	private mutating = false;

	constructor(private readonly onExternalChange: OnExternalChange) {}

	isEnabled(state: TodoExtensionState): boolean {
		return state.mode === "tasks" && state.backend === "file";
	}

	start(ctx: ExtensionContext, state: TodoExtensionState): void {
		this.ctx = ctx;
		if (!this.isEnabled(state)) {
			this.stop();
			return;
		}

		const listId = getTaskListId(ctx);
		if (this.dir && this.listId === listId) {
			this.refresh(ctx, state);
			return;
		}

		this.stop();
		this.ctx = ctx;
		this.listId = listId;
		this.dir = getTaskDir(ctx, listId);
		mkdirSync(this.dir, { recursive: true });
		this.refresh(ctx, state);
		this.startWatcher(state);
	}

	stop(): void {
		this.watcher?.close();
		this.watcher = undefined;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = undefined;
		this.dir = undefined;
		this.listId = undefined;
	}

	refresh(ctx: ExtensionContext, state: TodoExtensionState): void {
		if (!this.isEnabled(state) || this.mutating) return;
		this.ensureDir(ctx);
		const snapshot = readSnapshot(this.dir!);
		state.tasks = snapshot.tasks;
		state.nextTaskId = snapshot.nextTaskId;
		this.lastFingerprint = fingerprintSnapshot(snapshot.tasks, snapshot.nextTaskId);
	}

	withMutation<T>(ctx: ExtensionContext, state: TodoExtensionState, fn: () => T | Promise<T>): Promise<T> {
		if (!this.isEnabled(state)) return Promise.resolve(fn());
		this.ensureDir(ctx);
		return withFileLock(this.dir!, async () => {
			this.mutating = true;
			try {
				const snapshot = readSnapshot(this.dir!);
				state.tasks = snapshot.tasks;
				state.nextTaskId = snapshot.nextTaskId;
				const result = await fn();
				writeSnapshot(this.dir!, state.tasks, state.nextTaskId);
				this.lastFingerprint = fingerprintSnapshot(state.tasks, state.nextTaskId);
				return result;
			} finally {
				this.mutating = false;
			}
		});
	}

	persist(ctx: ExtensionContext, state: TodoExtensionState): void {
		if (!this.isEnabled(state)) return;
		this.ensureDir(ctx);
		withFileLockSync(this.dir!, () => {
			this.mutating = true;
			try {
				writeSnapshot(this.dir!, state.tasks, state.nextTaskId);
				this.lastFingerprint = fingerprintSnapshot(state.tasks, state.nextTaskId);
			} finally {
				this.mutating = false;
			}
		});
	}

	private ensureDir(ctx: ExtensionContext): void {
		// Keep the task-list directory stable for the active branch. The leaf ID can
		// change after extension commands append state entries; session_start and
		// session_tree are responsible for rebasing the file backend to a new branch.
		if (!this.dir) {
			this.listId = getTaskListId(ctx);
			this.dir = getTaskDir(ctx, this.listId);
		}
		mkdirSync(this.dir, { recursive: true });
	}

	private startWatcher(state: TodoExtensionState): void {
		if (!this.dir || !this.ctx) return;
		try {
			this.watcher = watchDirectory(this.dir, () => this.scheduleExternalRefresh(state));
		} catch {
			this.watcher = undefined;
		}

		this.pollTimer = setInterval(() => this.scheduleExternalRefresh(state), POLL_MS);
		this.pollTimer.unref?.();
	}

	private scheduleExternalRefresh(state: TodoExtensionState): void {
		if (!this.ctx || !this.dir || !this.isEnabled(state) || this.mutating) return;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			if (!this.ctx || !this.dir || !this.isEnabled(state) || this.mutating) return;
			const snapshot = readSnapshot(this.dir);
			const fingerprint = fingerprintSnapshot(snapshot.tasks, snapshot.nextTaskId);
			if (fingerprint === this.lastFingerprint) return;
			state.tasks = snapshot.tasks;
			state.nextTaskId = snapshot.nextTaskId;
			this.lastFingerprint = fingerprint;
			this.onExternalChange(this.ctx);
		}, 100);
		this.debounceTimer.unref?.();
	}
}

function getTaskDir(ctx: ExtensionContext, listId: string): string {
	return join(getAgentDir(), "tasks", listId);
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || ".", ".pi", "agent");
}

function getTaskListId(ctx: ExtensionContext): string {
	const sessionId = ctx.sessionManager.getSessionId?.() ?? "ephemeral";
	const leafId = ctx.sessionManager.getLeafId?.() ?? "root";
	return sanitize(`${sessionId}-${leafId}`);
}

function sanitize(value: string): string {
	return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 160) || "default";
}

function readSnapshot(dir: string): { tasks: Task[]; nextTaskId: number } {
	mkdirSync(dir, { recursive: true });
	const tasks: Task[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		try {
			const task = JSON.parse(readFileSync(join(dir, name), "utf8")) as Task;
			if (isTask(task)) tasks.push(task);
		} catch {
			// Ignore malformed task files; external editors may be mid-write.
		}
	}
	tasks.sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
	const maxId = tasks.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0);
	const nextFromFile = readHighWatermark(dir);
	return { tasks, nextTaskId: Math.max(maxId + 1, nextFromFile) };
}

function writeSnapshot(dir: string, tasks: readonly Task[], nextTaskId: number): void {
	mkdirSync(dir, { recursive: true });
	const keep = new Set(tasks.map((task) => `${sanitize(task.id)}.json`));
	for (const name of readdirSync(dir)) {
		if (name.endsWith(".json") && !keep.has(name)) rmSync(join(dir, name), { force: true });
	}
	for (const task of tasks) {
		writeJsonAtomic(join(dir, `${sanitize(task.id)}.json`), task);
	}
	writeFileSync(join(dir, ".highwatermark"), `${Math.max(1, nextTaskId)}\n`, "utf8");
}

function readHighWatermark(dir: string): number {
	try {
		const value = Number(readFileSync(join(dir, ".highwatermark"), "utf8").trim());
		return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
	} catch {
		return 1;
	}
}

function writeJsonAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

async function withFileLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
	acquireLock(dir);
	try {
		return await fn();
	} finally {
		releaseLock(dir);
	}
}

function withFileLockSync<T>(dir: string, fn: () => T): T {
	acquireLock(dir);
	try {
		return fn();
	} finally {
		releaseLock(dir);
	}
}

function acquireLock(dir: string): void {
	mkdirSync(dir, { recursive: true });
	const lockDir = join(dir, ".lock");
	const start = Date.now();
	while (true) {
		try {
			mkdirSync(lockDir);
			writeFileSync(join(lockDir, "owner"), `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
			return;
		} catch {
			if (Date.now() - start > LOCK_TIMEOUT_MS) {
				tryRemoveStaleLock(lockDir);
				try {
					mkdirSync(lockDir);
					return;
				} catch {
					throw new Error(`Timed out waiting for pi-todo file backend lock: ${lockDir}`);
				}
			}
			sleepSync(LOCK_RETRY_MS);
		}
	}
}

function releaseLock(dir: string): void {
	rmSync(join(dir, ".lock"), { recursive: true, force: true });
}

function tryRemoveStaleLock(lockDir: string): void {
	try {
		const ageMs = Date.now() - statSync(lockDir).mtimeMs;
		if (ageMs > LOCK_TIMEOUT_MS) rmSync(lockDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function sleepSync(ms: number): void {
	const end = Date.now() + ms;
	while (Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, end - Date.now()));
}

function watchDirectory(dir: string, onChange: () => void): ReturnType<typeof watch> {
	return watch(dir, { persistent: false }, onChange);
}

function fingerprintSnapshot(tasks: readonly Task[], nextTaskId: number): string {
	return JSON.stringify({ nextTaskId, tasks: cloneTasks(tasks) });
}

function isTask(value: unknown): value is Task {
	if (!value || typeof value !== "object") return false;
	const task = value as Partial<Task>;
	return (
		typeof task.id === "string" &&
		typeof task.subject === "string" &&
		typeof task.description === "string" &&
		(task.status === "pending" || task.status === "in_progress" || task.status === "completed") &&
		Array.isArray(task.blocks) &&
		Array.isArray(task.blockedBy)
	);
}
