import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ASK_USER_QUESTION_TOOL,
	ASK_USER_QUESTION_TOOL_SNAKE,
	TODO_WRITE_TOOL,
	TODO_WRITE_TOOL_SNAKE,
} from "./constants.js";
import type { DependencyNamingMode, DependencyStatus, RequiredDependencyNames } from "./types.js";

type ToolRegistry = Pick<ExtensionAPI, "getAllTools">;

const PASCAL_TOOLS: RequiredDependencyNames = {
	ask: ASK_USER_QUESTION_TOOL,
	todo: TODO_WRITE_TOOL,
};

const SNAKE_TOOLS: RequiredDependencyNames = {
	ask: ASK_USER_QUESTION_TOOL_SNAKE,
	todo: TODO_WRITE_TOOL_SNAKE,
};

function hasAll(toolNames: Set<string>, required: RequiredDependencyNames): boolean {
	return toolNames.has(required.ask) && toolNames.has(required.todo);
}

function formatMissing(missing: string[]): string {
	if (missing.length === 0) return "none";
	return missing.map((name) => `\`${name}\``).join(", ");
}

function statusFor(
	allToolNames: string[],
	mode: DependencyNamingMode,
	tools: RequiredDependencyNames,
): DependencyStatus {
	return {
		ok: true,
		mode,
		tools,
		missing: [],
		present: [tools.ask, tools.todo],
		allToolNames,
		message: `Required pi-plan dependencies are available: ${tools.ask}, ${tools.todo}.`,
	};
}

export function detectPlanDependencies(allToolNamesInput: Iterable<string>): DependencyStatus {
	const allToolNames = Array.from(new Set(allToolNamesInput)).sort((a, b) => a.localeCompare(b));
	const toolNames = new Set(allToolNames);

	if (hasAll(toolNames, PASCAL_TOOLS)) {
		return statusFor(allToolNames, "pascal", PASCAL_TOOLS);
	}

	if (hasAll(toolNames, SNAKE_TOOLS)) {
		return statusFor(allToolNames, "snake", SNAKE_TOOLS);
	}

	const pascalPresent = [PASCAL_TOOLS.ask, PASCAL_TOOLS.todo].filter((name) => toolNames.has(name));
	const snakePresent = [SNAKE_TOOLS.ask, SNAKE_TOOLS.todo].filter((name) => toolNames.has(name));
	const present = [...pascalPresent, ...snakePresent];

	const missingPascal = [PASCAL_TOOLS.ask, PASCAL_TOOLS.todo].filter((name) => !toolNames.has(name));
	const missingSnake = [SNAKE_TOOLS.ask, SNAKE_TOOLS.todo].filter((name) => !toolNames.has(name));

	const namingConflict = present.length >= 2 && !hasAll(toolNames, PASCAL_TOOLS) && !hasAll(toolNames, SNAKE_TOOLS);
	const missing = namingConflict ? [...missingPascal, ...missingSnake] : missingPascal;

	const message = namingConflict
		? [
				"pi-plan requires pi-ask and pi-todo to use the same tool naming mode.",
				`Found: ${formatMissing(present)}.`,
				`Expected either ${PASCAL_TOOLS.ask} + ${PASCAL_TOOLS.todo} or ${SNAKE_TOOLS.ask} + ${SNAKE_TOOLS.todo}.`,
			].join(" ")
		: [
				"pi-plan is missing required dependency tools.",
				`Missing: ${formatMissing(missing)}.`,
				"Install/load pi-ask and pi-todo before pi-plan.",
			].join(" ");

	return {
		ok: false,
		missing,
		present,
		allToolNames,
		message,
	};
}

export function checkPlanDependencies(pi: ToolRegistry): DependencyStatus {
	return detectPlanDependencies(pi.getAllTools().map((tool) => tool.name));
}

export function assertPlanDependencies(pi: ToolRegistry): RequiredDependencyNames {
	const status = checkPlanDependencies(pi);
	if (!status.ok || !status.tools) {
		throw new Error(status.message);
	}
	return status.tools;
}
