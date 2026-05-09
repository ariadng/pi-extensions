import { byteLength } from "./utils.js";

export type CacheEntry = {
	url: string;
	finalUrl: string;
	status: number;
	statusText: string;
	contentType: string;
	bytes: number;
	markdown: string;
	markdownBytes: number;
	title?: string;
	persistedBinaryPath?: string;
	fetchedAt: number;
	redirected: boolean;
	contentKind: "text" | "binary";
};

export type CacheStats = {
	entries: number;
	bytes: number;
	maxBytes: number;
	ttlMs: number;
};

export class WebFetchCache {
	private entries = new Map<string, CacheEntry>();
	private totalBytes = 0;

	constructor(private ttlMs: number, private maxBytes: number) {}

	configure(options: { ttlMs: number; maxBytes: number }): void {
		this.ttlMs = options.ttlMs;
		this.maxBytes = options.maxBytes;
		this.prune(Date.now());
	}

	get(key: string, now = Date.now()): CacheEntry | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (now - entry.fetchedAt > this.ttlMs) {
			this.delete(key);
			return undefined;
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		return { ...entry };
	}

	set(key: string, entry: CacheEntry): void {
		const normalizedEntry = { ...entry, markdownBytes: entry.markdownBytes || byteLength(entry.markdown) };
		if (normalizedEntry.markdownBytes > this.maxBytes) return;
		this.delete(key);
		this.entries.set(key, normalizedEntry);
		this.totalBytes += normalizedEntry.markdownBytes;
		this.evictToLimit();
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}

	stats(now = Date.now()): CacheStats {
		this.prune(now);
		return {
			entries: this.entries.size,
			bytes: this.totalBytes,
			maxBytes: this.maxBytes,
			ttlMs: this.ttlMs,
		};
	}

	private prune(now: number): void {
		for (const [key, entry] of this.entries) {
			if (now - entry.fetchedAt > this.ttlMs) this.delete(key);
		}
		this.evictToLimit();
	}

	private evictToLimit(): void {
		while (this.totalBytes > this.maxBytes) {
			const oldestKey = this.entries.keys().next().value as string | undefined;
			if (!oldestKey) break;
			this.delete(oldestKey);
		}
	}

	private delete(key: string): void {
		const existing = this.entries.get(key);
		if (!existing) return;
		this.totalBytes -= existing.markdownBytes;
		if (this.totalBytes < 0) this.totalBytes = 0;
		this.entries.delete(key);
	}
}
