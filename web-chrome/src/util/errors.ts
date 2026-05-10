export class ChromeError extends Error {
	constructor(message: string, public readonly details?: unknown) {
		super(message);
		this.name = "ChromeError";
	}
}

export class CdpError extends ChromeError {
	constructor(message: string, public readonly cdp?: { code?: number; message?: string; data?: unknown }) {
		super(message, cdp);
		this.name = "CdpError";
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export function withCause(message: string, error: unknown): Error {
	return new ChromeError(`${message}: ${errorMessage(error)}`, error);
}
