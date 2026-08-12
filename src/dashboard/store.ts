import { ForgejoClientPool, ForgejoError } from "../client.js";
import { CredentialError } from "../credentials.js";
import { queryServerDashboard } from "./query.js";
import type {
  DashboardCollection,
  DashboardItem,
  DashboardItemKind,
  DashboardSnapshot,
  DashboardTotals,
  ForgejoUser,
  RepoRef,
  ServerDashboard,
} from "../types.js";

const EMPTY_COLLECTION: DashboardCollection = { total: 0, items: [] };
const PRIORITY_BY_KIND: Record<DashboardItemKind, number> = {
  review: 0,
  "ci-failed": 1,
  notification: 2,
  assigned: 3,
  "authored-pull": 4,
};

function initialServer(alias: string): ServerDashboard {
  return {
    alias,
    health: "loading",
    assignedIssues: { ...EMPTY_COLLECTION },
    authoredPulls: { ...EMPTY_COLLECTION },
    reviewRequests: { ...EMPTY_COLLECTION },
    notifications: { ...EMPTY_COLLECTION },
    failedRuns: { ...EMPTY_COLLECTION },
  };
}

function sameRepo(item: DashboardItem, repo: RepoRef | undefined): boolean {
  return Boolean(repo && item.server === repo.server && item.owner === repo.owner && item.repo === repo.repo);
}

function attentionItems(servers: Record<string, ServerDashboard>, activeRepo: RepoRef | undefined): DashboardItem[] {
  const unique = new Map<string, DashboardItem>();
  for (const server of Object.values(servers)) {
    const candidates = [...server.reviewRequests.items, ...server.failedRuns.items, ...server.notifications.items, ...server.assignedIssues.items];
    for (const item of candidates) {
      const identity = `${item.server}:${item.owner}/${item.repo}:${item.resourceKind}:${item.index ?? item.key}`;
      const current = unique.get(identity);
      if (!current || PRIORITY_BY_KIND[item.kind] < PRIORITY_BY_KIND[current.kind]) unique.set(identity, item);
    }
  }
  return [...unique.values()].sort((left, right) => {
    const activeDifference = Number(sameRepo(right, activeRepo)) - Number(sameRepo(left, activeRepo));
    if (activeDifference !== 0) return activeDifference;
    const priorityDifference = PRIORITY_BY_KIND[left.kind] - PRIORITY_BY_KIND[right.kind];
    if (priorityDifference !== 0) return priorityDifference;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

function totals(servers: Record<string, ServerDashboard>): DashboardTotals {
  const result: DashboardTotals = {
    assignedIssues: 0,
    authoredPulls: 0,
    reviewRequests: 0,
    notifications: 0,
    failedRuns: 0,
  };
  for (const server of Object.values(servers)) {
    result.assignedIssues += server.assignedIssues.total;
    result.authoredPulls += server.authoredPulls.total;
    result.reviewRequests += server.reviewRequests.total;
    result.notifications += server.notifications.total;
    result.failedRuns += server.failedRuns.total;
  }
  return result;
}

export class DashboardStore {
  private snapshotValue: DashboardSnapshot;
  private readonly listeners = new Set<() => void>();
  private controller?: AbortController;
  private generation = 0;
  private closed = false;
  private invalidationVersion = 0;
  private refreshedVersion = 0;

  constructor(
    private readonly clients: ForgejoClientPool,
    private readonly previewLimit: number,
    activeRepo?: RepoRef,
    private readonly identityForServer?: (alias: string) => ForgejoUser | undefined,
  ) {
    const servers = Object.fromEntries(clients.aliases().map((alias) => [alias, initialServer(alias)]));
    this.snapshotValue = {
      servers,
      totals: totals(servers),
      attention: [],
      refreshing: false,
    };
    if (activeRepo) this.snapshotValue.activeRepo = activeRepo;
  }

  snapshot(): DashboardSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setActiveRepo(repo: RepoRef | undefined): void {
    if (repo) this.snapshotValue = { ...this.snapshotValue, activeRepo: repo };
    else {
      const { activeRepo: _removed, ...snapshot } = this.snapshotValue;
      this.snapshotValue = snapshot;
    }
    this.invalidationVersion += 1;
    this.recalculate();
  }

  private recalculate(): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      totals: totals(this.snapshotValue.servers),
      attention: attentionItems(this.snapshotValue.servers, this.snapshotValue.activeRepo),
    };
    for (const listener of this.listeners) listener();
  }

  async ensureFresh(externalSignal?: AbortSignal): Promise<DashboardSnapshot> {
    if (!this.snapshotValue.fetchedAt || this.refreshedVersion !== this.invalidationVersion) {
      return this.refresh(externalSignal);
    }
    return this.snapshotValue;
  }

  async refreshIfObserved(externalSignal?: AbortSignal): Promise<DashboardSnapshot> {
    this.invalidationVersion += 1;
    if (this.listeners.size === 0) return this.snapshotValue;
    return this.refresh(externalSignal);
  }

  async refresh(externalSignal?: AbortSignal): Promise<DashboardSnapshot> {
    if (this.closed) throw new Error("dashboard store is closed");
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort(externalSignal.reason);
      else externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
    }
    const generation = ++this.generation;
    const invalidationVersion = this.invalidationVersion;
    this.snapshotValue = { ...this.snapshotValue, refreshing: true };
    this.recalculate();

    await Promise.all(
      this.clients.entries().map(async ([alias, client]) => {
        try {
          const identity = this.identityForServer?.(alias);
          const dashboard = await queryServerDashboard(
            client,
            this.previewLimit,
            controller.signal,
            identity,
            this.snapshotValue.activeRepo,
          );
          if (generation !== this.generation || controller.signal.aborted) return;
          this.snapshotValue = {
            ...this.snapshotValue,
            servers: { ...this.snapshotValue.servers, [alias]: dashboard },
          };
          this.recalculate();
        } catch (error) {
          if (generation !== this.generation || controller.signal.aborted) return;
          const previous = this.snapshotValue.servers[alias] ?? initialServer(alias);
          const health = previous.fetchedAt
            ? "stale"
            : (error instanceof ForgejoError && error.code === "auth") || error instanceof CredentialError
              ? "auth-error"
              : "error";
          const failed: ServerDashboard = {
            ...previous,
            health,
            error: error instanceof Error ? error.message : String(error),
          };
          if (previous.fetchedAt) failed.staleSince = new Date().toISOString();
          this.snapshotValue = {
            ...this.snapshotValue,
            servers: { ...this.snapshotValue.servers, [alias]: failed },
          };
          this.recalculate();
        }
      }),
    );

    if (generation === this.generation) {
      this.refreshedVersion = invalidationVersion;
      this.snapshotValue = {
        ...this.snapshotValue,
        fetchedAt: new Date().toISOString(),
        refreshing: false,
      };
      this.recalculate();
    }
    return this.snapshotValue;
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
    this.listeners.clear();
  }
}
