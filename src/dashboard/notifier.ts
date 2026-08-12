import { formatResourceRef } from "../refs.js";
import type { DashboardItem, NotificationLevel, ResourceRef } from "../types.js";
import { DashboardStore } from "./store.js";

export type NotifyUser = (message: string, level: "info" | "warning" | "error") => void;

function referenceFor(item: DashboardItem): string {
  if (item.index === undefined || item.resourceKind === "repository") return `${item.server}:${item.owner}/${item.repo}`;
  const ref: ResourceRef = {
    server: item.server,
    owner: item.owner,
    repo: item.repo,
    kind: item.resourceKind,
    index: item.index,
  };
  return formatResourceRef(ref);
}

export class DashboardNotifier {
  private readonly seen = new Set<string>();
  private initialized = false;
  private readonly unsubscribe: () => void;

  constructor(
    store: DashboardStore,
    private readonly level: NotificationLevel,
    private readonly notify: NotifyUser,
  ) {
    this.unsubscribe = store.subscribe(() => {
      const snapshot = store.snapshot();
      if (snapshot.refreshing || !snapshot.fetchedAt) return;
      const reviews = Object.values(snapshot.servers).flatMap((server) => server.reviewRequests.items);
      const failedRuns = Object.values(snapshot.servers).flatMap((server) => server.failedRuns.items);
      const notifications = Object.values(snapshot.servers).flatMap((server) => server.notifications.items);
      const important = [...reviews, ...failedRuns];
      const candidates = this.level === "off" ? [] : this.level === "all" ? [...important, ...notifications] : important;
      if (!this.initialized) {
        for (const item of candidates) this.seen.add(item.key);
        this.initialized = true;
        return;
      }
      const newItems = candidates.filter((item) => !this.seen.has(item.key));
      for (const item of candidates) this.seen.add(item.key);
      if (this.level === "off" || newItems.length === 0) return;
      for (const item of newItems.slice(0, 3)) {
        const label =
          item.kind === "review" ? "new review request" : item.kind === "ci-failed" ? "failed CI run" : "new notification";
        this.notify(`Forgejo ${label}: ${referenceFor(item)} - ${item.title}`, item.kind === "notification" ? "info" : "warning");
      }
      if (newItems.length > 3) this.notify(`Forgejo: ${newItems.length - 3} more new items`, "info");
    });
  }

  close(): void {
    this.unsubscribe();
  }
}
