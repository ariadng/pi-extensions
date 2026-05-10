export type SearchEngine = "auto" | "google" | "duckduckgo";
export type DuckDuckGoMode = "html" | "lite" | "web";

export interface SearchOptions {
	query: string;
	engine?: SearchEngine;
	limit?: number;
	language?: string;
	region?: string;
	duckDuckGoMode?: DuckDuckGoMode;
}

export interface SearchAttempt {
	engine: Exclude<SearchEngine, "auto">;
	url: string;
	challenge: boolean;
	challengeReason?: string;
	resultCount: number;
	error?: string;
}

export interface SearchResultItem {
	rank: number;
	title: string;
	url: string;
	displayUrl?: string;
	snippet?: string;
}

export interface SearchExtractionResult {
	engine: string;
	url: string;
	title: string;
	challenge: boolean;
	challengeReason?: string;
	resultStats?: string;
	results: SearchResultItem[];
}

export interface SearchResult extends SearchExtractionResult {
	query: string;
	attempts: SearchAttempt[];
}

export function searchEnginesFor(engine: SearchEngine | undefined): Array<Exclude<SearchEngine, "auto">> {
	if (engine === "google") return ["google"];
	if (engine === "duckduckgo") return ["duckduckgo"];
	return ["duckduckgo", "google"];
}

export function buildSearchUrl(engine: Exclude<SearchEngine, "auto">, options: SearchOptions): string {
	const query = options.query.trim();
	const limit = Math.max(1, Math.min(options.limit ?? 10, 20));
	const language = options.language ?? "en";
	if (engine === "google") {
		const url = new URL("https://www.google.com/search");
		url.searchParams.set("q", query);
		url.searchParams.set("hl", language);
		url.searchParams.set("num", String(limit));
		url.searchParams.set("pws", "0");
		url.searchParams.set("udm", "14");
		return url.toString();
	}

	const mode = options.duckDuckGoMode ?? "html";
	if (mode === "web") {
		const url = new URL("https://duckduckgo.com/");
		url.searchParams.set("q", query);
		url.searchParams.set("ia", "web");
		if (options.region) url.searchParams.set("kl", options.region);
		return url.toString();
	}

	const url = new URL(mode === "lite" ? "https://lite.duckduckgo.com/lite/" : "https://html.duckduckgo.com/html/");
	url.searchParams.set("q", query);
	if (options.region) url.searchParams.set("kl", options.region);
	return url.toString();
}

export function formatSearchResults(result: SearchResult): string {
	const lines: string[] = [];
	lines.push(`Search: ${JSON.stringify(result.query)}`);
	lines.push(`Engine: ${result.engine}`);
	lines.push(`URL: ${result.url}`);
	if (result.resultStats) lines.push(`Stats: ${result.resultStats}`);
	if (result.challenge) {
		lines.push(`Challenge: ${result.challengeReason ?? "Search engine challenge detected."}`);
	}
	if (result.attempts.length > 1) {
		lines.push(
			`Attempts: ${result.attempts
				.map((attempt) => `${attempt.engine}:${attempt.error ? `error(${attempt.error})` : attempt.challenge ? "challenge" : `${attempt.resultCount} result(s)`}`)
				.join(", ")}`,
		);
	}
	lines.push("");
	if (result.results.length === 0) {
		lines.push("No search results extracted.");
		if (result.challenge) lines.push("Try /chrome login or a visible named profile, complete the search engine challenge manually, then retry.");
		return lines.join("\n");
	}

	for (const item of result.results) {
		lines.push(`${item.rank}. ${item.title}`);
		lines.push(`   ${item.url}`);
		if (item.snippet) lines.push(`   ${item.snippet}`);
	}
	return lines.join("\n");
}

export function cleanSearchResultUrl(rawUrl: string): string | undefined {
	if (!rawUrl) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(rawUrl, "https://example.invalid");
	} catch {
		return undefined;
	}

	if (parsed.hostname.includes("google.") && parsed.pathname === "/url") {
		const target = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
		if (target) return cleanSearchResultUrl(target);
	}

	if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
		const target = parsed.searchParams.get("uddg");
		if (target) return cleanSearchResultUrl(target);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	if (parsed.hostname === "example.invalid") return undefined;
	if (isSearchInternalUrl(parsed)) return undefined;
	return parsed.toString();
}

function isSearchInternalUrl(url: URL): boolean {
	const host = url.hostname.toLowerCase();
	if (host.endsWith("google.com") || /(^|\.)google\.[a-z.]+$/i.test(host)) {
		return ["/search", "/preferences", "/advanced_search", "/sorry/index"].some((path) => url.pathname.startsWith(path));
	}
	if (host.endsWith("duckduckgo.com")) {
		return ["/", "/settings", "/html/", "/lite/"].includes(url.pathname);
	}
	return false;
}

