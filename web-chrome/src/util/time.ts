import { abortError } from "./async-queue.js";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal?.aborted) return Promise.reject(abortError());

	return new Promise((resolve, reject) => {
		const timer = setTimeout(cleanupResolve, ms);
		const onAbort = () => cleanupReject(abortError());

		function cleanupResolve() {
			cleanup();
			resolve();
		}

		function cleanupReject(error: Error) {
			cleanup();
			reject(error);
		}

		function cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function nowIsoForFile(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

export function deadlineFromNow(timeoutMs: number): number {
	return Date.now() + Math.max(0, timeoutMs);
}

export function remainingMs(deadline: number): number {
	return Math.max(0, deadline - Date.now());
}
