import assert from "node:assert/strict";
import test from "node:test";
import { defaultWebFetchConfig, type WebFetchConfig } from "../src/config.js";
import { BlockedUrlError, InvalidUrlError } from "../src/errors.js";
import {
	domainMatches,
	isPrivateOrReservedIp,
	normalizeAndValidateUrl,
	type DnsLookup,
} from "../src/validate-url.js";

const publicLookup: DnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup: DnsLookup = async () => [{ address: "10.0.0.5", family: 4 }];

function config(patch: Partial<WebFetchConfig> = {}): WebFetchConfig {
	return { ...defaultWebFetchConfig(), ...patch };
}

test("normalizes http URLs to https by default", async () => {
	const result = await normalizeAndValidateUrl("http://example.com/path", config(), { lookup: publicLookup });
	assert.equal(result.normalizedUrl, "https://example.com/path");
	assert.equal(result.upgraded, true);
});

test("allows plain HTTP only when configured", async () => {
	const result = await normalizeAndValidateUrl("http://example.com/path", config({ allowHttp: true }), { lookup: publicLookup });
	assert.equal(result.normalizedUrl, "http://example.com/path");
	assert.equal(result.upgraded, false);
});

test("rejects unsupported schemes and user info", async () => {
	await assert.rejects(() => normalizeAndValidateUrl("file:///etc/passwd", config(), { lookup: publicLookup }), InvalidUrlError);
	await assert.rejects(() => normalizeAndValidateUrl("ftp://example.com/file", config(), { lookup: publicLookup }), InvalidUrlError);
	await assert.rejects(() => normalizeAndValidateUrl("https://user:pass@example.com", config(), { lookup: publicLookup }), InvalidUrlError);
});

test("rejects localhost, private IP literals, and internal hostnames by default", async () => {
	await assert.rejects(() => normalizeAndValidateUrl("http://127.0.0.1", config(), { lookup: publicLookup }), BlockedUrlError);
	await assert.rejects(() => normalizeAndValidateUrl("http://[::1]", config(), { lookup: publicLookup }), BlockedUrlError);
	await assert.rejects(() => normalizeAndValidateUrl("https://localhost", config(), { lookup: publicLookup }), BlockedUrlError);
	await assert.rejects(() => normalizeAndValidateUrl("https://service.internal", config(), { lookup: publicLookup }), BlockedUrlError);
	await assert.rejects(() => normalizeAndValidateUrl("https://intranet", config(), { lookup: publicLookup }), BlockedUrlError);
});

test("rejects private DNS answers by default", async () => {
	await assert.rejects(() => normalizeAndValidateUrl("https://example.com", config(), { lookup: privateLookup }), BlockedUrlError);
});

test("allows private addresses only when configured, while still rejecting dangerous syntax", async () => {
	const allowPrivate = config({ allowPrivate: true, allowHttp: true });
	const result = await normalizeAndValidateUrl("http://localhost", allowPrivate, { lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
	assert.equal(result.hostname, "localhost");
	await assert.rejects(() => normalizeAndValidateUrl("file:///etc/passwd", allowPrivate, { lookup: publicLookup }), InvalidUrlError);
	await assert.rejects(() => normalizeAndValidateUrl("http://user@example.com", allowPrivate, { lookup: publicLookup }), InvalidUrlError);
});

test("accepts public domains with public DNS answers", async () => {
	const result = await normalizeAndValidateUrl("https://example.com/path?q=1", config(), { lookup: publicLookup });
	assert.equal(result.hostname, "example.com");
	assert.deepEqual(result.addresses, [{ address: "93.184.216.34", family: 4 }]);
});

test("enforces maximum URL length", async () => {
	await assert.rejects(() => normalizeAndValidateUrl(`https://example.com/${"x".repeat(30)}`, config({ maxUrlLength: 20 }), { lookup: publicLookup }), InvalidUrlError);
});

test("applies blocklist and allowlist domain policies", async () => {
	await assert.rejects(() => normalizeAndValidateUrl("https://sub.example.com", config({ blockedDomains: ["example.com"] }), { lookup: publicLookup }), BlockedUrlError);
	await assert.rejects(() => normalizeAndValidateUrl("https://example.org", config({ allowedDomains: ["docs.example.com"] }), { lookup: publicLookup }), BlockedUrlError);
	const allowed = await normalizeAndValidateUrl("https://api.docs.example.com", config({ allowedDomains: ["docs.example.com"] }), { lookup: publicLookup });
	assert.equal(allowed.hostname, "api.docs.example.com");
});

test("detects private and reserved IP ranges", () => {
	assert.equal(isPrivateOrReservedIp("10.0.0.1"), true);
	assert.equal(isPrivateOrReservedIp("172.16.0.1"), true);
	assert.equal(isPrivateOrReservedIp("192.168.1.1"), true);
	assert.equal(isPrivateOrReservedIp("169.254.1.1"), true);
	assert.equal(isPrivateOrReservedIp("224.0.0.1"), true);
	assert.equal(isPrivateOrReservedIp("::1"), true);
	assert.equal(isPrivateOrReservedIp("fc00::1"), true);
	assert.equal(isPrivateOrReservedIp("fe80::1"), true);
	assert.equal(isPrivateOrReservedIp("ff00::1"), true);
	assert.equal(isPrivateOrReservedIp("::ffff:127.0.0.1"), true);
	assert.equal(isPrivateOrReservedIp("93.184.216.34"), false);
	assert.equal(isPrivateOrReservedIp("2606:4700:4700::1111"), false);
});

test("matches domains by exact host or subdomain", () => {
	assert.equal(domainMatches("docs.example.com", "example.com"), true);
	assert.equal(domainMatches("example.com", "example.com"), true);
	assert.equal(domainMatches("badexample.com", "example.com"), false);
});
