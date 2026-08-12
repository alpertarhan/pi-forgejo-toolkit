import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { apiPath } from "../client.js";
import type { ForgejoClient } from "../client.js";
import { formatResourceRef } from "../refs.js";
import type {
  ForgejoBranch,
  ForgejoChangedFile,
  ForgejoCombinedStatus,
  ForgejoComment,
  ForgejoCommit,
  ForgejoPullRequest,
  ForgejoPullReview,
  ForgejoTimelineEvent,
  ForgejoWatchInfo,
  ResourceRef,
} from "../types.js";
import { incrementalConversationUpdates } from "./conversation.js";
import {
  assertForgejoCommentTarget,
  authenticatedUserName,
  boundModelText,
  boundModelTextWithSuffix,
  confirmMutation,
  formatForgejoComment,
  formatForgejoReview,
  positiveLimit,
  resourceTargetProperties,
  timelineToolResult,
  toolResult,
  type RuntimeProvider,
} from "./common.js";
import { labelIds, milestoneId, normalizedDueDate, uniqueNames } from "./metadata.js";

const DRAFT_TITLE_PREFIX = /^(?:WIP:|Draft:|\[WIP\]:?|\[Draft\]:?)\s*/i;

function hasDraftTitlePrefix(title: string): boolean {
  return DRAFT_TITLE_PREFIX.test(title);
}

function draftTitle(title: string): string {
  return hasDraftTitlePrefix(title) ? title : `WIP: ${title}`;
}

function readyTitle(title: string): string {
  if (!hasDraftTitlePrefix(title)) {
    throw new Error("pull request is draft but its configured draft title marker is unknown; update the title explicitly");
  }
  const ready = title.replace(DRAFT_TITLE_PREFIX, "").trimStart();
  if (!ready) throw new Error("cannot mark a pull request ready with an empty title");
  return ready;
}


function pullSummary(prefix: string, pull: ForgejoPullRequest, reference: string): string {
  const flags = [pull.state, pull.draft ? "draft" : undefined, pull.mergeable === false ? "not mergeable" : undefined].filter(Boolean);
  return `${prefix} ${reference}: ${pull.title} [${flags.join(", ")}]`;
}

function formatPull(pull: ForgejoPullRequest, reference: string, reviews: ForgejoPullReview[]): string {
  const author = pull.user?.login ? `@${pull.user.login}` : pull.original_author || "unknown";
  const lines = [
    `Pull request ${reference}`,
    `Title: ${pull.title}`,
    `State: ${pull.state}`,
    `Author: ${author}`,
    `Created: ${pull.created_at ?? "unknown"}`,
    `Updated: ${pull.updated_at}`,
    `Closed: ${pull.closed_at ?? "no"}`,
    `Draft: ${pull.draft ? "yes" : "no"}`,
    `Locked: ${pull.is_locked ? "yes" : "no"}`,
    `Merged: ${pull.merged ? `yes at ${pull.merged_at ?? "unknown"} by ${pull.merged_by?.login ? `@${pull.merged_by.login}` : "unknown"}` : "no"}`,
    `Mergeable: ${pull.mergeable === undefined ? "unknown" : pull.mergeable ? "yes" : "no"}`,
    `Head: ${pull.head.ref} (${pull.head.sha})`,
    `Base: ${pull.base.ref} (${pull.base.sha})`,
    `Requested reviewers: ${pull.requested_reviewers?.map((user) => `@${user.login}`).join(", ") || "none"}`,
    `Requested teams: ${pull.requested_reviewers_teams?.map((team) => team.name).join(", ") || "none"}`,
    `Assignees: ${pull.assignees?.map((user) => `@${user.login}`).join(", ") || "none"}`,
    `Labels: ${pull.labels?.map((label) => label.name).join(", ") || "none"}`,
    `Milestone: ${pull.milestone?.title ?? "none"}`,
    `Due: ${pull.due_date ?? "none"}`,
    `Changes: ${pull.changed_files ?? "unknown"} files, +${pull.additions ?? "unknown"} -${pull.deletions ?? "unknown"}`,
    `Comments: ${pull.comments ?? "unknown"} discussion, ${pull.review_comments ?? "unknown"} review`,
    `Maintainer edit: ${pull.allow_maintainer_edit === undefined ? "unknown" : pull.allow_maintainer_edit ? "allowed" : "not allowed"}`,
    `Merge commit: ${pull.merge_commit_sha ?? "none"}`,
    `URL: ${pull.html_url}`,
    "",
    "Body:",
    pull.body || "(empty)",
    "",
    `Reviews (${reviews.length}):`,
    reviews.length > 0 ? reviews.map(formatForgejoReview).join("\n\n") : "(none)",
  ];
  return lines.join("\n");
}

