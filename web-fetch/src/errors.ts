export class WebFetchError extends Error {
	readonly code: string;

	constructor(message: string, code: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

export class InvalidUrlError extends WebFetchError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "INVALID_URL", options);
	}
}

export class BlockedUrlError extends WebFetchError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "BLOCKED_URL", options);
	}
}

export class DnsResolutionError extends WebFetchError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "DNS_RESOLUTION_FAILED", options);
	}
}

export class TooManyRedirectsError extends WebFetchError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "TOO_MANY_REDIRECTS", options);
	}
}

export class UnsafeRedirectError extends WebFetchError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "UNSAFE_REDIRECT", options);
	}
}

export class ResponseTooLargeError extends WebFetchError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "RESPONSE_TOO_LARGE", options);
	}
}

export class RequestTimeoutError extends WebFetchError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "REQUEST_TIMEOUT", options);
	}
}

export class OfflineModeError extends WebFetchError {
	constructor(message = "Pi offline mode is enabled (PI_OFFLINE=1). WebFetch fails closed unless PI_WEBFETCH_IGNORE_OFFLINE=1 is set.") {
		super(message, "OFFLINE_MODE");
	}
}

export class SummarizerUnavailableError extends WebFetchError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, "SUMMARIZER_UNAVAILABLE", options);
	}
}
