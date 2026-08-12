import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { apiPath } from "../client.js";
import { formatResourceRef } from "../refs.js";
import type { ForgejoComment, ForgejoIssue, ForgejoLabel, ForgejoTimelineEvent, ForgejoWatchInfo } from "../types.js";
import { incrementalConversationUpdates } from "./conversation.js";
import {
  assertForgejoCommentTarget,
  authenticatedUserName,
  boundModelText,
  DEFAULT_MODEL_OUTPUT_BYTES,
  modelOutputBytes,
  confirmMutation,
  formatForgejoComment,
  positiveLimit,
  resourceTargetProperties,
  timelineToolResult,
  toolResult,
  type RuntimeProvider,
} from "./common.js";
import { labelIds, milestoneId, normalizedDueDate, uniqueNames } from "./metadata.js";


function issueSummary(prefix: string, issue: ForgejoIssue, reference: string): string {
  return `${prefix} ${reference}: ${issue.title} [${issue.state}]`;
}

function userName(issue: ForgejoIssue): string {
  if (issue.user?.login) return `@${issue.user.login}`;
  if (issue.original_author) return issue.original_author;
  return "unknown";
}


function formatIssue(issue: ForgejoIssue, reference: string, comments: ForgejoComment[]): string {
  const lines = [
    `Issue ${reference}`,
    `Title: ${issue.title}`,
    `State: ${issue.state}`,
    `Author: ${userName(issue)}`,
    `Created: ${issue.created_at ?? "unknown"}`,
    `Updated: ${issue.updated_at}`,
    `Closed: ${issue.closed_at ?? "no"}`,
    `Assignees: ${issue.assignees?.map((user) => `@${user.login}`).join(", ") || "none"}`,
    `Labels: ${issue.labels?.map((label) => label.name).join(", ") || "none"}`,
    `Milestone: ${issue.milestone?.title ?? "none"}`,
    `Due: ${issue.due_date ?? "none"}`,
    `Locked: ${issue.is_locked ? "yes" : "no"}`,
    `Comments: ${issue.comments ?? comments.length}`,
    `URL: ${issue.html_url}`,
    "",
    "Body:",
    issue.body || "(empty)",
    "",
    `Discussion comments (${comments.length}):`,
    comments.length > 0 ? comments.map(formatForgejoComment).join("\n\n") : "(none)",
  ];
  if (issue.assets?.length) {
    lines.splice(13, 0, `Attachments: ${issue.assets.map((asset) => asset.browser_download_url ? `${asset.name} (${asset.browser_download_url})` : asset.name).join(", ")}`);
  }
  return lines.join("\n");
}