function formatChangedFile(file: ForgejoChangedFile): string {
  const renamed = file.previous_filename ? ` (from ${file.previous_filename})` : "";
  const lines = [`${file.filename}${renamed} [${file.status}] +${file.additions} -${file.deletions} (${file.changes} changes)`];
  if (file.html_url) lines.push(`URL: ${file.html_url}`);
  return lines.join("\n");
}

function formatCommit(commit: ForgejoCommit): string {
  const author = commit.author?.login ? `@${commit.author.login}` : commit.commit?.author?.name ?? "unknown";
  const date = commit.commit?.author?.date ?? commit.created ?? "unknown";
  const lines = [
    `Commit ${commit.sha}`,
    `Author: ${author}`,
    `Date: ${date}`,
    "",
    "Message:",
    commit.commit?.message || "(empty)",
  ];
  if (commit.html_url) lines.push("", `URL: ${commit.html_url}`);
  return lines.join("\n");
}

function formatChecks(checks: ForgejoCombinedStatus, reference: string): string {
  const lines = [`Checks for ${reference} at ${checks.sha}: ${checks.state} (${checks.total_count})`];
  for (const status of checks.statuses) {
    lines.push(`- ${status.context} [${status.status}]${status.description ? ` ${status.description}` : ""}${status.target_url ? ` ${status.target_url}` : ""}`);
  }
  return lines.join("\n");
}

function pagedToolResult<T>(
  header: string,
  items: T[],
  blocks: string[],
  page: number,
  limit: number,
  totalCount: number | undefined,
  maximumBytes: number,
): ReturnType<typeof toolResult> {
  const hasMore = totalCount === undefined ? items.length === limit : page * limit < totalCount;
  const nextPage = hasMore ? page + 1 : undefined;
  const body = [header, ...blocks].join("\n\n");
  const footer = (truncated: boolean): string =>
    [
      "",
      `Page: ${page}`,
      `Returned: ${items.length}`,
      `Total: ${totalCount ?? "unknown"}`,
      `Has more: ${hasMore ? "yes" : "no"}`,
      `Next page: ${nextPage ?? "none"}`,
      `Truncated: ${truncated ? "yes" : "no"}`,
      ...(truncated ? [`Recovery: repeat page ${page} with a smaller limit`] : []),
    ].join("\n");
  let bounded = boundModelTextWithSuffix(body, `\n${footer(false)}`, maximumBytes);
  if (bounded.truncated) bounded = boundModelTextWithSuffix(body, `\n${footer(true)}`, maximumBytes);
  const details: {
    items: T[];
    page: number;
    limit: number;
    hasMore: boolean;
    truncated: boolean;
    originalBytes: number;
    renderedBytes: number;
    total?: number;
    nextPage?: number;
  } = {
    items,
    page,
    limit,
    hasMore,
    truncated: bounded.truncated,
    originalBytes: bounded.originalBytes,
    renderedBytes: bounded.renderedBytes,
  };
  if (totalCount !== undefined) details.total = totalCount;
  if (nextPage !== undefined) details.nextPage = nextPage;
  return toolResult(bounded.text, details);
}

interface MergeReadiness {
  ready: boolean;
  blockers: string[];
  state: string;
  draft: boolean;
  mergeable: boolean | undefined;
  merged: boolean;
  headSha: string;
  baseBranch: string;
  branch: ForgejoBranch;
  checks: ForgejoCombinedStatus;
  reviews: {
    requiredApprovals: number;
    approvals: number;
    changesRequested: string[];
    requested: string[];
  };
}

function reviewIdentity(review: ForgejoPullReview): string {
  if (review.user) return `user:${review.user.id}`;
  if (review.team) return `team:${review.team.id}`;
  return `review:${review.id}`;
}

function reviewTimestamp(review: ForgejoPullReview): number {
  return Date.parse(review.updated_at ?? review.submitted_at ?? "") || review.id;
}

function latestReviews(reviews: ForgejoPullReview[]): ForgejoPullReview[] {
  const latest = new Map<string, ForgejoPullReview>();
  for (const review of reviews) {
    const key = reviewIdentity(review);
    const current = latest.get(key);
    if (!current || reviewTimestamp(review) > reviewTimestamp(current)) latest.set(key, review);
  }
  return [...latest.values()];
}

function reviewerName(review: ForgejoPullReview): string {
  return review.user?.login ?? review.team?.name ?? `review ${review.id}`;
}

