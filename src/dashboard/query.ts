import { latestFailedActionRuns, listActionRuns } from "../actions.js";
import { apiPath, ForgejoClient } from "../client.js";
import type {
  DashboardCollection,
  DashboardItem,
  ForgejoActionRun,
  ForgejoIssue,
  ForgejoNotification,
  ForgejoRepository,
  ForgejoUser,
  RepoRef,
  ServerDashboard,
} from "../types.js";

function repositoryParts(repository: ForgejoRepository | undefined, repositoryUrl: string | undefined): { owner: string; repo: string } | undefined {
  if (repository?.full_name) {
    const separator = repository.full_name.indexOf("/");
    if (separator > 0 && separator < repository.full_name.length - 1) {
      return {
        owner: repository.full_name.slice(0, separator),
        repo: repository.full_name.slice(separator + 1),
      };
    }
  }
  if (!repositoryUrl) return undefined;
  const match = /\/repos\/([^/]+)\/([^/?#]+)\/?$/.exec(repositoryUrl);
  if (!match?.[1] || !match[2]) return undefined;
  return { owner: decodeURIComponent(match[1]), repo: decodeURIComponent(match[2]) };
}

function issueItem(issue: ForgejoIssue, server: string, kind: "assigned" | "authored-pull" | "review"): DashboardItem | undefined {
  const repository = repositoryParts(issue.repository, issue.repository_url);
  if (!repository) return undefined;
  const resourceKind = kind === "assigned" ? "issue" : "pull";
  return {
    key: `${server}:${repository.owner}/${repository.repo}:${resourceKind}:${issue.number}:${kind}`,
    server,
    owner: repository.owner,
    repo: repository.repo,
    kind,
    resourceKind,
    index: issue.number,
    title: issue.title,
    updatedAt: issue.updated_at,
    webUrl: issue.html_url,
  };
}

function notificationIndex(notification: ForgejoNotification): number | undefined {
  const source = notification.subject.url ?? notification.subject.latest_comment_url;
  if (!source) return undefined;
  const matches = source.match(/\/(?:issues|pulls)\/(\d+)(?:\/|$)/);
  return matches?.[1] ? Number(matches[1]) : undefined;
}

function notificationItem(notification: ForgejoNotification, server: string, baseUrl: string): DashboardItem | undefined {
  const repository = repositoryParts(notification.repository, undefined);
  if (!repository) return undefined;
  const subjectType = notification.subject.type.toLowerCase();
  const resourceKind = subjectType === "pull" ? "pull" : subjectType === "issue" ? "issue" : "repository";
  const index = notificationIndex(notification);
  let webUrl = notification.subject.html_url ?? notification.repository.html_url;
  if (!notification.subject.html_url && resourceKind !== "repository" && index !== undefined) {
    webUrl = `${baseUrl}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${resourceKind === "pull" ? "pulls" : "issues"}/${index}`;
  }
  const item: DashboardItem = {
    key: `${server}:notification:${notification.id}:${notification.updated_at}`,
    server,
    owner: repository.owner,
    repo: repository.repo,
    kind: "notification",
    resourceKind,
    title: notification.subject.title,
    updatedAt: notification.updated_at,
    webUrl,
    unread: notification.unread,
    sourceId: notification.id,
  };
  if (index !== undefined) item.index = index;
  return item;
}

function actionRunItem(run: ForgejoActionRun, repo: RepoRef, baseUrl: string): DashboardItem {
  return {
    key: `${repo.server}:actions:${run.id}`,
    server: repo.server,
    owner: repo.owner,
    repo: repo.repo,
    kind: "ci-failed",
    resourceKind: "repository",
    title: `${run.workflow_id}: ${run.title}`,
    updatedAt: run.updated,
    webUrl:
      run.html_url ||
      `${baseUrl}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/actions/runs/${run.index_in_repo}`,
    sourceId: run.id,
  };
}

async function queryLatestFailedRuns(
  client: ForgejoClient,
  repo: RepoRef | undefined,
  previewLimit: number,
  signal?: AbortSignal,
): Promise<{ collection: DashboardCollection; error?: string }> {
  if (!repo || repo.server !== client.alias) return { collection: { total: 0, items: [] } };
  try {
    const page = await listActionRuns(client, repo, { page: 1, limit: 50 }, signal);
    const failures = latestFailedActionRuns(page.runs);
    return {
      collection: {
        total: failures.length,
        items: failures.slice(0, previewLimit).map((run) => actionRunItem(run, repo, client.config.baseUrl)),
      },
    };
  } catch (error) {
    return {
      collection: { total: 0, items: [] },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function collection<T>(data: T[], totalCount: number | undefined, mapper: (value: T) => DashboardItem | undefined): DashboardCollection {
  return {
    total: totalCount ?? data.length,
    items: data.map(mapper).filter((item): item is DashboardItem => item !== undefined),
  };
}

function openIssueCollection(
  data: ForgejoIssue[],
  totalCount: number | undefined,
  mapper: (value: ForgejoIssue) => DashboardItem | undefined,
): DashboardCollection {
  const open = data.filter((issue) => issue.state.toLowerCase() === "open");
  return collection(open, open.length === data.length ? totalCount : undefined, mapper);
}


export async function queryServerDashboard(
  client: ForgejoClient,
  previewLimit: number,
  signal?: AbortSignal,
  identity?: ForgejoUser,
  activeRepo?: RepoRef,
): Promise<ServerDashboard> {
  const common = { state: "open", limit: previewLimit, page: 1 } as const;
  const requestOptions = signal === undefined ? {} : { signal };
  const identityPromise = identity
    ? Promise.resolve(identity)
    : client.request<ForgejoUser>("user", requestOptions).then((result) => result.data);
  const [currentUser, assigned, authored, reviews, notifications, failedRuns] = await Promise.all([
    identityPromise,
    client.request<ForgejoIssue[]>("repos/issues/search", {
      ...requestOptions,
      query: { ...common, type: "issues", assigned: true },
    }),
    client.request<ForgejoIssue[]>("repos/issues/search", {
      ...requestOptions,
      query: { ...common, type: "pulls", created: true },
    }),
    client.request<ForgejoIssue[]>("repos/issues/search", {
      ...requestOptions,
      query: { ...common, type: "pulls", review_requested: true },
    }),
    client.request<ForgejoNotification[]>("notifications", {
      ...requestOptions,
      query: { "status-types": ["unread"], limit: previewLimit, page: 1 },
    }),
    queryLatestFailedRuns(client, activeRepo, previewLimit, signal),
  ]);

  const dashboard: ServerDashboard = {
    alias: client.alias,
    health: "ready",
    fetchedAt: new Date().toISOString(),
    identity: currentUser,
    assignedIssues: openIssueCollection(assigned.data, assigned.totalCount, (issue) => issueItem(issue, client.alias, "assigned")),
    authoredPulls: openIssueCollection(authored.data, authored.totalCount, (issue) => issueItem(issue, client.alias, "authored-pull")),
    reviewRequests: openIssueCollection(reviews.data, reviews.totalCount, (issue) => issueItem(issue, client.alias, "review")),
    notifications: collection(notifications.data, notifications.totalCount, (notification) =>
      notificationItem(notification, client.alias, client.config.baseUrl),
    ),
    failedRuns: failedRuns.collection,
  };
  if (failedRuns.error) dashboard.actionsError = failedRuns.error;
  return dashboard;
}

export async function markNotificationRead(client: ForgejoClient, id: number, signal?: AbortSignal): Promise<void> {
  const options = signal === undefined ? {} : { signal };
  await client.request(apiPath("notifications", "threads", id), {
    ...options,
    method: "PATCH",
    query: { "to-status": "read" },
  });
}