export const SEARCH_EXTRACTOR = String.raw`function extractSearchResults(options) {
  const limit = Math.max(1, Math.min(Number(options && options.limit) || 10, 20));
  const engineHint = options && options.engine || 'auto';
  const pageText = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
  const href = location.href;
  const isGoogle = /(^|\.)google\./i.test(location.hostname);
  const isDuck = /(^|\.)duckduckgo\.com$/i.test(location.hostname);
  const results = [];
  const seen = new Set();

  function clean(value, max) {
    if (value == null) return '';
    return String(value).replace(/\s+/g, ' ').trim().slice(0, max || 300);
  }

  function cleanUrl(rawUrl) {
    if (!rawUrl) return undefined;
    let parsed;
    try { parsed = new URL(rawUrl, location.href); } catch { return undefined; }
    if (/google\./i.test(parsed.hostname) && parsed.pathname === '/url') {
      const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      if (target) return cleanUrl(target);
    }
    if (/duckduckgo\.com$/i.test(parsed.hostname) && parsed.pathname.indexOf('/l/') === 0) {
      const target = parsed.searchParams.get('uddg');
      if (target) return cleanUrl(target);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (isInternal(parsed)) return undefined;
    return parsed.href;
  }

  function isInternal(url) {
    const host = url.hostname.toLowerCase();
    if (/google\./i.test(host)) return ['/search', '/preferences', '/advanced_search', '/sorry/index'].some(function(path) { return url.pathname.indexOf(path) === 0; });
    if (/duckduckgo\.com$/i.test(host)) return ['/', '/settings', '/html/', '/lite/'].includes(url.pathname);
    return false;
  }

  function snippetFromBlock(block, title, displayUrl) {
    if (!block) return '';
    const lines = clean(block.innerText || block.textContent || '', 900)
      .split(/\n|(?<=\.)\s+(?=[A-Z0-9])/)
      .map(function(line) { return clean(line, 260); })
      .filter(Boolean)
      .filter(function(line) { return line !== title && line !== displayUrl && line.length > 20; });
    return lines[0] || '';
  }

  function nearestResultBlock(element) {
    let current = element;
    for (let i = 0; current && i < 8; i++) {
      if (current.matches && current.matches('.result, article, div.g, [data-testid="result"], [data-sokoban-container]')) return current;
      if ((current.innerText || '').length > 120 && current.querySelectorAll && current.querySelectorAll('a').length <= 8) return current;
      current = current.parentElement;
    }
    return element && element.parentElement;
  }

  function add(title, rawUrl, snippet, displayUrl) {
    title = clean(title, 220);
    const url = cleanUrl(rawUrl);
    if (!title || !url || seen.has(url) || results.length >= limit) return;
    seen.add(url);
    results.push({ rank: results.length + 1, title, url, displayUrl: clean(displayUrl, 180) || undefined, snippet: clean(snippet, 500) || undefined });
  }

  let challenge = false;
  let challengeReason;
  if (isGoogle && (/\/sorry\//.test(location.pathname) || /unusual traffic|Our systems have detected|reCAPTCHA/i.test(pageText))) {
    challenge = true;
    challengeReason = 'Google unusual-traffic / CAPTCHA page detected.';
  }
  if (isDuck && /bots use DuckDuckGo too|Select all squares|Please complete the following challenge/i.test(pageText)) {
    challenge = true;
    challengeReason = 'DuckDuckGo bot challenge page detected.';
  }

  if (!challenge && isDuck) {
    document.querySelectorAll('.result').forEach(function(block) {
      const link = block.querySelector('.result__a, a.result__a, a.result-link, a[href]');
      const snippet = block.querySelector('.result__snippet, .result__body, .snippet');
      const display = block.querySelector('.result__url, .result__extras__url');
      if (link) add(link.innerText || link.textContent, link.href, snippet && (snippet.innerText || snippet.textContent), display && (display.innerText || display.textContent));
    });
    document.querySelectorAll('article[data-testid="result"], article').forEach(function(block) {
      const link = block.querySelector('a[data-testid="result-title-a"], h2 a[href], a[href]');
      const snippet = block.querySelector('[data-result="snippet"], [data-testid="result-snippet"], .kY2IgmnCmOGjharHErah');
      if (link) add(link.innerText || link.textContent, link.href, snippet && (snippet.innerText || snippet.textContent), undefined);
    });
  }

  if (!challenge && isGoogle) {
    document.querySelectorAll('#search a[href], a[href]').forEach(function(link) {
      if (results.length >= limit) return;
      const h3 = link.querySelector('h3');
      if (!h3) return;
      const block = nearestResultBlock(link);
      add(h3.innerText || h3.textContent, link.href, snippetFromBlock(block, h3.innerText || h3.textContent, ''), undefined);
    });
  }

  if (!challenge && results.length === 0) {
    document.querySelectorAll('a[href]').forEach(function(link) {
      if (results.length >= limit) return;
      const title = clean(link.innerText || link.textContent, 220);
      if (title.length < 8) return;
      const block = nearestResultBlock(link);
      add(title, link.href, snippetFromBlock(block, title, ''), undefined);
    });
  }

  const statsElement = document.querySelector('#result-stats, .result--more__btn, [data-testid="result-count"]');
  return {
    engine: isGoogle ? 'google' : isDuck ? 'duckduckgo' : engineHint,
    url: location.href,
    title: document.title || '',
    challenge,
    challengeReason,
    resultStats: statsElement ? clean(statsElement.innerText || statsElement.textContent, 200) : undefined,
    results
  };
}`;
