import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { expandHomePath, sanitizeFilePart } from "./path.js";
import { nowIsoForFile } from "./time.js";

export function defaultArtifactBase(): string {
	return process.env.PI_WEB_CHROME_ARTIFACT_DIR
		? resolve(expandHomePath(process.env.PI_WEB_CHROME_ARTIFACT_DIR))
		: join(homedir(), ".pi", "agent", "web-chrome", "artifacts");
}

export function defaultArtifactRoot(): string {
	return process.env.PI_WEB_CHROME_ARTIFACT_DIR ? defaultArtifactBase() : join(defaultArtifactBase(), new Date().toISOString().slice(0, 10));
}

export async function writeArtifact(input: {
	cwd: string;
	path?: string;
	prefix: string;
	extension: string;
	data: string | Buffer;
	encoding?: BufferEncoding;
}): Promise<string> {
	const filePath = input.path
		? resolvePath(input.cwd, input.path)
		: join(defaultArtifactRoot(), `${nowIsoForFile()}-${sanitizeFilePart(input.prefix)}.${input.extension.replace(/^\./, "")}`);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, input.data, input.encoding ? { encoding: input.encoding } : undefined);
	return filePath;
}

function resolvePath(cwd: string, path: string): string {
	const expanded = expandHomePath(path);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
