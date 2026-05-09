import { Type, type Static } from "typebox";

export const WebFetchParams = Type.Object(
	{
		url: Type.String({ description: "The fully formed URL to fetch content from" }),
		prompt: Type.String({ description: "The prompt to run on the fetched content" }),
	},
	{ additionalProperties: false },
);

export type WebFetchInput = Static<typeof WebFetchParams>;

export type WebFetchDetails = {
	url: string;
	finalUrl: string;
	status: number;
	statusText: string;
	contentType: string;
	bytes: number;
	markdownBytes: number;
	title?: string;
	durationMs: number;
	cached: boolean;
	redirected: boolean;
	redirectUrl?: string;
	truncated?: boolean;
	fullContentPath?: string;
	persistedBinaryPath?: string;
	summarizerModel?: string;
	summarizerInputTruncated?: boolean;
	cacheKey?: string;
	contentKind?: "text" | "binary";
};
