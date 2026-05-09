const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|dedupe|rebuild)/i,
	/\byarn\s+(add|remove|install|publish|upgrade|dlx)/i,
	/\bpnpm\s+(add|remove|install|publish|update|dlx)/i,
	/\bbun\s+(add|remove|install|update)/i,
	/\bpip\w*\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade|update|tap|untap)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone|apply|am|bisect)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable|reload)/i,
	/\bservice\s+\S+\s+(start|stop|restart|reload)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_SEGMENT_PATTERNS = [
	/^\s*pwd\b/i,
	/^\s*ls\b/i,
	/^\s*eza\b/i,
	/^\s*tree\b/i,
	/^\s*find\b/i,
	/^\s*fd\b/i,
	/^\s*rg\b/i,
	/^\s*grep\b/i,
	/^\s*cat\b/i,
	/^\s*head\b/i,
	/^\s*tail\b/i,
	/^\s*less\b/i,
	/^\s*more\b/i,
	/^\s*wc\b/i,
	/^\s*sort\b/i,
	/^\s*uniq\b/i,
	/^\s*diff\b/i,
	/^\s*file\b/i,
	/^\s*stat\b/i,
	/^\s*du\b/i,
	/^\s*df\b/i,
	/^\s*which\b/i,
	/^\s*whereis\b/i,
	/^\s*type\b/i,
	/^\s*env\b/i,
	/^\s*printenv\b/i,
	/^\s*uname\b/i,
	/^\s*whoami\b/i,
	/^\s*id\b/i,
	/^\s*date\b/i,
	/^\s*cal\b/i,
	/^\s*uptime\b/i,
	/^\s*ps\b/i,
	/^\s*top\b/i,
	/^\s*htop\b/i,
	/^\s*free\b/i,
	/^\s*echo\b/i,
	/^\s*printf\b/i,
	/^\s*jq\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*awk\b/i,
	/^\s*bat\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|ls-tree|grep|describe|rev-parse|symbolic-ref)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*pnpm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*node\s+--version\b/i,
	/^\s*node\s+-v\b/i,
	/^\s*python3?\s+--version\b/i,
	/^\s*python3?\s+-V\b/i,
	/^\s*curl\s+(-I|--head|--version)\b/i,
	/^\s*wget\s+(-O\s*-|--spider|--version)\b/i,
];

function stripQuotedText(command: string): string {
	return command
		.replace(/'([^'\\]|\\.)*'/g, "''")
		.replace(/"([^"\\]|\\.)*"/g, '""')
		.replace(/`([^`\\]|\\.)*`/g, "``");
}

function splitShellSegments(command: string): string[] {
	return stripQuotedText(command)
		.split(/\s*(?:&&|\|\||;|\||\n+)\s*/g)
		.map((segment) => segment.trim())
		.filter(Boolean);
}

export interface BashSafetyResult {
	safe: boolean;
	reason?: string;
}

export function checkBashSafety(command: string): BashSafetyResult {
	const trimmed = command.trim();
	if (!trimmed) return { safe: false, reason: "empty command" };

	const stripped = stripQuotedText(trimmed);
	const destructive = DESTRUCTIVE_PATTERNS.find((pattern) => pattern.test(stripped));
	if (destructive) {
		return { safe: false, reason: "command matches a destructive or mutating pattern" };
	}

	const segments = splitShellSegments(trimmed);
	if (segments.length === 0) return { safe: false, reason: "empty command" };

	const unsafeSegment = segments.find((segment) => !SAFE_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment)));
	if (unsafeSegment) {
		return { safe: false, reason: `command segment is not allowlisted: ${unsafeSegment}` };
	}

	return { safe: true };
}

export function isSafeBashCommand(command: string): boolean {
	return checkBashSafety(command).safe;
}