async function loadMergeReadiness(
  client: ForgejoClient,
  ref: ResourceRef,
  pull: ForgejoPullRequest,
  signal?: AbortSignal,
): Promise<MergeReadiness> {
  const options = signal === undefined ? {} : { signal };
  const pullPath = apiPath("repos", ref.owner, ref.repo, "pulls", ref.index);
  const [branchResult, checksResult, reviewsResult] = await Promise.all([
    client.request<ForgejoBranch>(apiPath("repos", ref.owner, ref.repo, "branches", pull.base.ref), options),
    client.request<ForgejoCombinedStatus>(apiPath("repos", ref.owner, ref.repo, "commits", pull.head.sha, "status"), options),
    client.request<ForgejoPullReview[]>(`${pullPath}/reviews`, { ...options, query: { limit: 100 } }),
  ]);
  const branch = branchResult.data;
  const checks = checksResult.data;
  const currentReviews = latestReviews(reviewsResult.data).filter(
    (review) => !review.dismissed && !review.stale && (!review.commit_id || review.commit_id === pull.head.sha),
  );
  const approvals = currentReviews.filter((review) => review.state.toUpperCase() === "APPROVED" && review.official !== false);
  const changesRequested = currentReviews
    .filter((review) => review.state.toUpperCase() === "REQUEST_CHANGES")
    .map(reviewerName);
  const requested = [
    ...(pull.requested_reviewers ?? []).map((user) => user.login),
    ...(pull.requested_reviewers_teams ?? []).map((team) => team.name),
  ];
  const blockers: string[] = [];
  const merged = pull.merged ?? false;
  if (merged) blockers.push("pull request is already merged");
  else if (pull.state !== "open") blockers.push(`pull request state is ${pull.state}`);
  if (pull.draft) blockers.push("pull request is a draft");
  if (pull.mergeable === false) blockers.push("pull request has merge conflicts");
  if (pull.mergeable === undefined) blockers.push("pull request mergeability is unknown");
  if (branch.user_can_merge === false) blockers.push(`current user cannot merge into ${pull.base.ref}`);

  const acceptedCheckStates = new Set(["success", "skipped"]);
  if (checks.total_count > 0 && !acceptedCheckStates.has(checks.state)) {
    blockers.push(`combined commit status is ${checks.state}`);
  }
  if (branch.enable_status_check) {
    const contexts = branch.status_check_contexts ?? [];
    if (contexts.length === 0 && checks.total_count === 0) blockers.push("required status checks have not reported");
    for (const context of contexts) {
      const status = checks.statuses.find((candidate) => candidate.context === context);
      if (!status) blockers.push(`required check '${context}' is missing`);
      else if (!acceptedCheckStates.has(status.status)) blockers.push(`required check '${context}' is ${status.status}`);
    }
  }
  if (changesRequested.length > 0) blockers.push(`changes requested by ${changesRequested.join(", ")}`);
  if (approvals.length < branch.required_approvals) {
    blockers.push(`requires ${branch.required_approvals} approvals; found ${approvals.length}`);
  }
  if (requested.length > 0) blockers.push(`review still requested from ${requested.join(", ")}`);

  return {
    ready: blockers.length === 0,
    blockers,
    state: pull.state,
    draft: pull.draft ?? false,
    mergeable: pull.mergeable,
    merged,
    headSha: pull.head.sha,
    baseBranch: pull.base.ref,
    branch,
    checks,
    reviews: {
      requiredApprovals: branch.required_approvals,
      approvals: approvals.length,
      changesRequested,
      requested,
    },
  };
}

