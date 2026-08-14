import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { formatResourceRef } from "../refs.js";
import type { DashboardItem, ResourceRef } from "../types.js";
import type { DashboardStore } from "./store.js";
import { formatRelativeAge } from "./widget.js";

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

function allDashboardItems(store: DashboardStore): DashboardItem[] {
  const snapshot = store.snapshot();
  const items = [
    ...snapshot.attention,
		...Object.values(snapshot.servers).flatMap(
			(server) => server.authoredPulls.items,
		),
  ];
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.server}:${item.owner}/${item.repo}:${item.resourceKind}:${item.index ?? item.key}:${item.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class DashboardOverlay implements Component {
  private selected = 0;
  private filterIndex = 0;
  private status?: string;
  private items: DashboardItem[] = [];
  private readonly filters: string[];
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: DashboardStore,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly onSelect: (reference: string) => void,
    private readonly onClose: () => void,
		private readonly onOpen: (item: DashboardItem) => Promise<void>,
    private readonly onRefresh: () => Promise<void>,
    private readonly onMarkRead: (item: DashboardItem) => Promise<void>,
    initialFilter?: string,
  ) {
    this.filters = ["all", "current", ...Object.keys(store.snapshot().servers)];
		const requestedFilter = initialFilter
			? this.filters.indexOf(initialFilter)
			: -1;
    if (requestedFilter >= 0) this.filterIndex = requestedFilter;
    this.rebuildItems();
    this.unsubscribe = store.subscribe(() => {
      this.rebuildItems();
      this.requestRender();
    });
  }

  private rebuildItems(): void {
    const filter = this.filters[this.filterIndex] ?? "all";
    const activeRepo = this.store.snapshot().activeRepo;
    this.items = allDashboardItems(this.store).filter((item) => {
      if (filter === "all") return true;
      if (filter === "current") {
				return Boolean(
					activeRepo &&
						item.server === activeRepo.server &&
						item.owner === activeRepo.owner &&
						item.repo === activeRepo.repo,
				);
      }
      return item.server === filter;
    });
    this.selected = Math.max(0, Math.min(this.selected, this.items.length - 1));
  }

  private runAction(action: () => Promise<void>, success: string): void {
    this.status = "working...";
    this.requestRender();
    void action()
      .then(() => {
        this.status = success;
        this.requestRender();
      })
      .catch((error: unknown) => {
        this.status = error instanceof Error ? error.message : String(error);
        this.requestRender();
      });
  }

  handleInput(data: string): void {
    if ((matchesKey(data, Key.up) || data === "k") && this.selected > 0) {
      this.selected -= 1;
      this.requestRender();
      return;
    }
		if (
			(matchesKey(data, Key.down) || data === "j") &&
			this.selected < this.items.length - 1
		) {
      this.selected += 1;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.filterIndex = (this.filterIndex + 1) % this.filters.length;
      this.rebuildItems();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const item = this.items[this.selected];
      if (item) this.onSelect(itemReference(item));
      return;
    }
    if (data === "o") {
      const item = this.items[this.selected];
			if (item) this.runAction(() => this.onOpen(item), "opened in browser");
      return;
    }
    if (data === "r") {
      this.runAction(this.onRefresh, "dashboard refreshed");
      return;
    }
    if (data === "m") {
      const item = this.items[this.selected];
      if (item?.kind === "notification" && item.sourceId !== undefined) {
        this.runAction(() => this.onMarkRead(item), "notification marked read");
      }
      return;
    }
    if (matchesKey(data, Key.escape)) this.onClose();
  }

  render(width: number): string[] {
    const snapshot = this.store.snapshot();
    const filter = this.filters[this.filterIndex] ?? "all";
    const title = `${this.theme.fg("accent", this.theme.bold("Forgejo Dashboard"))}  ${this.theme.fg("muted", `[${filter}]`)}`;
    const lines = [truncateToWidth(title, width), ""];
    if (this.items.length === 0) {
			lines.push(
				this.theme.fg(
					"muted",
					"No matching assigned issues, pull requests, reviews, CI failures, or notifications.",
				),
			);
    } else {
      const maxRows = 12;
			const start = Math.max(
				0,
				Math.min(
					this.selected - Math.floor(maxRows / 2),
					this.items.length - maxRows,
				),
			);
			for (
				let index = start;
				index < Math.min(start + maxRows, this.items.length);
				index += 1
			) {
        const item = this.items[index];
        if (!item) continue;
        const selected = index === this.selected;
        const marker = selected ? "> " : "  ";
        const kind = item.kind === "authored-pull" ? "my-pr" : item.kind;
        const text = `${marker}[${kind}] ${itemReference(item)}  ${item.title}  ${formatRelativeAge(item.updatedAt)}`;
				lines.push(
					truncateToWidth(
						selected ? this.theme.fg("accent", text) : text,
						width,
					),
				);
      }
    }
    lines.push("");
    const totals = snapshot.totals;
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "muted",
          `${totals.reviewRequests} reviews | ${totals.assignedIssues} issues | ${totals.authoredPulls} open PRs | ${totals.failedRuns} CI failed | ${totals.notifications} unread`,
        ),
        width,
      ),
    );
		if (this.status)
			lines.push(truncateToWidth(this.theme.fg("warning", this.status), width));
		lines.push(
			truncateToWidth(
				this.theme.fg(
					"dim",
					"↑↓/jk navigate • tab filter • enter insert • o open • m read • r refresh • esc close",
				),
				width,
			),
		);
    return lines;
  }

  invalidate(): void {}

  close(): void {
    this.unsubscribe();
  }
}
