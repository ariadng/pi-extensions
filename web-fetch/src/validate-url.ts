import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { WebFetchConfig } from "./config.js";
import { BlockedUrlError, DnsResolutionError, InvalidUrlError } from "./errors.js";
import { normalizeHostnameForPolicy } from "./utils.js";

export type DnsAddress = { address: string; family: 4 | 6 };
export type DnsLookup = (hostname: string) => Promise<DnsAddress[]>;

export type ValidatedUrl = {
	url: URL;
	normalizedUrl: string;
	hostname: string;
	addresses: DnsAddress[];
	upgraded: boolean;
};

export type ValidateUrlOptions = {
	lookup?: DnsLookup;
};

const DEFAULT_LOOKUP: DnsLookup = async (hostname: string) => {
	const results = await dnsLookup(hostname, { all: true, verbatim: true });
	return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }));
};

export async function normalizeAndValidateUrl(
	input: string,
	config: WebFetchConfig,
	options: ValidateUrlOptions = {},
): Promise<ValidatedUrl> {
	const normalized = normalizeUrl(input, config);
	const hostname = normalizeHostnameForPolicy(normalized.url.hostname);
	validateHostPolicy(hostname, config);

	const ipFamily = isIP(hostname);
	if (ipFamily !== 0) {
		if (!config.allowPrivate && isPrivateOrReservedIp(hostname)) {
			throw new BlockedUrlError(`Blocked private or reserved IP address: ${hostname}`);
		}
		return {
			...normalized,
			hostname,
			addresses: [{ address: hostname, family: ipFamily as 4 | 6 }],
		};
	}

	const lookup = options.lookup ?? DEFAULT_LOOKUP;
	let addresses: DnsAddress[];
	try {
		addresses = await lookup(hostname);
	} catch (error) {
		throw new DnsResolutionError(`Could not resolve hostname ${hostname}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}

	if (addresses.length === 0) throw new DnsResolutionError(`Could not resolve hostname ${hostname}: no DNS records returned`);
	if (!config.allowPrivate) {
		const blocked = addresses.find((address) => isPrivateOrReservedIp(address.address));
		if (blocked) {
			throw new BlockedUrlError(`Blocked private or reserved DNS result for ${hostname}: ${blocked.address}`);
		}
	}

	return { ...normalized, hostname, addresses };
}

export function normalizeUrl(input: string, config: WebFetchConfig): Omit<ValidatedUrl, "hostname" | "addresses"> {
	if (typeof input !== "string" || input.trim().length === 0) throw new InvalidUrlError("URL must be a non-empty string");
	const trimmed = input.trim();
	if (trimmed.length > config.maxUrlLength) {
		throw new InvalidUrlError(`URL length ${trimmed.length} exceeds maximum ${config.maxUrlLength}`);
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch (error) {
		throw new InvalidUrlError(`Invalid URL: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}

	let upgraded = false;
	if (url.protocol === "http:" && !config.allowHttp) {
		url.protocol = "https:";
		upgraded = true;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new InvalidUrlError(`Unsupported URL scheme ${url.protocol}. WebFetch only supports http: and https:.`);
	}

	if (url.username || url.password) {
		throw new InvalidUrlError("URLs with username or password components are not supported");
	}

	const originalHostname = url.hostname;
	const hostname = normalizeHostnameForPolicy(originalHostname);
	if (!hostname) throw new InvalidUrlError("URL must include a hostname");
	if (!hostname.includes(":") && hostname !== originalHostname) {
		url.hostname = hostname;
	}

	return { url, normalizedUrl: url.href, upgraded };
}

export function validateHostPolicy(hostname: string, config: WebFetchConfig): void {
	if (matchesAnyDomain(hostname, config.blockedDomains)) {
		throw new BlockedUrlError(`Blocked by WebFetch domain blocklist: ${hostname}`);
	}
	if (config.allowedDomains.length > 0 && !matchesAnyDomain(hostname, config.allowedDomains)) {
		throw new BlockedUrlError(`Blocked because ${hostname} is not in the WebFetch domain allowlist`);
	}

	if (config.allowPrivate) return;

	if (isProbablyInternalHostname(hostname)) {
		throw new BlockedUrlError(`Blocked private or internal hostname: ${hostname}`);
	}
}

export function isProbablyInternalHostname(hostname: string): boolean {
	const host = normalizeHostnameForPolicy(hostname);
	if (!host) return true;
	if (isIP(host) !== 0) return false;
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".invalid")) return true;
	return !host.includes(".");
}