export function registerPullTool(pi: ExtensionAPI, runtimeProvider: RuntimeProvider): void {
  pi.registerTool({
    name: "forgejo_pull",
    label: "Forgejo Pull Request",
    description: "List, inspect, discuss, manage comments, subscriptions, review requests, labels, assignees, milestones, due dates, maintainer editing, diff, lifecycle, and safe merges for Forgejo pull requests, including paginated and incremental timelines.",
    promptSnippet: "Read pull request metadata, discussion, timeline, incremental updates, subscription state, review requests, files, commits, checks, readiness, or manage lifecycle, planning metadata, comments, and safe merges",
    promptGuidelines: [
      "Use forgejo_pull close only after the user explicitly requests closing the pull request.",
      "Marking a draft pull request ready requires interactive confirmation because it signals review readiness.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "get", "timeline", "updates", "comment", "get_comment", "edit_comment", "delete_comment", "subscription", "subscribe", "unsubscribe", "files", "diff", "commits", "checks", "create", "update", "set_labels", "set_assignees", "set_milestone", "clear_milestone", "set_due_date", "clear_due_date", "set_maintainer_edit", "close", "reopen", "mark_draft", "mark_ready", "request_reviewers", "remove_reviewers", "readiness", "merge"] as const),
      ...resourceTargetProperties,
      title: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      comment_id: Type.Optional(Type.Integer({ minimum: 1, description: "Repository issue-comment ID returned by get, timeline, or comment" })),
      reviewers: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Usernames to request or remove from pull-request review" })),
      reviewer_teams: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Team names to request or remove from pull-request review" })),
      labels: Type.Optional(Type.Array(Type.String(), { description: "Desired pull-request labels; an empty list clears labels" })),
      assignees: Type.Optional(Type.Array(Type.String(), { description: "Desired pull-request assignees; an empty list clears assignees" })),
      milestone: Type.Optional(Type.String({ minLength: 1, description: "Milestone title for set_milestone" })),
      milestone_id: Type.Optional(Type.Integer({ minimum: 1, description: "Milestone ID for set_milestone; mutually exclusive with milestone" })),
      due_date: Type.Optional(Type.String({ description: "RFC 3339 timestamp with timezone for set_due_date" })),
      allow_maintainer_edit: Type.Optional(Type.Boolean({ description: "Whether maintainers may edit the pull-request branch" })),
      head: Type.Optional(Type.String({ description: "Head branch, optionally owner:branch" })),
      base: Type.Optional(Type.String({ description: "Target branch" })),
      draft: Type.Optional(Type.Boolean({ description: "Prefix a new PR title with the Forgejo default WIP marker" })),
      state: Type.Optional(StringEnum(["open", "closed", "all"] as const)),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      max_pages: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum timeline pages scanned by updates before withholding cursor advancement" })),
      since: Type.Optional(Type.String({ description: "RFC 3339 lower timestamp bound for timeline entries" })),
      before: Type.Optional(Type.String({ description: "RFC 3339 upper timestamp bound for timeline entries" })),
      max_bytes: Type.Optional(Type.Integer({ minimum: 1000, maximum: 1000000 })),
      merge_method: Type.Optional(StringEnum(["merge", "squash", "rebase", "rebase-merge", "fast-forward-only"] as const)),
      delete_branch: Type.Optional(Type.Boolean({ description: "Delete the source branch after a successful merge" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = runtimeProvider();
      const repo = runtime.resolveRepo(params);
      const client = runtime.client(repo.server);
      const pullsPath = apiPath("repos", repo.owner, repo.repo, "pulls");
      const requestOptions = signal === undefined ? {} : { signal };

      if (params.action === "list") {
        const response = await client.request<Array<ForgejoPullRequest | null>>(pullsPath, {
          ...requestOptions,
          query: { state: params.state ?? "open", page: params.page ?? 1, limit: positiveLimit(params.limit) },
        });
        const pulls = response.data.filter((pull): pull is ForgejoPullRequest => pull !== null);
        const lines = pulls.map((pull) => `- ${repo.server}:${repo.owner}/${repo.repo}!${pull.number} ${pull.title} [${pull.state}]`);
        return toolResult([`Pull requests in ${repo.server}:${repo.owner}/${repo.repo}: ${response.totalCount ?? pulls.length}`, ...lines].join("\n"), {
          total: response.totalCount ?? pulls.length,
          items: pulls,
        });
      }

      if (params.action === "create") {
        if (!params.title || !params.head || !params.base) throw new Error("title, head, and base are required to create a pull request");
        const title = params.draft ? draftTitle(params.title) : params.title;
        const response = await client.request<ForgejoPullRequest>(pullsPath, {
          ...requestOptions,
          method: "POST",
          body: { title, head: params.head, base: params.base, body: params.body ?? "" },
        });
        await runtime.dashboard.refresh(signal);
        const reference = `${repo.server}:${repo.owner}/${repo.repo}!${response.data.number}`;
        return toolResult(pullSummary("Created", response.data, reference), response.data);
      }

      const ref = runtime.resolveResource(params, "pull");
      const reference = formatResourceRef(ref);
      const pullPath = apiPath("repos", ref.owner, ref.repo, "pulls", ref.index);

      if (params.action === "comment") {
        if (!params.body) throw new Error("body is required to comment on a pull request");
        const issueCommentsPath = apiPath("repos", ref.owner, ref.repo, "issues", ref.index, "comments");
        const response = await client.request<ForgejoComment>(issueCommentsPath, {
          ...requestOptions,
          method: "POST",
          body: { body: params.body },
        });
        await runtime.dashboard.refresh(signal);
        return toolResult(`Commented on ${reference}\n\n${formatForgejoComment(response.data)}`, response.data);
      }
      if (params.action === "get_comment" || params.action === "edit_comment" || params.action === "delete_comment") {
        if (params.comment_id === undefined) throw new Error(`comment_id is required for ${params.action}`);
        if (params.action === "edit_comment" && params.body === undefined) {
          throw new Error("body is required to edit a comment; use an empty string to clear it");
        }
        const commentPath = apiPath("repos", ref.owner, ref.repo, "issues", "comments", params.comment_id);
        const current = await client.request<ForgejoComment>(commentPath, requestOptions);
        assertForgejoCommentTarget(current.data, ref.index, reference);
        if (params.action === "get_comment") {
          return toolResult(`Comment on ${reference}\n\n${formatForgejoComment(current.data)}`, current.data);
        }
        if (params.action === "edit_comment") {
          const response = await client.request<ForgejoComment>(commentPath, {
            ...requestOptions,
            method: "PATCH",
            body: { body: params.body },
          });
          await runtime.dashboard.refresh(signal);
          return toolResult(`Edited comment ${params.comment_id} on ${reference}\n\n${formatForgejoComment(response.data)}`, response.data);
        }
        const preview = boundModelText(current.data.body || "(empty)", 2_000);
        await confirmMutation(
          ctx,
          "Delete Forgejo pull request comment",
          `Server: ${ref.server}\nRepository: ${ref.owner}/${ref.repo}\nPull request: !${ref.index}\nComment: ${params.comment_id}\nCurrent body:\n${preview.text}`,
        );
        await client.request<void>(commentPath, {
          ...requestOptions,
          method: "DELETE",
        });
        await runtime.dashboard.refresh(signal);
        return toolResult(`Deleted comment ${params.comment_id} from ${reference}`, {
          reference,
          commentId: params.comment_id,
          deleted: true,
        });
      }
      if (params.action === "subscription" || params.action === "subscribe" || params.action === "unsubscribe") {
        const issuePath = apiPath("repos", ref.owner, ref.repo, "issues", ref.index);
        const checkPath = `${issuePath}/subscriptions/check`;
        if (params.action === "subscription") {
          const response = await client.request<ForgejoWatchInfo>(checkPath, requestOptions);
          return toolResult(
            `Subscription for ${reference}: ${response.data.subscribed ? "subscribed" : "not subscribed"}${response.data.ignored ? ", ignored" : ""}`,
            response.data,
          );
        }
        const user = await authenticatedUserName(runtime, ref.server, signal);
        await client.request<void>(`${issuePath}/subscriptions/${encodeURIComponent(user)}`, {
          ...requestOptions,
          method: params.action === "subscribe" ? "PUT" : "DELETE",
        });
        const response = await client.request<ForgejoWatchInfo>(checkPath, requestOptions);
        const expected = params.action === "subscribe";
        if (response.data.subscribed !== expected) {
          throw new Error(`Forgejo did not ${expected ? "subscribe to" : "unsubscribe from"} ${reference}`);
        }
        await runtime.dashboard.refresh(signal);
        return toolResult(`${expected ? "Subscribed to" : "Unsubscribed from"} ${reference} as @${user}`, {
          user,
          ...response.data,
        });
      }
      if (params.action === "timeline") {
        const page = params.page ?? 1;
        const limit = positiveLimit(params.limit, 50);
        const timelinePath = apiPath("repos", ref.owner, ref.repo, "issues", ref.index, "timeline");
        const response = await client.request<ForgejoTimelineEvent[]>(timelinePath, {
          ...requestOptions,
          query: { page, limit, since: params.since, before: params.before },
        });
        return timelineToolResult(reference, response.data, page, limit, response.totalCount, params.max_bytes ?? 200_000);
      }
      if (params.action === "updates") {
        return incrementalConversationUpdates<ForgejoPullRequest>(runtime, ref, {
          currentPath: pullPath,
          timelinePath: apiPath("repos", ref.owner, ref.repo, "issues", ref.index, "timeline"),
          pageLimit: positiveLimit(params.limit, 50),
          maxPages: positiveLimit(params.max_pages, 20, 100),
          maximumBytes: params.max_bytes ?? 200_000,
          headSha: (pull) => pull.head.sha,
          ...(params.since === undefined ? {} : { since: params.since }),
          ...(signal === undefined ? {} : { signal }),
        });
      }
      if (params.action === "files") {
        const page = params.page ?? 1;
        const limit = positiveLimit(params.limit, 50);
        const response = await client.request<ForgejoChangedFile[]>(`${pullPath}/files`, {
          ...requestOptions,
          query: { page, limit },
        });
        return pagedToolResult(
          `Changed files for ${reference}`,
          response.data,
          response.data.map(formatChangedFile),
          page,
          limit,
          response.totalCount,
          params.max_bytes ?? 200_000,
        );
      }
      if (params.action === "commits") {
        const page = params.page ?? 1;
        const limit = positiveLimit(params.limit, 50);
        const response = await client.request<ForgejoCommit[]>(`${pullPath}/commits`, {
          ...requestOptions,
          query: { page, limit, files: false },
        });
        return pagedToolResult(
          `Commits for ${reference}`,
          response.data,
          response.data.map(formatCommit),
          page,
          limit,
          response.totalCount,
          params.max_bytes ?? 200_000,
        );
      }
      if (params.action === "diff") {
        const response = await client.request<string>(`${pullPath}.diff`, { ...requestOptions, accept: "text/plain" });
        const maximum = params.max_bytes ?? 200_000;
        const bounded = boundModelText(`Diff for ${reference}\n\n${response.data}`, maximum);
        return toolResult(bounded.text, {
          diff: bounded.text,
          truncated: bounded.truncated,
          originalBytes: bounded.originalBytes,
          renderedBytes: bounded.renderedBytes,
        });
      }
      if (params.action === "set_labels") {
        if (!params.labels) throw new Error("labels is required for set_labels; use an empty list to clear labels");
        const ids = await labelIds(client, ref.owner, ref.repo, params.labels, signal);
        const response = await client.request<ForgejoPullRequest>(pullPath, {
          ...requestOptions,
          method: "PATCH",
          body: { labels: ids },
        });
        const actual = new Set(response.data.labels?.map((label) => label.id) ?? []);
        if (actual.size !== ids.length || ids.some((id) => !actual.has(id))) {
          throw new Error(`Forgejo did not apply the requested labels to ${reference}`);
        }
        await runtime.dashboard.refresh(signal);
        return toolResult(`Set labels on ${reference}: ${params.labels.join(", ") || "none"}`, response.data);
      }
      if (params.action === "set_assignees") {
        if (!params.assignees) throw new Error("assignees is required for set_assignees; use an empty list to clear assignees");
        const assignees = uniqueNames(params.assignees, "assignees");
        const response = await client.request<ForgejoPullRequest>(pullPath, {
          ...requestOptions,
          method: "PATCH",
          body: { assignees },
        });
        const actual = new Set(response.data.assignees?.map((user) => user.login.toLowerCase()) ?? []);
        if (actual.size !== assignees.length || assignees.some((name) => !actual.has(name.toLowerCase()))) {
          throw new Error(`Forgejo did not apply the requested assignees to ${reference}`);
        }
        await runtime.dashboard.refresh(signal);
        return toolResult(pullSummary("Updated assignees on", response.data, reference), response.data);
      }
      if (params.action === "set_milestone" || params.action === "clear_milestone") {
        const id = params.action === "clear_milestone"
          ? 0
          : await milestoneId(client, ref.owner, ref.repo, params.milestone, params.milestone_id, signal);
        const response = await client.request<ForgejoPullRequest>(pullPath, {
          ...requestOptions,
          method: "PATCH",
          body: { milestone: id },
        });
        const actual = response.data.milestone?.id ?? 0;
        if (actual !== id) throw new Error(`Forgejo did not ${id === 0 ? "clear" : "set"} the requested milestone on ${reference}`);
        await runtime.dashboard.refresh(signal);
        return toolResult(`${id === 0 ? "Cleared milestone on" : `Set milestone '${response.data.milestone?.title ?? id}' on`} ${reference}`, response.data);
      }
      if (params.action === "set_due_date" || params.action === "clear_due_date") {
        if (params.action === "set_due_date" && params.due_date === undefined) {
          throw new Error("due_date is required for set_due_date");
        }
        const dueDate = params.action === "set_due_date" ? normalizedDueDate(params.due_date ?? "") : undefined;
        const response = await client.request<ForgejoPullRequest>(pullPath, {
          ...requestOptions,
          method: "PATCH",
          body: dueDate === undefined ? { unset_due_date: true } : { due_date: dueDate },
        });
        if (dueDate === undefined ? Boolean(response.data.due_date) : Date.parse(response.data.due_date ?? "") !== Date.parse(dueDate)) {
          throw new Error(`Forgejo did not ${dueDate === undefined ? "clear" : "set"} the requested due date on ${reference}`);
        }
        await runtime.dashboard.refresh(signal);
        return toolResult(`${dueDate === undefined ? "Cleared due date on" : `Set due date ${dueDate} on`} ${reference}`, response.data);
      }
      if (params.action === "set_maintainer_edit") {
        if (params.allow_maintainer_edit === undefined) {
          throw new Error("allow_maintainer_edit is required for set_maintainer_edit");
        }
        const response = await client.request<ForgejoPullRequest>(pullPath, {
          ...requestOptions,
          method: "PATCH",
          body: { allow_maintainer_edit: params.allow_maintainer_edit },
        });
        if (response.data.allow_maintainer_edit !== params.allow_maintainer_edit) {
          throw new Error(`Forgejo did not update maintainer edit permission on ${reference}`);
        }
        await runtime.dashboard.refresh(signal);
        return toolResult(`${params.allow_maintainer_edit ? "Enabled" : "Disabled"} maintainer edits on ${reference}`, response.data);
      }
      if (params.action === "request_reviewers" || params.action === "remove_reviewers") {
        const reviewers = uniqueNames(params.reviewers ?? [], "reviewers");
        const teams = uniqueNames(params.reviewer_teams ?? [], "reviewer_teams");
        if (reviewers.length === 0 && teams.length === 0) {
          throw new Error(`${params.action} requires at least one reviewer or reviewer team`);
        }
        const current = await client.request<ForgejoPullRequest>(pullPath, requestOptions);
        const currentReviewers = new Set(current.data.requested_reviewers?.map((user) => user.login.toLowerCase()) ?? []);
        const currentTeams = new Set(current.data.requested_reviewers_teams?.map((team) => team.name.toLowerCase()) ?? []);
        const requesting = params.action === "request_reviewers";
        const changedReviewers = reviewers.filter((name) => currentReviewers.has(name.toLowerCase()) !== requesting);
        const changedTeams = teams.filter((name) => currentTeams.has(name.toLowerCase()) !== requesting);
        if (changedReviewers.length === 0 && changedTeams.length === 0) {
          return toolResult(`Review requests on ${reference} already match the requested change`, current.data);
        }
        await client.request(`${pullPath}/requested_reviewers`, {
          ...requestOptions,
          method: requesting ? "POST" : "DELETE",
          body: { reviewers: changedReviewers, team_reviewers: changedTeams },
        });
        const fresh = await client.request<ForgejoPullRequest>(pullPath, requestOptions);
        const freshReviewers = new Set(fresh.data.requested_reviewers?.map((user) => user.login.toLowerCase()) ?? []);
        const freshTeams = new Set(fresh.data.requested_reviewers_teams?.map((team) => team.name.toLowerCase()) ?? []);
        const unverified = [
          ...reviewers.filter((name) => freshReviewers.has(name.toLowerCase()) !== requesting).map((name) => `user:${name}`),
          ...teams.filter((name) => freshTeams.has(name.toLowerCase()) !== requesting).map((name) => `team:${name}`),
        ];
        if (unverified.length > 0) {
          throw new Error(`Forgejo did not ${requesting ? "request" : "remove"} review for ${unverified.join(", ")} on ${reference}`);
        }
        await runtime.dashboard.refresh(signal);
        return toolResult(`${requesting ? "Requested" : "Removed"} review on ${reference}`, {
          pull: fresh.data,
          changedReviewers,
          changedTeams,
        });
      }
      if (params.action === "mark_draft" || params.action === "mark_ready") {
        const current = await client.request<ForgejoPullRequest>(pullPath, requestOptions);
        const isDraft = current.data.draft ?? hasDraftTitlePrefix(current.data.title);
        const targetDraft = params.action === "mark_draft";
        if (isDraft === targetDraft) {
          return toolResult(`${reference} is already ${targetDraft ? "draft" : "ready"}`, current.data);
        }
        const title = targetDraft ? draftTitle(current.data.title) : readyTitle(current.data.title);
        if (params.action === "mark_ready") {
          await confirmMutation(
            ctx,
            "Mark Forgejo pull request ready",
            [
              `Server: ${ref.server}`,
              `Repository: ${ref.owner}/${ref.repo}`,
              `Pull request: !${ref.index}`,
              `Head: ${current.data.head.sha}`,
              `Current title: ${current.data.title}`,
              `Ready title: ${title}`,
            ].join("\n"),
          );
        }
        const response = await client.request<ForgejoPullRequest>(pullPath, {
          ...requestOptions,
          method: "PATCH",
          body: { title },
        });
        const verifiedDraft = response.data.draft ?? hasDraftTitlePrefix(response.data.title);
        if (verifiedDraft !== targetDraft) {
          throw new Error(`Forgejo did not mark ${reference} ${targetDraft ? "draft" : "ready"}`);
        }
        await runtime.dashboard.refresh(signal);
        return toolResult(pullSummary(targetDraft ? "Marked draft" : "Marked ready", response.data, reference), response.data);
      }
      if (params.action === "close" || params.action === "reopen") {
        const current = await client.request<ForgejoPullRequest>(pullPath, requestOptions);
        const targetState = params.action === "close" ? "closed" : "open";
        if (current.data.state === targetState) {
          return toolResult(`${reference} is already ${targetState}`, current.data);
        }
        if (params.action === "close") {
          await confirmMutation(
            ctx,
            "Close Forgejo pull request",
            `Server: ${ref.server}\nRepository: ${ref.owner}/${ref.repo}\nPull request: !${ref.index} - ${current.data.title}`,
          );
        }
        const response = await client.request<ForgejoPullRequest>(pullPath, {
          ...requestOptions,
          method: "PATCH",
          body: { state: targetState },
        });
        if (response.data.state !== targetState) {
          throw new Error(`Forgejo returned state '${response.data.state}' after requesting '${targetState}' for ${reference}`);
        }
        await runtime.dashboard.refresh(signal);
        return toolResult(pullSummary(params.action === "close" ? "Closed" : "Reopened", response.data, reference), response.data);
      }
      if (params.action === "update") {
        const body: Record<string, unknown> = {};
        if (params.title !== undefined) body.title = params.title;
        if (params.body !== undefined) body.body = params.body;
        if (params.base !== undefined) body.base = params.base;
        if (Object.keys(body).length === 0) throw new Error("update requires title, body, or base");
        const response = await client.request<ForgejoPullRequest>(pullPath, {
          ...requestOptions,
          method: "PATCH",
          body,
        });
        await runtime.dashboard.refresh(signal);
        return toolResult(pullSummary("Updated", response.data, reference), response.data);
      }

      const pull = await client.request<ForgejoPullRequest>(pullPath, requestOptions);
      if (params.action === "checks") {
        const checks = await client.request<ForgejoCombinedStatus>(
          apiPath("repos", ref.owner, ref.repo, "commits", pull.data.head.sha, "status"),
          requestOptions,
        );
        return toolResult(formatChecks(checks.data, reference), checks.data);
      }
      if (params.action === "readiness" || params.action === "merge") {
        const readiness = await loadMergeReadiness(client, ref, pull.data, signal);
        if (params.action === "readiness") {
          return toolResult(
            readiness.ready ? `${reference}: ready to merge` : `${reference}: merge blocked - ${readiness.blockers.join("; ")}`,
            readiness,
          );
        }
        if (!params.merge_method) throw new Error("merge_method is required to merge a pull request");
        if (!readiness.ready) throw new Error(`merge blocked for ${reference}: ${readiness.blockers.join("; ")}`);
        const deleteBranch = params.delete_branch ?? false;
        await confirmMutation(
          ctx,
          "Merge pull request",
          [
            `Server: ${ref.server}`,
            `Pull request: ${reference} - ${pull.data.title}`,
            `Strategy: ${params.merge_method}`,
            `Head: ${readiness.headSha}`,
            `Checks: ${readiness.checks.state} (${readiness.checks.total_count})`,
            `Approvals: ${readiness.reviews.approvals}/${readiness.reviews.requiredApprovals}`,
            `Delete source branch: ${deleteBranch ? "yes" : "no"}`,
          ].join("\n"),
        );
        const freshPull = await client.request<ForgejoPullRequest>(pullPath, requestOptions);
        if (freshPull.data.head.sha !== readiness.headSha) {
          throw new Error(`pull request head changed from ${readiness.headSha} to ${freshPull.data.head.sha}; merge cancelled`);
        }
        const freshReadiness = await loadMergeReadiness(client, ref, freshPull.data, signal);
        if (!freshReadiness.ready) {
          throw new Error(`merge conditions changed for ${reference}: ${freshReadiness.blockers.join("; ")}`);
        }
        await client.request(`${pullPath}/merge`, {
          ...requestOptions,
          method: "POST",
          body: {
            Do: params.merge_method,
            head_commit_id: freshReadiness.headSha,
            delete_branch_after_merge: deleteBranch,
          },
        });
        await runtime.dashboard.refresh(signal);
        return toolResult(`Merged ${reference} with ${params.merge_method} at ${freshReadiness.headSha}`, {
          reference,
          method: params.merge_method,
          headSha: freshReadiness.headSha,
          deletedBranch: deleteBranch,
        });
      }
      const reviews = await client.request<ForgejoPullReview[]>(`${pullPath}/reviews`, {
        ...requestOptions,
        query: { page: params.page ?? 1, limit: positiveLimit(params.limit, 50) },
      });
      const bounded = boundModelText(formatPull(pull.data, reference, reviews.data), params.max_bytes ?? 200_000);
      return toolResult(bounded.text, {
        pull: pull.data,
        reviews: reviews.data,
        truncated: bounded.truncated,
        originalBytes: bounded.originalBytes,
        renderedBytes: bounded.renderedBytes,
      });
    },
  });
}
