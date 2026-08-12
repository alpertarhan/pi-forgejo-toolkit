import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ForgejoRuntime } from "../runtime.js";
import type { ForgejoComment, ForgejoPullReview, ForgejoPullReviewComment, ForgejoTimelineEvent, ForgejoUser } from "../types.js";


export type RuntimeProvider = () => ForgejoRuntime;

export const DEFAULT_MODEL_OUTPUT_BYTES = 32_000;
export const DEFAULT_LARGE_MODEL_OUTPUT_BYTES = 64_000;
export const MAX_MODEL_OUTPUT_BYTES = 128_000;

export function modelOutputBytes(description = "Maximum model-visible output bytes; default 32 KB") {
  return Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_MODEL_OUTPUT_BYTES, description }));
}

export async function authenticatedUserName(runtime: ForgejoRuntime, server: string, signal?: AbortSignal): Promise<string> {
  const discovered = runtime.capabilities.get(server)?.user.login;
  if (discovered) return discovered;
  const response = await runtime.client(server).request<ForgejoUser>("user", signal === undefined ? {} : { signal });
  if (!response.data.login) throw new Error(`Forgejo ${server} did not return an authenticated username`);
  return response.data.login;
}

export const repoTargetProperties = {
  ref: Type.Optional(Type.String({ description: "Server-qualified Forgejo reference such as work:org/repo#12" })),
  server: Type.Optional(Type.String({ description: "Configured Forgejo server alias" })),
  owner: Type.Optional(Type.String({ description: "Repository owner" })),
  repo: Type.Optional(Type.String({ description: "Repository name" })),
};

export const resourceTargetProperties = {
  ...repoTargetProperties,
  index: Type.Optional(Type.Integer({ minimum: 1, description: "Issue or pull request number" })),
};

const MAX_PERSISTED_TOOL_DETAILS_BYTES = 16_000;
const MAX_COMPACT_DETAIL_VALUE_BYTES = 1_000;
const MAX_COMPACT_DETAIL_FIELDS = 12;

function compactPersistedToolDetails(data: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return { detailsTruncated: true, detailsReason: "not JSON-serializable" };
  }
  if (serialized === undefined) return data;
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= MAX_PERSISTED_TOOL_DETAILS_BYTES) return data;

  const compact: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let compactFields = 0;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (compactFields >= MAX_COMPACT_DETAIL_FIELDS) break;
      if (Buffer.byteLength(key, "utf8") > 128) continue;
      try {
        const candidate = JSON.stringify(value);
        if (candidate !== undefined && Buffer.byteLength(candidate, "utf8") <= MAX_COMPACT_DETAIL_VALUE_BYTES) {
          compact[key] = value;
          compactFields += 1;
        }
      } catch {
        // Skip only the non-serializable field; the compact envelope remains usable.
      }
    }
  }
  return { ...compact, detailsTruncated: true, detailsOriginalBytes: originalBytes };
}


export function toolResult(summary: string, data: unknown): { content: Array<{ type: "text"; text: string }>; details: { data: unknown } } {
  return {
    content: [{ type: "text", text: summary }],
    details: { data: compactPersistedToolDetails(data) },
  };
}

export interface BoundedText {
  text: string;
  truncated: boolean;
  originalBytes: number;
  renderedBytes: number;
}

function utf8Prefix(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

export function boundModelText(value: string, maximumBytes: number, notice?: string): BoundedText {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= maximumBytes) {
    return { text: value, truncated: false, originalBytes, renderedBytes: originalBytes };
  }
  const suffix = notice ?? `\n\n[output truncated at ${maximumBytes} bytes]`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const text =
    suffixBytes >= maximumBytes
      ? utf8Prefix(suffix, maximumBytes)
      : `${utf8Prefix(value, maximumBytes - suffixBytes)}${suffix}`;
  return {
    text,
    truncated: true,
    originalBytes,
    renderedBytes: Buffer.byteLength(text, "utf8"),
  };
}

export function boundModelTextWithSuffix(value: string, suffix: string, maximumBytes: number): BoundedText {
  const complete = `${value}${suffix}`;
  const originalBytes = Buffer.byteLength(complete, "utf8");
  if (originalBytes <= maximumBytes) {
    return { text: complete, truncated: false, originalBytes, renderedBytes: originalBytes };
  }
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const text =
    suffixBytes >= maximumBytes
      ? utf8Prefix(suffix, maximumBytes)
      : `${utf8Prefix(value, maximumBytes - suffixBytes)}${suffix}`;
  return {
    text,
    truncated: true,
    originalBytes,
    renderedBytes: Buffer.byteLength(text, "utf8"),
  };
}

