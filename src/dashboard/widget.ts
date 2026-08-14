import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { formatRepoRef, formatResourceRef } from "../refs.js";
import type {
	DashboardItem,
	DashboardScope,
	DashboardSnapshot,
	PrivacyMode,
	ResourceRef,
} from "../types.js";
import type { DashboardStore } from "./store.js";

export function formatRelativeAge(
	timestamp: string | undefined,
	now = Date.now(),
): string {
  if (!timestamp) return "never";
	const seconds = Math.max(
		0,
		Math.floor((now - Date.parse(timestamp)) / 1_000),
	);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function itemReference(item: DashboardItem): string {
	if (item.index === undefined || item.resourceKind === "repository")
		return `${item.server}:${item.owner}/${item.repo}`;
  const ref: ResourceRef = {
    server: item.server,
    owner: item.owner,
    repo: item.repo,
    kind: item.resourceKind,
    index: item.index,
  };
  return formatResourceRef(ref);
}

function healthLabel(
	snapshot: DashboardSnapshot,
	theme: Theme,
): string | undefined {
  const labels = Object.values(snapshot.servers)
		.filter(
			(server) => server.health !== "ready" && server.health !== "loading",
		)
    .map((server) => {
      const state = server.health === "auth-error" ? "auth error" : "error";
      return theme.fg("error", `${server.alias}: ${state}`);
    });
  for (const server of Object.values(snapshot.servers)) {
		if (server.actionsError)
			labels.push(theme.fg("warning", `${server.alias}: CI unavailable`));
  }
  return labels.length > 0 ? labels.join(" | ") : undefined;
}

function snapshotForScope(
	snapshot: DashboardSnapshot,
	scope: DashboardScope,
): DashboardSnapshot {
  const activeServer = snapshot.activeRepo?.server;
	if (scope === "all") return snapshot;
	if (!activeServer) {
		return {
			...snapshot,
			servers: {},
			totals: {
				assignedIssues: 0,
				authoredPulls: 0,
				reviewRequests: 0,
				notifications: 0,
				failedRuns: 0,
			},
			attention: [],
		};
	}
  const server = snapshot.servers[activeServer];
  if (!server) return snapshot;
  return {
    ...snapshot,
    servers: { [activeServer]: server },
    totals: {
      assignedIssues: server.assignedIssues.total,
      authoredPulls: server.authoredPulls.total,
      reviewRequests: server.reviewRequests.total,
      notifications: server.notifications.total,
      failedRuns: server.failedRuns.total,
    },
		attention: snapshot.attention.filter(
			(item) => item.server === activeServer,
		),
  };
}

export function renderDashboardStatus(
  snapshot: DashboardSnapshot,
  privacy: PrivacyMode,
  scope: DashboardScope = "all",
): string {
  const view = snapshotForScope(snapshot, scope);
	const context =
		privacy === "counts-only"
			? "all"
			: view.activeRepo
				? formatRepoRef(view.activeRepo)
				: "all";
	const attention =
		view.totals.reviewRequests +
		view.totals.failedRuns +
		view.totals.notifications;
	let state = `${attention} attention`;
	if (view.backgroundError) state = "refresh failed";
	else if (view.refreshing || !view.fetchedAt) state = "syncing";
  return `fj ${context} · ${state}`;
}

export function renderWidgetLines(
  snapshot: DashboardSnapshot,
  width: number,
  theme: Theme,
  privacy: PrivacyMode,
  scope: DashboardScope = "all",
): string[] {
  const view = snapshotForScope(snapshot, scope);
  const totals = view.totals;
	const active = view.activeRepo
		? formatRepoRef(view.activeRepo)
		: `${Object.keys(view.servers).length} servers`;
	let sync = `synced ${formatRelativeAge(view.fetchedAt)} ago`;
	if (view.backgroundError) sync = "refresh failed";
	else if (view.refreshing) sync = "syncing";
  const issues = `Issues ${totals.assignedIssues}`;
  const pulls = `My Open PRs ${totals.authoredPulls}`;
	const reviews =
		totals.reviewRequests > 0
			? theme.fg("warning", `Reviews ${totals.reviewRequests}`)
			: "Reviews 0";
	const inbox =
		totals.notifications > 0
			? theme.fg("warning", `Inbox ${totals.notifications}`)
			: "Inbox 0";
	const ci =
		totals.failedRuns > 0
			? theme.fg("error", `CI failed ${totals.failedRuns}`)
			: "CI failed 0";

  if (width < 54) {
		const context =
			privacy === "counts-only"
				? "all"
				: view.activeRepo
					? `${view.activeRepo.server}:${view.activeRepo.owner}/${view.activeRepo.repo}`
					: "all";
    const compact = `fj ${context} I:${totals.assignedIssues} P:${totals.authoredPulls} R:${totals.reviewRequests} N:${totals.notifications} C:${totals.failedRuns}`;
    return [truncateToWidth(compact, width)];
  }

  const firstLine = `${theme.fg("accent", theme.bold("Forgejo"))}  ${privacy === "counts-only" ? "all servers" : active}  ${theme.fg("muted", sync)}`;
  const failure = healthLabel(view, theme);
  const secondLine = `${issues} | ${pulls} | ${reviews} | ${inbox} | ${ci}`;
	const lines = [
		truncateToWidth(firstLine, width),
		truncateToWidth(secondLine, width),
	];
  if (width >= 82 && privacy === "full") {
    if (failure) lines.push(truncateToWidth(failure, width));
    else {
      const next = view.attention[0];
      if (next) {
        const action =
					next.kind === "review"
						? "review"
						: next.kind === "ci-failed"
							? "CI failed"
							: next.kind === "assigned"
								? "assigned"
								: "notification";
				lines.push(
					truncateToWidth(
						`${theme.fg("muted", "Next:")} ${action} ${itemReference(next)} - ${next.title}`,
						width,
					),
				);
      }
    }
  }
  return lines;
}

export class DashboardWidget implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: DashboardStore,
    private readonly theme: Theme,
    private readonly privacy: PrivacyMode,
    private readonly scope: DashboardScope,
    private readonly requestRender: () => void,
  ) {
    this.unsubscribe = store.subscribe(() => {
      this.invalidate();
      this.requestRender();
    });
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
		this.cachedLines = renderWidgetLines(
			this.store.snapshot(),
			width,
			this.theme,
			this.privacy,
			this.scope,
		);
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  close(): void {
    this.unsubscribe();
  }
}