export function registerIssueTool(pi: ExtensionAPI, runtimeProvider: RuntimeProvider): void {
  pi.registerTool({
    name: "forgejo_issue",
    label: "Forgejo Issue",
    description: "Inspect and manage server-qualified Forgejo issues, discussions, subscriptions, planning metadata, and paginated or incremental timelines. Close only when explicitly requested.",
    parameters: Type.Object({
      action: StringEnum(["list", "get", "timeline", "updates", "create", "update", "comment", "get_comment", "edit_comment", "delete_comment", "subscription", "subscribe", "unsubscribe", "set_labels", "set_assignees", "set_milestone", "clear_milestone", "set_due_date", "clear_due_date", "close", "reopen"] as const),
      ...resourceTargetProperties,
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      comment_id: Type.Optional(Type.Integer({ minimum: 1, description: "Repository issue-comment ID returned by get, timeline, or comment" })),
      state: Type.Optional(StringEnum(["open", "closed", "all"] as const)),
      query: Type.Optional(Type.String({ description: "Title/body search text for list" })),
      labels: Type.Optional(Type.Array(Type.String())),
      assignees: Type.Optional(Type.Array(Type.String())),
      milestone: Type.Optional(Type.String({ minLength: 1, description: "Milestone title for set_milestone" })),
      milestone_id: Type.Optional(Type.Integer({ minimum: 1, description: "Milestone ID for set_milestone; mutually exclusive with milestone" })),
      due_date: Type.Optional(Type.String({ description: "RFC 3339 timestamp with timezone for set_due_date" })),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      max_pages: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum timeline pages scanned by updates before withholding cursor advancement" })),
      since: Type.Optional(Type.String({ description: "RFC 3339 lower timestamp bound for timeline entries" })),
      before: Type.Optional(Type.String({ description: "RFC 3339 upper timestamp bound for timeline entries" })),
      max_bytes: modelOutputBytes(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = runtimeProvider();
      const repo = runtime.resolveRepo(params);
      const client = runtime.client(repo.server);
      const basePath = apiPath("repos", repo.owner, repo.repo, "issues");

      if (params.action === "list") {
        const response = await client.request<ForgejoIssue[]>(basePath, {
          query: {
            state: params.state ?? "open",
            type: "issues",
            q: params.query,
            limit: positiveLimit(params.limit),
          },
          ...(signal === undefined ? {} : { signal }),
        });
        const lines = response.data.map((issue) => `- ${repo.server}:${repo.owner}/${repo.repo}#${issue.number} ${issue.title} [${issue.state}]`);
        return toolResult([`Issues in ${repo.server}:${repo.owner}/${repo.repo}: ${response.totalCount ?? response.data.length}`, ...lines].join("\n"), {
          total: response.totalCount ?? response.data.length,
          items: response.data,
        });
      }

      if (params.action === "create") {
        if (!params.title) throw new Error("title is required to create an issue");
        const body: Record<string, unknown> = { title: params.title };
        if (params.body !== undefined) body.body = params.body;
        if (params.assignees !== undefined) body.assignees = params.assignees;
        if (params.labels !== undefined) body.labels = await labelIds(client, repo.owner, repo.repo, params.labels, signal);
        const response = await client.request<ForgejoIssue>(basePath, {
          method: "POST",
          body,
          ...(signal === undefined ? {} : { signal }),
        });
        await runtime.dashboard.refreshIfObserved(signal);
        const ref = `${repo.server}:${repo.owner}/${repo.repo}#${response.data.number}`;
        return toolResult(issueSummary("Created", response.data, ref), response.data);
      }

      const ref = runtime.resolveResource(params, "issue");
      const reference = formatResourceRef(ref);
      const issuePath = apiPath("repos", ref.owner, ref.repo, "issues", ref.index);

      if (params.action === "get") {
        const requestOptions = signal === undefined ? {} : { signal };
        const [issue, comments] = await Promise.all([
          client.request<ForgejoIssue>(issuePath, requestOptions),
          client.request<ForgejoComment[]>(`${issuePath}/comments`, requestOptions),
        ]);
        const bounded = boundModelText(formatIssue(issue.data, reference, comments.data), params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES);
        return toolResult(bounded.text, {
          issue: issue.data,
          comments: comments.data,
          truncated: bounded.truncated,
          originalBytes: bounded.originalBytes,
          renderedBytes: bounded.renderedBytes,
        });
      }
      if (params.action === "timeline") {
        const page = params.page ?? 1;
        const limit = positiveLimit(params.limit, 50);
        const response = await client.request<ForgejoTimelineEvent[]>(`${issuePath}/timeline`, {
          query: { page, limit, since: params.since, before: params.before },
          ...(signal === undefined ? {} : { signal }),
        });
        return timelineToolResult(reference, response.data, page, limit, response.totalCount, params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES);
      }
      if (params.action === "updates") {
        return incrementalConversationUpdates<ForgejoIssue>(runtime, ref, {
          currentPath: issuePath,
          timelinePath: `${issuePath}/timeline`,
          pageLimit: positiveLimit(params.limit, 50),
          maxPages: positiveLimit(params.max_pages, 20, 100),
          maximumBytes: params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES,
          ...(params.since === undefined ? {} : { since: params.since }),
          ...(signal === undefined ? {} : { signal }),
        });
      }
      if (params.action === "comment") {
        if (!params.body) throw new Error("body is required to comment on an issue");
        const response = await client.request<ForgejoComment>(`${issuePath}/comments`, {
          method: "POST",
          body: { body: params.body },
          ...(signal === undefined ? {} : { signal }),
        });
        await runtime.dashboard.refreshIfObserved(signal);
        return toolResult(`Commented on ${reference}\n\n${formatForgejoComment(response.data)}`, response.data);
      }
      if (params.action === "get_comment" || params.action === "edit_comment" || params.action === "delete_comment") {
        if (params.comment_id === undefined) throw new Error(`comment_id is required for ${params.action}`);
        if (params.action === "edit_comment" && params.body === undefined) {
          throw new Error("body is required to edit a comment; use an empty string to clear it");
        }
        const commentPath = apiPath("repos", ref.owner, ref.repo, "issues", "comments", params.comment_id);
        const current = await client.request<ForgejoComment>(commentPath, signal === undefined ? {} : { signal });
        assertForgejoCommentTarget(current.data, ref.index, reference);
        if (params.action === "get_comment") {
          return toolResult(`Comment on ${reference}\n\n${formatForgejoComment(current.data)}`, current.data);
        }
        if (params.action === "edit_comment") {
          const response = await client.request<ForgejoComment>(commentPath, {
            method: "PATCH",
            body: { body: params.body },
            ...(signal === undefined ? {} : { signal }),
          });
          await runtime.dashboard.refreshIfObserved(signal);
          return toolResult(`Edited comment ${params.comment_id} on ${reference}\n\n${formatForgejoComment(response.data)}`, response.data);
        }
        const preview = boundModelText(current.data.body || "(empty)", 2_000);
        await confirmMutation(
          ctx,
          "Delete Forgejo issue comment",
          `Server: ${ref.server}\nRepository: ${ref.owner}/${ref.repo}\nIssue: #${ref.index}\nComment: ${params.comment_id}\nCurrent body:\n${preview.text}`,
        );
        await client.request<void>(commentPath, {
          method: "DELETE",
          ...(signal === undefined ? {} : { signal }),
        });
        await runtime.dashboard.refreshIfObserved(signal);
        return toolResult(`Deleted comment ${params.comment_id} from ${reference}`, {
          reference,
          commentId: params.comment_id,
          deleted: true,
        });
      }
      if (params.action === "subscription" || params.action === "subscribe" || params.action === "unsubscribe") {
        const checkPath = `${issuePath}/subscriptions/check`;
        if (params.action === "subscription") {
          const response = await client.request<ForgejoWatchInfo>(checkPath, signal === undefined ? {} : { signal });
          return toolResult(
            `Subscription for ${reference}: ${response.data.subscribed ? "subscribed" : "not subscribed"}${response.data.ignored ? ", ignored" : ""}`,
            response.data,
          );
        }
        const user = await authenticatedUserName(runtime, ref.server, signal);
        await client.request<void>(`${issuePath}/subscriptions/${encodeURIComponent(user)}`, {
          method: params.action === "subscribe" ? "PUT" : "DELETE",
          ...(signal === undefined ? {} : { signal }),
        });
        const response = await client.request<ForgejoWatchInfo>(checkPath, signal === undefined ? {} : { signal });
        const expected = params.action === "subscribe";
        if (response.data.subscribed !== expected) {
          throw new Error(`Forgejo did not ${expected ? "subscribe to" : "unsubscribe from"} ${reference}`);
        }
        await runtime.dashboard.refreshIfObserved(signal);
        return toolResult(`${expected ? "Subscribed to" : "Unsubscribed from"} ${reference} as @${user}`, {
          user,
          ...response.data,
        });
      }
      if (params.action === "set_labels") {
        if (!params.labels) throw new Error("labels is required for set_labels; use an empty list to clear labels");
        const ids = await labelIds(client, ref.owner, ref.repo, params.labels, signal);
        const response = await client.request<ForgejoLabel[]>(`${issuePath}/labels`, {
          method: "PUT",
          body: { labels: ids },
          ...(signal === undefined ? {} : { signal }),
        });
        const actual = new Set(response.data.map((label) => label.id));
        if (actual.size !== ids.length || ids.some((id) => !actual.has(id))) {
          throw new Error(`Forgejo did not apply the requested labels to ${reference}`);
        }
        await runtime.dashboard.refreshIfObserved(signal);
        return toolResult(`Set labels on ${reference}: ${params.labels.join(", ") || "none"}`, response.data);
      }
      if (params.action === "set_assignees") {
        if (!params.assignees) throw new Error("assignees is required for set_assignees; use an empty list to clear assignees");
        const assignees = uniqueNames(params.assignees, "assignees");
        const response = await client.request<ForgejoIssue>(issuePath, {
          method: "PATCH",
          body: { assignees },
          ...(signal === undefined ? {} : { signal }),
        });
        const actual = new Set(response.data.assignees?.map((user) => user.login.toLowerCase()) ?? []);
        if (actual.size !== assignees.length || assignees.some((name) => !actual.has(name.toLowerCase()))) {
          throw new Error(`Forgejo did not apply the requested assignees to ${reference}`);
        }
        await runtime.dashboard.refreshIfObserved(signal);
        return toolResult(issueSummary("Updated assignees on", response.data, reference), response.data);
      }
      if (params.action === "set_milestone" || params.action === "clear_milestone") {
        const id = params.action === "clear_milestone"
          ? 0
          : await milestoneId(client, ref.owner, ref.repo, params.milestone, params.milestone_id, signal);
        const response = await client.request<ForgejoIssue>(issuePath, {
          method: "PATCH",
          body: { milestone: id },
          ...(signal === undefined ? {} : { signal }),
        });
        const actual = response.data.milestone?.id ?? 0;
        if (actual !== id) throw new Error(`Forgejo did not ${id === 0 ? "clear" : "set"} the requested milestone on ${reference}`);
        await runtime.dashboard.refreshIfObserved(signal);
        return toolResult(`${id === 0 ? "Cleared milestone on" : `Set milestone '${response.data.milestone?.title ?? id}' on`} ${reference}`, response.data);
      }
      if (params.action === "set_due_date" || params.action === "clear_due_date") {
        if (params.action === "set_due_date" && params.due_date === undefined) {
          throw new Error("due_date is required for set_due_date");
        }
        const dueDate = params.action === "set_due_date" ? normalizedDueDate(params.due_date ?? "") : undefined;
        const response = await client.request<ForgejoIssue>(issuePath, {
          method: "PATCH",
          body: dueDate === undefined ? { unset_due_date: true } : { due_date: dueDate },
          ...(signal === undefined ? {} : { signal }),
        });
        if (dueDate === undefined ? Boolean(response.data.due_date) : Date.parse(response.data.due_date ?? "") !== Date.parse(dueDate)) {
          throw new Error(`Forgejo did not ${dueDate === undefined ? "clear" : "set"} the requested due date on ${reference}`);
        }
        await runtime.dashboard.refreshIfObserved(signal);
        return toolResult(`${dueDate === undefined ? "Cleared due date on" : `Set due date ${dueDate} on`} ${reference}`, response.data);
      }
      if (params.action === "close") {
        await confirmMutation(ctx, "Close Forgejo issue", `Server: ${ref.server}\nRepository: ${ref.owner}/${ref.repo}\nIssue: #${ref.index}`);
        const response = await client.request<ForgejoIssue>(issuePath, {
          method: "PATCH",
          body: { state: "closed" },
          ...(signal === undefined ? {} : { signal }),
        });
        await runtime.dashboard.refreshIfObserved(signal);
        return toolResult(issueSummary("Closed", response.data, reference), response.data);
      }
      if (params.action === "reopen") {
        const response = await client.request<ForgejoIssue>(issuePath, {
          method: "PATCH",
          body: { state: "open" },
          ...(signal === undefined ? {} : { signal }),
        });
        await runtime.dashboard.refreshIfObserved(signal);
        return toolResult(issueSummary("Reopened", response.data, reference), response.data);
      }

      const body: Record<string, unknown> = {};
      if (params.title !== undefined) body.title = params.title;
      if (params.body !== undefined) body.body = params.body;
      if (Object.keys(body).length === 0) throw new Error("update requires title or body");
      const response = await client.request<ForgejoIssue>(issuePath, {
        method: "PATCH",
        body,
        ...(signal === undefined ? {} : { signal }),
      });
      await runtime.dashboard.refreshIfObserved(signal);
      return toolResult(issueSummary("Updated", response.data, reference), response.data);
    },
  });
}