export function formatForgejoComment(comment: ForgejoComment): string {
  const author = comment.user?.login ? `@${comment.user.login}` : comment.original_author || "unknown";
  const edited = comment.updated_at !== comment.created_at ? `, edited ${comment.updated_at}` : "";
  const lines = [`Comment ${comment.id} by ${author} at ${comment.created_at}${edited}`, comment.body || "(empty)"];
  if (comment.assets?.length) {
    lines.push(
      `Attachments: ${comment.assets
        .map((asset) => (asset.browser_download_url ? `${asset.name} (${asset.browser_download_url})` : asset.name))
        .join(", ")}`,
    );
  }
  if (comment.html_url) lines.push(`URL: ${comment.html_url}`);
  return lines.join("\n");
}

export function assertForgejoCommentTarget(comment: ForgejoComment, index: number, reference: string): void {
  const indexes = [comment.issue_url, comment.pull_request_url, comment.html_url].flatMap((url) => {
    const match = url?.match(/\/(?:issues|pulls)\/(\d+)(?:[/?#]|$)/);
    return match?.[1] ? [Number(match[1])] : [];
  });
  if (indexes.includes(index)) return;
  if (indexes.length === 0) {
    throw new Error(`cannot verify that comment ${comment.id} belongs to ${reference}`);
  }
  throw new Error(`comment ${comment.id} belongs to #${indexes.join(" or #")}, not ${reference}`);
}

export function formatForgejoReview(review: ForgejoPullReview): string {
  const reviewer = review.user?.login ? `@${review.user.login}` : review.team?.name ? `team:${review.team.name}` : "unknown";
  const lines = [
    `Review ${review.id} by ${reviewer} [${review.state}]`,
    `Commit: ${review.commit_id ?? "unknown"}`,
    `Submitted: ${review.submitted_at ?? "unknown"}`,
    `Updated: ${review.updated_at ?? "unknown"}`,
    `Official: ${review.official === undefined ? "unknown" : review.official ? "yes" : "no"}`,
    `Stale: ${review.stale ? "yes" : "no"}`,
    `Dismissed: ${review.dismissed ? "yes" : "no"}`,
    `Inline comments: ${review.comments_count ?? "unknown"}`,
    "",
    "Body:",
    review.body || "(empty)",
  ];
  if (review.html_url) lines.push("", `URL: ${review.html_url}`);
  return lines.join("\n");
}

export function formatForgejoReviewComment(comment: ForgejoPullReviewComment): string {
  const author = comment.user?.login ? `@${comment.user.login}` : "unknown";
  const edited = comment.updated_at !== comment.created_at ? `, edited ${comment.updated_at}` : "";
  const positions = [`current ${comment.position}`];
  if (comment.original_position !== undefined) positions.push(`original ${comment.original_position}`);
  const lines = [
    `Inline comment ${comment.id} by ${author} at ${comment.created_at}${edited}`,
    `File: ${comment.path} (${positions.join(", ")})`,
    `Commit: ${comment.commit_id}`,
  ];
  if (comment.original_commit_id) lines.push(`Original commit: ${comment.original_commit_id}`);
  if (comment.resolver) lines.push(`Resolved by: @${comment.resolver.login}`);
  if (comment.diff_hunk) lines.push("", "Diff hunk:", comment.diff_hunk);
  lines.push("", "Comment:", comment.body || "(empty)");
  if (comment.html_url) lines.push("", `URL: ${comment.html_url}`);
  return lines.join("\n");
}

function timelineActor(event: ForgejoTimelineEvent): string {
  return event.user?.login ? `@${event.user.login}` : "system";
}

function issueEventReference(event: ForgejoTimelineEvent): string | undefined {
  const issue = event.ref_issue ?? event.dependent_issue;
  if (!issue) return undefined;
  const repository = issue.repository?.full_name;
  const reference = repository ? `${repository}#${issue.number}` : `#${issue.number}`;
  return `${reference} ${issue.title}`;
}

export function formatTimelineEvent(event: ForgejoTimelineEvent): string {
  const updated = event.updated_at && event.updated_at !== event.created_at ? `, updated ${event.updated_at}` : "";
  const lines = [`${event.created_at} ${timelineActor(event)} [${event.type} #${event.id}${updated}]`];
  if (event.body?.trim()) lines.push(event.body);
  if (event.old_title || event.new_title) lines.push(`Title: ${event.old_title || "(empty)"} -> ${event.new_title || "(empty)"}`);
  if (event.old_ref || event.new_ref) lines.push(`Ref: ${event.old_ref || "(none)"} -> ${event.new_ref || "(none)"}`);
  if (event.label) lines.push(`Label: ${event.label.name}`);
  if (event.assignee) lines.push(`Assignee ${event.removed_assignee ? "removed" : "added"}: @${event.assignee.login}`);
  if (event.assignee_team) lines.push(`Team ${event.removed_assignee ? "removed" : "added"}: ${event.assignee_team.name}`);
  if (event.old_milestone || event.milestone) {
    lines.push(`Milestone: ${event.old_milestone?.title ?? "(none)"} -> ${event.milestone?.title ?? "(none)"}`);
  }
  if (event.old_project_id || event.project_id) {
    lines.push(`Project: ${event.old_project_id || "(none)"} -> ${event.project_id || "(none)"}`);
  }
  if (event.review_id) lines.push(`Review: ${event.review_id}`);
  if (event.ref_action) lines.push(`Reference action: ${event.ref_action}`);
  if (event.ref_commit_sha) lines.push(`Commit: ${event.ref_commit_sha}`);
  const relatedIssue = issueEventReference(event);
  if (relatedIssue) lines.push(`Related issue: ${relatedIssue}`);
  if (event.ref_comment) lines.push(`Related comment: ${event.ref_comment.id}`);
  if (event.tracked_time?.time !== undefined) lines.push(`Tracked time: ${event.tracked_time.time} seconds`);
  if (event.resolve_doer) lines.push(`Resolved by: @${event.resolve_doer.login}`);
  if (event.html_url) lines.push(`URL: ${event.html_url}`);
  return lines.join("\n");
}

interface TimelinePageDetails {
  reference: string;
  page: number;
  limit: number;
  items: ForgejoTimelineEvent[];
  returned: number;
  hasMore: boolean;
  truncated: boolean;
  originalBytes: number;
  renderedBytes: number;
  total?: number;
  nextPage?: number;
}

export function timelineToolResult(
  reference: string,
  events: ForgejoTimelineEvent[],
  page: number,
  limit: number,
  totalCount: number | undefined,
  maximumBytes: number,
): ReturnType<typeof toolResult> {
  const hasMore = totalCount === undefined ? events.length === limit : page * limit < totalCount;
  const nextPage = hasMore ? page + 1 : undefined;
  const body = [`Timeline ${reference} — page ${page}`, ...events.map(formatTimelineEvent)].join("\n\n");
  const footer = (truncated: boolean): string =>
    [
      "",
      `Page: ${page}`,
      `Returned: ${events.length}`,
      `Total: ${totalCount ?? "unknown"}`,
      `Has more: ${hasMore ? "yes" : "no"}`,
      `Next page: ${nextPage ?? "none"}`,
      `Truncated: ${truncated ? "yes" : "no"}`,
      ...(truncated ? [`Recovery: repeat page ${page} with a smaller limit or narrower since/before filters`] : []),
    ].join("\n");
  let bounded = boundModelTextWithSuffix(body, `\n${footer(false)}`, maximumBytes);
  if (bounded.truncated) bounded = boundModelTextWithSuffix(body, `\n${footer(true)}`, maximumBytes);
  const details: TimelinePageDetails = {
    reference,
    page,
    limit,
    items: events,
    returned: events.length,
    hasMore,
    truncated: bounded.truncated,
    originalBytes: bounded.originalBytes,
    renderedBytes: bounded.renderedBytes,
  };
  if (totalCount !== undefined) details.total = totalCount;
  if (nextPage !== undefined) details.nextPage = nextPage;
  return toolResult(bounded.text, details);
}

export async function confirmMutation(ctx: ExtensionContext, title: string, message: string): Promise<void> {
  if (!ctx.hasUI) throw new Error(`${title} requires interactive confirmation`);
  const accepted = await ctx.ui.confirm(title, message);
  if (!accepted) throw new Error(`${title} cancelled by user`);
}

export function positiveLimit(value: number | undefined, fallback = 20, maximum = 100): number {
  if (value === undefined) return fallback;
  return Math.min(maximum, Math.max(1, value));
}
