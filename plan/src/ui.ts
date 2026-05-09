import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ActivePlanState } from "./types.js";

export const PLAN_APPROVAL_AUTO_APPROVE_MS = 60_000;

const APPROVE = "Approve and start implementation";
const EDIT = "Edit plan before approving";
const REJECT = "Reject and keep planning";
const CANCEL = "Cancel";
const APPROVAL_OPTIONS = [APPROVE, EDIT, REJECT, CANCEL] as const;

type ApprovalChoice = (typeof APPROVAL_OPTIONS)[number];

type TimedApprovalSelection = {
	choice: ApprovalChoice | undefined;
	autoApproved: boolean;
};

export interface PlanApprovalOptions {
	/** Override for tests or future configuration. Defaults to 60 seconds. Set <= 0 to disable. */
	autoApproveTimeoutMs?: number;
	/** Prefer the custom interactive selector when available. Primarily useful to disable in tests. */
	useCustomApprovalDialog?: boolean;
}

export type EmptyPlanConfirmationResult =
	| { status: "confirmed" }
	| { status: "declined" }
	| { status: "unavailable"; message: string };

export type PlanApprovalResult =
	| { action: "approve"; plan: string; autoApproved?: boolean }
	| { action: "reject"; plan: string; feedback: string }
	| { action: "cancel"; plan: string; message?: string }
	| { action: "unavailable"; plan: string; message: string };

export function isPlanContentEmpty(plan: string): boolean {
	return plan.trim().length === 0;
}

function uiUnavailableMessage(error: unknown, operation: string): string {
	if (error instanceof Error && error.message.trim()) {
		return `Plan approval UI is unavailable while trying to ${operation}: ${error.message}`;
	}
	return `Plan approval UI is unavailable while trying to ${operation}.`;
}

function approvalOptions(): string[] {
	return [...APPROVAL_OPTIONS];
}

function isApprovalChoice(choice: string | undefined): choice is ApprovalChoice {
	return APPROVAL_OPTIONS.some((option) => option === choice);
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function remainingSeconds(deadlineMs: number): number {
	return Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
}

class TimedPlanApprovalSelector extends Container {
	private readonly titleText: Text;
	private readonly listContainer: Container;
	private readonly helpText: Text;
	private readonly deadlineMs: number;
	private selectedIndex = 0;
	private timerActive = true;
	private completed = false;
	private timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	private intervalHandle: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly timeoutMs: number,
		private readonly done: (result: TimedApprovalSelection) => void,
	) {
		super();
		this.deadlineMs = Date.now() + timeoutMs;
		this.titleText = new Text("", 1, 0);
		this.listContainer = new Container();
		this.helpText = new Text("", 1, 0);

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.helpText);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateTitle();
		this.updateList();
		this.startTimer();
	}

	private startTimer(): void {
		this.timeoutHandle = setTimeout(() => {
			this.finish({ choice: APPROVE, autoApproved: true });
		}, this.timeoutMs);
		this.intervalHandle = setInterval(() => {
			this.updateTitle();
			this.tui.requestRender();
		}, 250);
	}

	private clearTimer(): void {
		if (this.timeoutHandle) {
			clearTimeout(this.timeoutHandle);
			this.timeoutHandle = undefined;
		}
		if (this.intervalHandle) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = undefined;
		}
	}

	private stopTimerForUserInput(): void {
		if (!this.timerActive) return;
		this.timerActive = false;
		this.clearTimer();
		this.updateTitle();
		this.tui.requestRender();
	}

	private updateTitle(): void {
		const title = this.timerActive
			? `Review plan (auto-approves in ${remainingSeconds(this.deadlineMs)}s; press any key to pause)`
			: "Review plan (auto-approval paused)";
		this.titleText.setText(this.theme.fg("accent", this.theme.bold(title)));
		this.helpText.setText(
			this.theme.fg("dim", "↑↓/j/k navigate • enter select • esc cancel • any key pauses auto-approval"),
		);
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < APPROVAL_OPTIONS.length; i++) {
			const option = APPROVAL_OPTIONS[i];
			const isSelected = i === this.selectedIndex;
			const line = isSelected
				? `${this.theme.fg("accent", "→")} ${this.theme.fg("accent", option)}`
				: `  ${this.theme.fg("text", option)}`;
			this.listContainer.addChild(new Text(line, 1, 0));
		}
	}

	private finish(result: TimedApprovalSelection): void {
		if (this.completed) return;
		this.completed = true;
		this.clearTimer();
		this.done(result);
	}

	handleInput(data: string): void {
		this.stopTimerForUserInput();

		if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			this.selectedIndex = Math.min(APPROVAL_OPTIONS.length - 1, this.selectedIndex + 1);
			this.updateList();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n" || data === "\r") {
			this.finish({ choice: APPROVAL_OPTIONS[this.selectedIndex], autoApproved: false });
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.finish({ choice: undefined, autoApproved: false });
		}
	}

	dispose(): void {
		this.clearTimer();
	}
}

async function selectApprovalWithoutTimer(ctx: ExtensionContext): Promise<TimedApprovalSelection> {
	const choice = await ctx.ui.select("Review plan", approvalOptions());
	return { choice: isApprovalChoice(choice) ? choice : undefined, autoApproved: false };
}

