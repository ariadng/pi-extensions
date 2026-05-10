import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSearchUrl, cleanSearchResultUrl, formatSearchResults, searchEnginesFor, type SearchResult } from "../src/chrome/search.js";

test("buildSearchUrl builds efficient Google and DuckDuckGo URLs", () => {
	const google = buildSearchUrl("google", { query: "pi coding agent", limit: 12, language: "en" });
	assert.match(google, /^https:\/\/www\.google\.com\/search\?/);
	assert.match(google, /q=pi\+coding\+agent/);
	assert.match(google, /num=12/);
	assert.match(google, /pws=0/);
	assert.match(google, /udm=14/);

	const ddg = buildSearchUrl("duckduckgo", { query: "pi coding agent", region: "us-en" });
	assert.equal(ddg, "https://html.duckduckgo.com/html/?q=pi+coding+agent&kl=us-en");

	const ddgWeb = buildSearchUrl("duckduckgo", { query: "pi coding agent", duckDuckGoMode: "web" });
	assert.equal(ddgWeb, "https://duckduckgo.com/?q=pi+coding+agent&ia=web");
});

test("searchEnginesFor chooses fallback order", () => {
	assert.deepEqual(searchEnginesFor("auto"), ["duckduckgo", "google"]);
	assert.deepEqual(searchEnginesFor(undefined), ["duckduckgo", "google"]);
	assert.deepEqual(searchEnginesFor("google"), ["google"]);
	assert.deepEqual(searchEnginesFor("duckduckgo"), ["duckduckgo"]);
});

test("cleanSearchResultUrl decodes redirect URLs and skips internal URLs", () => {
	assert.equal(cleanSearchResultUrl("https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fdocs&sa=U"), "https://example.com/docs");
	assert.equal(cleanSearchResultUrl("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs"), "https://example.com/docs");
	assert.equal(cleanSearchResultUrl("https://www.google.com/search?q=test"), undefined);
	assert.equal(cleanSearchResultUrl("javascript:alert(1)"), undefined);
});

test("formatSearchResults formats results and challenges", () => {
	const result: SearchResult = {
		query: "pi",
		engine: "duckduckgo",
		url: "https://html.duckduckgo.com/html/?q=pi",
		title: "DuckDuckGo",
		challenge: false,
		attempts: [
			{ engine: "google", url: "https://www.google.com/search?q=pi", challenge: false, resultCount: 0, error: "blocked" },
			{ engine: "duckduckgo", url: "https://html.duckduckgo.com/html/?q=pi", challenge: false, resultCount: 1 },
		],
		results: [{ rank: 1, title: "Pi", url: "https://example.com/pi", snippet: "A useful result." }],
	};
	assert.match(formatSearchResults(result), /google:error\(blocked\), duckduckgo:1 result/);
	assert.match(formatSearchResults(result), /1\. Pi\n   https:\/\/example\.com\/pi\n   A useful result\./);

	const challenge = formatSearchResults({ ...result, challenge: true, challengeReason: "CAPTCHA", results: [] });
	assert.match(challenge, /Challenge: CAPTCHA/);
	assert.match(challenge, /complete the search engine challenge manually/);
});