export function matchesAnyDomain(hostname: string, domains: string[]): boolean {
	const host = normalizeHostnameForPolicy(hostname);
	return domains.some((domain) => domainMatches(host, domain));
}

export function domainMatches(hostname: string, domain: string): boolean {
	let normalizedDomain = normalizeHostnameForPolicy(domain);
	if (normalizedDomain.startsWith("*.")) normalizedDomain = normalizedDomain.slice(2);
	if (normalizedDomain.startsWith(".")) normalizedDomain = normalizedDomain.slice(1);
	if (!normalizedDomain) return false;
	return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
}

export function isPrivateOrReservedIp(address: string): boolean {
	const normalized = normalizeHostnameForPolicy(address.split("%")[0] ?? address);
	const family = isIP(normalized);
	if (family === 4) {
		const ipv4 = parseIpv4(normalized);
		return ipv4 === undefined ? true : isPrivateOrReservedIpv4(ipv4);
	}
	if (family === 6) {
		const bytes = parseIpv6(normalized);
		if (!bytes) return true;
		const mappedIpv4 = ipv4FromMappedIpv6(bytes);
		if (mappedIpv4 !== undefined) return isPrivateOrReservedIpv4(mappedIpv4);
		return isPrivateOrReservedIpv6(bytes);
	}
	return true;
}

export function parseIpv4(address: string): number | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/u.test(part)) return undefined;
		const octet = Number.parseInt(part, 10);
		if (octet < 0 || octet > 255) return undefined;
		value = (value << 8) + octet;
	}
	return value >>> 0;
}

export function parseIpv6(address: string): Uint8Array | undefined {
	let input = normalizeHostnameForPolicy(address.split("%")[0] ?? address);
	if (!input.includes(":")) return undefined;

	if (input.includes(".")) {
		const lastColon = input.lastIndexOf(":");
		const ipv4Text = input.slice(lastColon + 1);
		const ipv4 = parseIpv4(ipv4Text);
		if (ipv4 === undefined) return undefined;
		const high = ((ipv4 >>> 16) & 0xffff).toString(16);
		const low = (ipv4 & 0xffff).toString(16);
		input = `${input.slice(0, lastColon)}:${high}:${low}`;
	}

	const doubleColonParts = input.split("::");
	if (doubleColonParts.length > 2) return undefined;
	const hasCompression = doubleColonParts.length === 2;
	const head = parseHextets(doubleColonParts[0]);
	const tail = hasCompression ? parseHextets(doubleColonParts[1]) : [];
	if (!head || !tail) return undefined;

	let hextets: number[];
	if (hasCompression) {
		const missing = 8 - head.length - tail.length;
		if (missing < 1) return undefined;
		hextets = [...head, ...Array.from({ length: missing }, () => 0), ...tail];
	} else {
		if (head.length !== 8) return undefined;
		hextets = head;
	}

	const bytes = new Uint8Array(16);
	for (let index = 0; index < hextets.length; index += 1) {
		bytes[index * 2] = (hextets[index] >>> 8) & 0xff;
		bytes[index * 2 + 1] = hextets[index] & 0xff;
	}
	return bytes;
}

function parseHextets(part: string): number[] | undefined {
	if (part === "") return [];
	const items = part.split(":");
	const output: number[] = [];
	for (const item of items) {
		if (!/^[0-9a-f]{1,4}$/iu.test(item)) return undefined;
		output.push(Number.parseInt(item, 16));
	}
	return output;
}

function isPrivateOrReservedIpv4(ip: number): boolean {
	const ranges = [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 4],
		["240.0.0.0", 4],
	] satisfies Array<[string, number]>;
	return ranges.some(([base, bits]) => inIpv4Cidr(ip, parseIpv4(base)!, bits));
}

function inIpv4Cidr(ip: number, base: number, bits: number): boolean {
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (ip & mask) === (base & mask);
}

function isPrivateOrReservedIpv6(bytes: Uint8Array): boolean {
	if (bytes.every((byte) => byte === 0)) return true; // :: unspecified
	if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true; // ::1 loopback
	if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
	if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link local
	if (bytes[0] === 0xff) return true; // ff00::/8 multicast
	if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 documentation
	return false;
}

function ipv4FromMappedIpv6(bytes: Uint8Array): number | undefined {
	const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0);
	if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
		return ((bytes[12] << 24) | (bytes[13] << 16) | (bytes[14] << 8) | bytes[15]) >>> 0;
	}
	return undefined;
}
