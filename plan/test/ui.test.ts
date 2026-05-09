import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestPlanApproval } from "../src/ui.js";
import type { ActivePlanState } from "../src/types.js";

function state(): ActivePlanState {
	return {
		version: 1,
		mode: "planning",
		planId: "plan-id",
		slug: "plan",
		planFilePath: "/tmp/pi-plan/plan.md",
		projectKey: "project",
		cwd: "/tmp/project",
		sessionId: "session",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		previousActiveTools: ["read", "bash"],
		dependencyTools: { ask: "AskUserQuestion", todo: "TodoWrite" },
		planSnapshot: "# Plan\n",
		entryReason: "command",
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("requestPlanApproval auto-approves when the timer elapses without input", async () => {
	const ctx = {
		hasUI: true,
		ui: {
			notify: () => undefined,
			select: async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
				return await new Promise<string | undefined>((resolve) => {
					if (opts?.signal?.aborted) {
						resolve(undefined);
						return;
					}
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				});
			},
			confirm: async () => true,
			editor: async () => "unused",
		},
	} as unknown as ExtensionContext;

	const result = await requestPlanApproval(ctx, state(), "# Plan\n", {
		autoApproveTimeoutMs: 5,
		useCustomApprovalDialog: false,
	});

	assert.equal(result.action, "approve");
	assert.equal(result.action === "approve" ? result.autoApproved : undefined, true);
});

test("requestPlanApproval stops the auto-approval timer on user input", async () => {
	let terminalHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	let selectSignal: AbortSignal | undefined;
	let unsubscribed = false;

	const ctx = {
		hasUI: true,
		ui: {
			notify: () => undefined,
			onTerminalInput: (handler: typeof terminalHandler) => {
				terminalHandler = handler;
				return () => {
					unsubscribed = true;
					terminalHandler = undefined;
				};
			},
			select: async (_title: string, _options: string[], opts?: { signal?: AbortSignal }) => {
				selectSignal = opts?.signal;
				setTimeout(() => terminalHandler?.("x"), 5);
				await delay(40);
				assert.equal(selectSignal?.aborted, false);
				return "Reject and keep planning";
			},
			confirm: async () => true,
			editor: async () => "Please add tests.",
		},
	} as unknown as ExtensionContext;

	const result = await requestPlanApproval(ctx, state(), "# Plan\n", {
		autoApproveTimeoutMs: 20,
		useCustomApprovalDialog: false,
	});

	assert.equal(result.action, "reject");
	assert.equal(result.action === "reject" ? result.feedback : undefined, "Please add tests.");
	assert.equal(unsubscribed, true);
});
