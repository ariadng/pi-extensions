const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token"]);

export function redactHeaders(headers: Record<string, unknown> | undefined, includeSensitive = false): Record<string, unknown> | undefined {
	if (!headers) return undefined;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(headers)) {
		result[key] = !includeSensitive && SENSITIVE_HEADERS.has(key.toLowerCase()) ? "[REDACTED]" : value;
	}
	return result;
}

export function redactUrl(url: string, includeSensitive = false): string {
	if (includeSensitive) return url;
	try {
		const parsed = new URL(url);
		for (const [key, value] of [...parsed.searchParams.entries()]) {
			if (/(token|key|secret|password|passwd|auth|session|jwt|credential)/i.test(key) || looksSensitive(value)) {
				parsed.searchParams.set(key, "[REDACTED]");
			}
		}
		return parsed.toString();
	} catch {
		return url;
	}
}

function looksSensitive(value: string): boolean {
	return value.length > 24 && /^[A-Za-z0-9._~+/=-]+$/.test(value);
}
