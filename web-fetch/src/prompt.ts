export const WEB_FETCH_PROMPT_SNIPPET = "Fetch public HTTP(S) URL content, convert it to readable text/markdown, and answer a prompt about it";

export const WEB_FETCH_PROMPT_GUIDELINES = [
	"Use WebFetch when the user asks for current content from a specific public URL.",
	"WebFetch does not support authenticated, private, or cookie-based browsing; use appropriate CLIs or other tools for logged-in services.",
	"WebFetch automatically converts HTML to markdown and summarizes/extracts according to the prompt argument.",
	"WebFetch blocks localhost/private networks by default and returns cross-host redirects instead of following them automatically.",
	"For GitHub URLs, prefer the gh CLI via bash when repository, issue, or pull-request API access is needed.",
];

export const WEB_FETCH_DESCRIPTION = `Fetch a public HTTP(S) URL with strict SSRF protections, bounded response size, manual same-host redirects, HTML/text conversion, binary persistence, process-local caching, and secondary-model prompt answering. Input must be a fully formed public URL and a prompt describing what to extract from the fetched content. No cookies, authentication, custom headers, browser sessions, JavaScript execution, or private-network URLs are supported by default.`;
