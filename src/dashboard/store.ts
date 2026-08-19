import { waitWithSignal } from "../abort.js";
import { type ForgejoClientPool, ForgejoError } from "../client.js";
import { CredentialError } from "../credentials.js";
import { queryServerDashboard } from "./query.js";
import type {
	DashboardCollection,
	DashboardItem,
	DashboardItemKind,
	DashboardSnapshot,
	DashboardTotals,
	DashboardScope,
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
	return Boolean(
		repo &&
			item.server === repo.server &&
			item.owner === repo.owner &&
			item.repo === repo.repo,
	);
}

function sameRepoRef(
	left: RepoRef | undefined,
	right: RepoRef | undefined,
): boolean {
	return (
		left?.server === right?.server &&
		left?.owner === right?.owner &&
		left?.repo === right?.repo
	);
}

function clearFailedRuns(server: ServerDashboard): ServerDashboard {
	const { actionsError: _removed, ...current } = server;
	return { ...current, failedRuns: { ...EMPTY_COLLECTION } };
}

function attentionItems(
	servers: Record<string, ServerDashboard>,
	activeRepo: RepoRef | undefined,
): DashboardItem[] {
	const unique = new Map<string, DashboardItem>();
	for (const server of Object.values(servers)) {
		const candidates = [
			...server.reviewRequests.items,
			...server.failedRuns.items,
			...server.notifications.items,
			...server.assignedIssues.items,
		];
		for (const item of candidates) {
			const identity = `${item.server}:${item.owner}/${item.repo}:${item.resourceKind}:${item.index ?? item.key}`;
			const current = unique.get(identity);
			if (!current || PRIORITY_BY_KIND[item.kind] < PRIORITY_BY_KIND[current.kind])
				unique.set(identity, item);
		}
	}
	return [...unique.values()].sort((left, right) => {
		const activeDifference =
			Number(sameRepo(right, activeRepo)) - Number(sameRepo(left, activeRepo));
		if (activeDifference !== 0) return activeDifference;
		const priorityDifference =
			PRIORITY_BY_KIND[left.kind] - PRIORITY_BY_KIND[right.kind];
		if (priorityDifference !== 0) return priorityDifference;
		return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
	});
}

