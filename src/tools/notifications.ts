import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { apiPath } from "../client.js";
import type { ForgejoComment, ForgejoNotification } from "../types.js";
import { assertForgejoCommentTarget, boundModelText, confirmMutation, formatForgejoComment, positiveLimit, toolResult, type RuntimeProvider } from "./common.js";

interface NotificationTarget {
  owner: string;
  repo: string;
  index: number;
  kind: "issue" | "pull";
  reference: string;
}

function apiSegments(baseUrl: string, value: string, label: string): string[] {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid absolute URL`);
  }
  if (target.origin !== base.origin) throw new Error(`${label} points outside configured Forgejo origin ${base.origin}`);
  if (target.username || target.password || target.search || target.hash) {
    throw new Error(`${label} contains unsupported credentials, query, or fragment`);
  }
  const prefix = `${base.pathname.replace(/\/+$/, "")}/api/v1/`;
  if (!target.pathname.startsWith(prefix)) throw new Error(`${label} is outside the configured Forgejo API root`);
  const encoded = target.pathname.slice(prefix.length).split("/");
  try {
    const segments = encoded.map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => !segment || segment.includes("/"))) throw new Error("invalid path segment");
    return segments;
  } catch {
    throw new Error(`${label} contains an invalid encoded path`);
  }
}

function notificationTarget(server: string, baseUrl: string, notification: ForgejoNotification): NotificationTarget {
  const subjectType = notification.subject.type.toLowerCase();
  if (subjectType !== "issue" && subjectType !== "pull") {
    throw new Error(`notification ${notification.id} does not reference an issue or pull request`);
  }
  if (!notification.subject.url) throw new Error(`notification ${notification.id} has no subject API URL`);
  const segments = apiSegments(baseUrl, notification.subject.url, "notification subject URL");
  const [root, owner, repo, route, indexValue] = segments;
  const expectedRoute = subjectType === "pull" ? "pulls" : "issues";
  if (segments.length !== 5 || root !== "repos" || !owner || !repo || route !== expectedRoute || !indexValue) {
    throw new Error(`notification ${notification.id} subject URL is not an expected ${expectedRoute} route`);
  }
  const index = Number(indexValue);
  if (!Number.isInteger(index) || index < 1) throw new Error(`notification ${notification.id} subject URL has an invalid index`);
  if (`${owner}/${repo}` !== notification.repository.full_name) {
    throw new Error(`notification ${notification.id} subject URL does not match ${notification.repository.full_name}`);
  }
  const kind = subjectType;
  return {
    owner,
    repo,
    index,
    kind,
    reference: `${server}:${owner}/${repo}${kind === "pull" ? "!" : "#"}${index}`,
  };
}

function latestCommentPath(baseUrl: string, notification: ForgejoNotification, target: NotificationTarget): string | undefined {
  const latestUrl = notification.subject.latest_comment_url;
  if (!latestUrl) return undefined;
  const segments = apiSegments(baseUrl, latestUrl, "latest comment URL");
  const [root, owner, repo, scope, collection, commentId] = segments;
  if (
    segments.length !== 6 ||
    root !== "repos" ||
    owner !== target.owner ||
    repo !== target.repo ||
    scope !== "issues" ||
    collection !== "comments" ||
    !commentId ||
    !/^\d+$/.test(commentId)
  ) {
    throw new Error(`notification ${notification.id} latest comment URL is not an expected repository issue-comment route`);
  }
  return apiPath("repos", target.owner, target.repo, "issues", "comments", commentId);
}

function notificationReference(server: string, notification: ForgejoNotification): string {
  const fullName = notification.repository.full_name;
  const type = notification.subject.type.toLowerCase();
  if (type !== "issue" && type !== "pull") return `${server}:${fullName}`;
  const candidates = [notification.subject.url, notification.subject.html_url, notification.subject.latest_comment_url];
  for (const candidate of candidates) {
    const match = candidate?.match(/\/(?:issues|pulls)\/(\d+)(?:\/|$)/);
    if (match?.[1]) return `${server}:${fullName}${type === "pull" ? "!" : "#"}${match[1]}`;
  }
  return `${server}:${fullName}`;
}

function formatNotification(server: string, notification: ForgejoNotification): string {
  const flags = [notification.unread ? "unread" : "read", notification.pinned ? "pinned" : undefined].filter(Boolean);
  const lines = [
    `${server} notification ${notification.id} [${flags.join(", ")}]`,
    `Resource: ${notificationReference(server, notification)}`,
    `Subject: ${notification.subject.type}${notification.subject.state ? `/${notification.subject.state}` : ""} — ${notification.subject.title}`,
    `Updated: ${notification.updated_at}`,
    `Latest comment available: ${notification.subject.latest_comment_url ? "yes" : "no"}`,
  ];
  if (notification.subject.latest_comment_url) lines.push(`Latest comment API URL: ${notification.subject.latest_comment_url}`);
  if (notification.subject.latest_comment_html_url) lines.push(`Latest comment web URL: ${notification.subject.latest_comment_html_url}`);
  if (notification.subject.html_url) lines.push(`Web URL: ${notification.subject.html_url}`);
  return lines.join("\n");
}


export function registerNotificationTool(pi: ExtensionAPI, runtimeProvider: RuntimeProvider): void {
  pi.registerTool({
    name: "forgejo_notifications",
    label: "Forgejo Notifications",
    description: "List and update notification threads on one or all configured Forgejo servers.",
    promptSnippet: "Read or mark Forgejo notification threads across configured servers",
    parameters: Type.Object({
      action: StringEnum(["list", "get", "mark_read", "mark_unread", "mark_all_read"] as const),
      server: Type.Optional(Type.String({ description: "Server alias; list and mark_all_read may span all servers" })),
      id: Type.Optional(Type.Integer({ minimum: 1, description: "Notification thread ID" })),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      max_bytes: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1000000 })),
      resolve_latest: Type.Optional(Type.Boolean({ description: "For get, securely fetch and render the latest issue or pull-request comment" })),
      subject_type: Type.Optional(StringEnum(["issue", "pull", "repository"] as const)),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = runtimeProvider();
      const aliases = params.server ? [params.server] : runtime.clients.aliases();
      for (const alias of aliases) runtime.client(alias);
      const requestOptions = signal === undefined ? {} : { signal };

      if (params.action === "list") {
        const page = params.page ?? 1;
        const outcomes = await Promise.all(
          aliases.map(async (alias) => {
            try {
              const response = await runtime.client(alias).request<ForgejoNotification[]>("notifications", {
                ...requestOptions,
                query: {
                  "status-types": ["unread"],
                  "subject-type": params.subject_type,
                  page,
                  limit: positiveLimit(params.limit, 20),
                },
              });
              return {
                server: alias,
                total: response.totalCount ?? response.data.length,
                items: response.data,
                error: undefined,
              };
            } catch (error) {
              const items: ForgejoNotification[] = [];
              return {
                server: alias,
                total: 0,
                items,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );
        const text = outcomes
          .flatMap((result) =>
            result.error
              ? [`${result.server}: error — ${result.error}`]
              : [
                  `${result.server}: ${result.total} unread`,
                  ...result.items.map((notification) => formatNotification(result.server, notification)),
                ],
          )
          .join("\n\n");
        const bounded = boundModelText(text || "No unread Forgejo notifications", params.max_bytes ?? 200_000);
        const errors = Object.fromEntries(
          outcomes.flatMap((result) => (result.error ? [[result.server, result.error]] : [])),
        );
        return toolResult(bounded.text, {
          results: outcomes.filter((result) => !result.error),
          errors,
          page,
          truncated: bounded.truncated,
          originalBytes: bounded.originalBytes,
          renderedBytes: bounded.renderedBytes,
        });
      }

      if (params.action === "mark_all_read") {
        await confirmMutation(ctx, "Mark Forgejo notifications read", `Servers: ${aliases.join(", ")}\nAction: mark all unread notification threads as read`);
        const outcomes = await Promise.all(
          aliases.map(async (alias) => {
            try {
              await runtime.client(alias).request("notifications", {
                ...requestOptions,
                method: "PUT",
                query: { all: true, "status-types": ["unread"], "to-status": "read" },
              });
              return { server: alias, error: undefined };
            } catch (error) {
              return { server: alias, error: error instanceof Error ? error.message : String(error) };
            }
          }),
        );
        await runtime.dashboard.refresh(signal);
        const succeeded = outcomes.flatMap((result) => (result.error ? [] : [result.server]));
        const errors = Object.fromEntries(
          outcomes.flatMap((result) => (result.error ? [[result.server, result.error]] : [])),
        );
        const lines = [
          `Marked all notifications read on: ${succeeded.join(", ") || "none"}`,
          ...Object.entries(errors).map(([server, error]) => `${server}: error — ${error}`),
        ];
        return toolResult(lines.join("\n"), { succeeded, errors });
      }

      const alias = params.server ?? runtime.currentServer();
      if (!alias) throw new Error("server is required when multiple Forgejo servers are configured");
      if (!params.id) throw new Error(`id is required for ${params.action}`);
      const client = runtime.client(alias);
      const threadPath = apiPath("notifications", "threads", params.id);
      if (params.action === "get") {
        const response = await client.request<ForgejoNotification>(threadPath, requestOptions);
        let latestComment: ForgejoComment | null | undefined;
        let text = formatNotification(alias, response.data);
        if (params.resolve_latest) {
          const target = notificationTarget(alias, client.config.baseUrl, response.data);
          const commentPath = latestCommentPath(client.config.baseUrl, response.data, target);
          if (commentPath) {
            const comment = await client.request<ForgejoComment>(commentPath, requestOptions);
            assertForgejoCommentTarget(comment.data, target.index, target.reference);
            latestComment = comment.data;
            text = `${text}\n\nLatest comment:\n${formatForgejoComment(comment.data)}`;
          } else {
            latestComment = null;
            text = `${text}\n\nLatest comment: none; this notification was updated without a comment URL`;
          }
        }
        const bounded = boundModelText(text, params.max_bytes ?? 200_000);
        return toolResult(bounded.text, {
          notification: response.data,
          latestComment,
          truncated: bounded.truncated,
          originalBytes: bounded.originalBytes,
          renderedBytes: bounded.renderedBytes,
        });
      }
      const status = params.action === "mark_unread" ? "unread" : "read";
      const response = await client.request<ForgejoNotification>(threadPath, {
        ...requestOptions,
        method: "PATCH",
        query: { "to-status": status },
      });
      await runtime.dashboard.refresh(signal);
      return toolResult(`Marked ${alias} notification ${params.id} ${status}`, response.data);
    },
  });
}
