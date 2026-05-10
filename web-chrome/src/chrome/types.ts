export interface BrowserVersion {
	protocolVersion?: string;
	product?: string;
	revision?: string;
	userAgent?: string;
	jsVersion?: string;
}

export interface TargetInfo {
	targetId: string;
	type: string;
	title?: string;
	url?: string;
	attached?: boolean;
	browserContextId?: string;
}

export interface TabSummary {
	targetId: string;
	type: string;
	title: string;
	url: string;
	attached: boolean;
	current: boolean;
}

export interface StatusDetails {
	status: string;
	connected: boolean;
	riskyExistingBrowser: boolean;
	managedBrowser: boolean;
	pid?: number;
	endpoint?: string;
	webSocketDebuggerUrl?: string;
	userDataDir?: string;
	profileMode?: string;
	version?: BrowserVersion;
	currentTargetId?: string;
	tabs: TabSummary[];
	message?: string;
}