async function selectApprovalWithPrimitiveTimer(
	ctx: ExtensionContext,
	timeoutMs: number,
): Promise<TimedApprovalSelection> {
	const controller = new AbortController();
	let timedOut = false;
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let timerStopped = false;

	const clearTimer = () => {
		if (!timeoutHandle) return;
		clearTimeout(timeoutHandle);
		timeoutHandle = undefined;
	};
	const stopTimer = () => {
		if (timerStopped) return;
		timerStopped = true;
		clearTimer();
	};

	const onTerminalInput = (ctx.ui as Partial<Pick<ExtensionContext["ui"], "onTerminalInput">>).onTerminalInput;
	const unsubscribe =
		typeof onTerminalInput === "function"
			? onTerminalInput((data) => {
					if (data.length > 0) stopTimer();
					return undefined;
				})
			: undefined;

	timeoutHandle = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	try {
		const choice = await ctx.ui.select(
			`Review plan (auto-approves in ${formatDuration(timeoutMs)} if there is no input)`,
			approvalOptions(),
			{ signal: controller.signal },
		);
		if (timedOut) return { choice: APPROVE, autoApproved: true };
		return { choice: isApprovalChoice(choice) ? choice : undefined, autoApproved: false };
	} catch (error) {
		if (timedOut) return { choice: APPROVE, autoApproved: true };
		throw error;
	} finally {
		clearTimer();
		unsubscribe?.();
	}
}

async function selectApprovalWithCustomTimer(
	ctx: ExtensionContext,
	timeoutMs: number,
): Promise<TimedApprovalSelection | undefined> {
	const custom = (ctx.ui as Partial<Pick<ExtensionContext["ui"], "custom">>).custom;
	if (typeof custom !== "function") return undefined;

	return await custom<TimedApprovalSelection | undefined>((tui, theme, keybindings, done) => {
		return new TimedPlanApprovalSelector(tui, theme, keybindings, timeoutMs, done);
	});
}

async function selectApprovalChoice(
	ctx: ExtensionContext,
	options: { timeoutMs: number; useCustomApprovalDialog: boolean },
): Promise<TimedApprovalSelection> {
	if (options.timeoutMs <= 0) return selectApprovalWithoutTimer(ctx);

	if (options.useCustomApprovalDialog) {
		try {
			const customResult = await selectApprovalWithCustomTimer(ctx, options.timeoutMs);
			if (customResult) return customResult;
		} catch {
			// Fall back to primitive dialogs if custom UI is unavailable or fails.
		}
	}

	return selectApprovalWithPrimitiveTimer(ctx, options.timeoutMs);
}

export async function askEmptyPlanConfirmation(ctx: ExtensionContext): Promise<EmptyPlanConfirmationResult> {
	try {
		const confirmed = await ctx.ui.confirm(
			"Empty plan file",
			"The plan file is empty. Approving an empty plan is unusual. Approve anyway?",
		);
		return confirmed ? { status: "confirmed" } : { status: "declined" };
	} catch (error) {
		return { status: "unavailable", message: uiUnavailableMessage(error, "confirm empty-plan approval") };
	}
}

export async function requestPlanApproval(
	ctx: ExtensionContext,
	state: ActivePlanState,
	initialPlan: string,
	options: PlanApprovalOptions = {},
): Promise<PlanApprovalResult> {
	let plan = initialPlan;
	const configuredTimeoutMs = options.autoApproveTimeoutMs ?? PLAN_APPROVAL_AUTO_APPROVE_MS;
	let autoApproveAllowed = configuredTimeoutMs > 0;

	while (true) {
		try {
			const timerNotice = autoApproveAllowed
				? `\n\nAuto-approves in ${formatDuration(configuredTimeoutMs)} if there is no user input. Press any key in the approval prompt to pause the timer.`
				: "";
			ctx.ui.notify(`Plan ready for approval.${timerNotice}\n\nPlan file: ${state.planFilePath}\n\n${plan}`, "info");
		} catch {
			// notify is best-effort. RPC clients may ignore it; approval uses select/editor below.
		}

		let selection: TimedApprovalSelection;
		try {
			selection = await selectApprovalChoice(ctx, {
				timeoutMs: autoApproveAllowed ? configuredTimeoutMs : 0,
				useCustomApprovalDialog: options.useCustomApprovalDialog ?? true,
			});
		} catch (error) {
			return { action: "unavailable", plan, message: uiUnavailableMessage(error, "request plan approval") };
		}

		const choice = selection.choice;
		if (!selection.autoApproved) autoApproveAllowed = false;

		if (choice === APPROVE) return { action: "approve", plan, autoApproved: selection.autoApproved };
		if (choice === CANCEL || choice === undefined) return { action: "cancel", plan, message: "Plan approval was cancelled." };

		if (choice === EDIT) {
			let edited: string | undefined;
			try {
				edited = await ctx.ui.editor("Edit plan before approval", plan);
			} catch (error) {
				return { action: "unavailable", plan, message: uiUnavailableMessage(error, "edit the plan before approval") };
			}
			if (edited === undefined) return { action: "cancel", plan, message: "Plan edit was cancelled." };
			plan = edited;
			continue;
		}

		if (choice === REJECT) {
			let feedback: string | undefined;
			try {
				feedback = await ctx.ui.editor("Feedback for plan rejection", "");
			} catch (error) {
				return { action: "unavailable", plan, message: uiUnavailableMessage(error, "collect plan rejection feedback") };
			}
			return {
				action: "reject",
				plan,
				feedback: feedback?.trim() || "No feedback provided.",
			};
		}
	}
}
