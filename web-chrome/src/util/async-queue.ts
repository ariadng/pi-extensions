export class AsyncQueue {
	private tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const runTask = async () => {
			if (signal?.aborted) throw abortError();
			return task();
		};

		const result = this.tail.then(runTask, runTask);
		this.tail = result.catch(() => undefined);
		return result;
	}
}

export function abortError(message = "Operation cancelled"): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}