function scopedAliases(
	clients: ForgejoClientPool,
	scope: DashboardScope,
	activeRepo: RepoRef | undefined,
): string[] {
	if (scope === "all" || !activeRepo) return clients.aliases();
	return [activeRepo.server];
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
	private controller: AbortController | undefined;
	private refreshPromise: Promise<DashboardSnapshot> | undefined;
	private generation = 0;
	private closed = false;
	private invalidationVersion = 0;
	private refreshedVersion = 0;
	private scheduledRefresh: Promise<DashboardSnapshot> | undefined;
	private scope: DashboardScope = "all";

	constructor(
		private readonly clients: ForgejoClientPool,
		private readonly previewLimit: number,
		activeRepo?: RepoRef,
		private readonly identityForServer?: (
			alias: string,
		) => ForgejoUser | undefined,
		private readonly actionsRunsForServer?: (
			alias: string,
		) => "available" | "unavailable" | "unknown",
	) {
		const aliases = scopedAliases(clients, this.scope, activeRepo);
		const servers = Object.fromEntries(
			aliases.map((alias) => [alias, initialServer(alias)]),
		);
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

	private clearActiveRepoData(repo: RepoRef | undefined): void {
		if (sameRepoRef(this.snapshotValue.activeRepo, repo)) return;
		this.snapshotValue = {
			...this.snapshotValue,
			servers: Object.fromEntries(
				Object.entries(this.snapshotValue.servers).map(([alias, server]) => [
					alias,
					clearFailedRuns(server),
				]),
			),
		};
	}

	private resetServersForScope(): void {
		const current = this.snapshotValue.servers;
		this.snapshotValue = {
			...this.snapshotValue,
			servers: Object.fromEntries(
				scopedAliases(this.clients, this.scope, this.snapshotValue.activeRepo).map(
					(alias) => [alias, current[alias] ?? initialServer(alias)],
				),
			),
		};
	}

	setScope(scope: DashboardScope): void {
		if (scope === this.scope) return;
		this.scope = scope;
		this.controller?.abort();
		this.generation += 1;
		this.resetServersForScope();
		this.snapshotValue = { ...this.snapshotValue, refreshing: false };
		this.invalidationVersion += 1;
		this.recalculate();
	}

	setActiveRepo(repo: RepoRef | undefined): void {
		this.controller?.abort();
		this.generation += 1;
		this.clearActiveRepoData(repo);
		if (repo)
			this.snapshotValue = {
				...this.snapshotValue,
				activeRepo: repo,
				refreshing: false,
			};
		else {
			const { activeRepo: _removed, ...snapshot } = this.snapshotValue;
			this.snapshotValue = { ...snapshot, refreshing: false };
		}
		this.resetServersForScope();
		this.invalidationVersion += 1;
		this.recalculate();
	}

	private recalculate(): void {
		this.snapshotValue = {
			...this.snapshotValue,
			totals: totals(this.snapshotValue.servers),
			attention: attentionItems(
				this.snapshotValue.servers,
				this.snapshotValue.activeRepo,
			),
		};
		for (const listener of this.listeners) listener();
	}

	async ensureFresh(externalSignal?: AbortSignal): Promise<DashboardSnapshot> {
		if (
			!this.snapshotValue.fetchedAt ||
			this.refreshedVersion !== this.invalidationVersion
		) {
			return this.refresh(externalSignal);
		}
		return this.snapshotValue;
	}

	async refreshIfObserved(
		_externalSignal?: AbortSignal,
	): Promise<DashboardSnapshot> {
		this.invalidationVersion += 1;
		if (this.listeners.size === 0 || this.closed) return this.snapshotValue;
		if (!this.scheduledRefresh) {
			this.scheduledRefresh = new Promise<void>((resolve) =>
				setTimeout(resolve, 0),
			)
				.then(() => this.refresh())
				.catch((error: unknown) => {
					this.snapshotValue = {
						...this.snapshotValue,
						backgroundError: error instanceof Error ? error.message : String(error),
						refreshing: false,
					};
					this.recalculate();
					return this.snapshotValue;
				})
				.finally(() => {
					this.scheduledRefresh = undefined;
				});
		}
		return this.snapshotValue;
	}

	async refresh(externalSignal?: AbortSignal): Promise<DashboardSnapshot> {
		if (this.closed) throw new Error("dashboard store is closed");
		externalSignal?.throwIfAborted();
		while (!this.closed) {
			if (!this.refreshPromise) {
				let pending: Promise<DashboardSnapshot>;
				pending = this.performRefresh().finally(() => {
					if (this.refreshPromise === pending) this.refreshPromise = undefined;
				});
				this.refreshPromise = pending;
			}
			await waitWithSignal(this.refreshPromise, externalSignal);
			if (this.refreshedVersion === this.invalidationVersion)
				return this.snapshotValue;
		}
		return this.snapshotValue;
	}

	private async performRefresh(): Promise<DashboardSnapshot> {
		const controller = new AbortController();
		this.controller = controller;
		const generation = ++this.generation;
		const invalidationVersion = this.invalidationVersion;
		const activeRepo = this.snapshotValue.activeRepo;
		const aliases = new Set(scopedAliases(this.clients, this.scope, activeRepo));
		this.snapshotValue = { ...this.snapshotValue, refreshing: true };
		this.recalculate();

		try {
			await Promise.all(
				this.clients.entries().map(async ([alias, client]) => {
					if (!aliases.has(alias)) return;
					try {
						const dashboard = await queryServerDashboard(
							client,
							this.previewLimit,
							controller.signal,
							this.identityForServer?.(alias),
							activeRepo,
							this.actionsRunsForServer?.(alias),
						);
						if (generation === this.generation && !controller.signal.aborted) {
							this.snapshotValue = {
								...this.snapshotValue,
								servers: { ...this.snapshotValue.servers, [alias]: dashboard },
							};
							this.recalculate();
						}
					} catch (error) {
						if (generation === this.generation && !controller.signal.aborted) {
							const health =
								(error instanceof ForgejoError && error.code === "auth") ||
								error instanceof CredentialError
									? "auth-error"
									: "error";
							this.snapshotValue = {
								...this.snapshotValue,
								servers: {
									...this.snapshotValue.servers,
									[alias]: {
										...initialServer(alias),
										health,
										error: error instanceof Error ? error.message : String(error),
									},
								},
							};
							this.recalculate();
						}
					}
					return undefined;
				}),
			);

			if (generation === this.generation && !controller.signal.aborted) {
				this.refreshedVersion = invalidationVersion;
				const { backgroundError: _cleared, ...snapshot } = this.snapshotValue;
				this.snapshotValue = {
					...snapshot,
					fetchedAt: new Date().toISOString(),
					refreshing: false,
				};
				this.recalculate();
			} else if (generation === this.generation) {
				this.snapshotValue = { ...this.snapshotValue, refreshing: false };
				this.recalculate();
			}
			return this.snapshotValue;
		} finally {
			if (this.controller === controller) this.controller = undefined;
		}
	}

	close(): void {
		this.closed = true;
		this.controller?.abort();
		this.listeners.clear();
	}
}
