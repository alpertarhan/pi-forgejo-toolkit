import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { apiPath, type ForgejoClient } from "../client.js";
import { loadGlobalAllowedMutations } from "../config.js";
import { saveAllowedMutation } from "../config-storage.js";
import type { MutationApprovalKey } from "../mutation-approvals.js";
import type { ForgejoRuntime } from "../runtime.js";
import type {
	ForgejoComment,
	ForgejoIssue,
	ForgejoLabel,
	ForgejoPullReview,
	ForgejoPullReviewComment,
	ForgejoTimelineEvent,
	ForgejoUser,
	ForgejoWatchInfo,
	ResourceRef,
} from "../types.js";
import {
	labelIds,
	milestoneId,
	normalizedDueDate,
	uniqueNames,
} from "./metadata.js";

export type RuntimeProvider = () => ForgejoRuntime;

export const DEFAULT_MODEL_OUTPUT_BYTES = 32_000;
export const DEFAULT_LARGE_MODEL_OUTPUT_BYTES = 64_000;
const MAX_MODEL_OUTPUT_BYTES = 128_000;

export function modelOutputBytes(
	description = "Maximum model-visible output bytes; default 32 KB",
) {
	return Type.Optional(
		Type.Integer({
			minimum: 1_000,
			maximum: MAX_MODEL_OUTPUT_BYTES,
			description,
		}),
	);
}

async function authenticatedUserName(
	runtime: ForgejoRuntime,
	server: string,
	signal?: AbortSignal,
): Promise<string> {
	const discovered = runtime.capabilities.get(server)?.user.login;
	if (discovered) return discovered;
	const response = await runtime
		.client(server)
		.request<ForgejoUser>("user", signal === undefined ? {} : { signal });
	if (!response.data.login)
		throw new Error(`Forgejo ${server} did not return an authenticated username`);
	return response.data.login;
}

export const repoTargetProperties = {
	ref: Type.Optional(
		Type.String({
			description: "Server-qualified Forgejo reference such as work:org/repo#12",
		}),
	),
	server: Type.Optional(
		Type.String({ description: "Configured Forgejo server alias" }),
	),
	owner: Type.Optional(Type.String({ description: "Repository owner" })),
	repo: Type.Optional(Type.String({ description: "Repository name" })),
};

export const resourceTargetProperties = {
	...repoTargetProperties,
	index: Type.Optional(
		Type.Integer({ minimum: 1, description: "Issue or pull request number" }),
	),
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

	const compact: Record<string, unknown> = Object.create(null) as Record<
		string,
		unknown
	>;
	let compactFields = 0;
	if (typeof data === "object" && data !== null && !Array.isArray(data)) {
		for (const [key, value] of Object.entries(data)) {
			if (compactFields >= MAX_COMPACT_DETAIL_FIELDS) break;
			if (Buffer.byteLength(key, "utf8") > 128) continue;
			try {
				const candidate = JSON.stringify(value);
				if (
					candidate !== undefined &&
					Buffer.byteLength(candidate, "utf8") <= MAX_COMPACT_DETAIL_VALUE_BYTES
				) {
					compact[key] = value;
					compactFields += 1;
				}
			} catch {
				// Skip only the non-serializable field; the compact envelope remains usable.
			}
		}
	}
	return {
		...compact,
		detailsTruncated: true,
		detailsOriginalBytes: originalBytes,
	};
}

export function toolResult(
	summary: string,
	data: unknown,
): {
	content: Array<{ type: "text"; text: string }>;
	details: { data: unknown };
} {
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

export function boundModelText(
	value: string,
	maximumBytes: number,
	notice?: string,
): BoundedText {
	const originalBytes = Buffer.byteLength(value, "utf8");
	if (originalBytes <= maximumBytes) {
		return {
			text: value,
			truncated: false,
			originalBytes,
			renderedBytes: originalBytes,
		};
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

export function boundModelTextWithSuffix(
	value: string,
	suffix: string,
	maximumBytes: number,
): BoundedText {
	const complete = `${value}${suffix}`;
	const originalBytes = Buffer.byteLength(complete, "utf8");
	if (originalBytes <= maximumBytes) {
		return {
			text: complete,
			truncated: false,
			originalBytes,
			renderedBytes: originalBytes,
		};
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
	const author = comment.user?.login
		? `@${comment.user.login}`
		: comment.original_author || "unknown";
	const edited =
		comment.updated_at === comment.created_at
			? ""
			: `, edited ${comment.updated_at}`;
	const lines = [
		`Comment ${comment.id} by ${author} at ${comment.created_at}${edited}`,
		comment.body || "(empty)",
	];
	if (comment.assets?.length) {
		lines.push(
			`Attachments: ${comment.assets
				.map((asset) =>
					asset.browser_download_url
						? `${asset.name} (${asset.browser_download_url})`
						: asset.name,
				)
				.join(", ")}`,
		);
	}
	if (comment.html_url) lines.push(`URL: ${comment.html_url}`);
	return lines.join("\n");
}

export function assertForgejoCommentTarget(
	comment: ForgejoComment,
	index: number,
	reference: string,
): void {
	const indexes = [
		comment.issue_url,
		comment.pull_request_url,
		comment.html_url,
	].flatMap((url) => {
		const match = url?.match(/\/(?:issues|pulls)\/(\d+)(?:[/?#]|$)/);
		return match?.[1] ? [Number(match[1])] : [];
	});
	if (indexes.includes(index)) return;
	if (indexes.length === 0) {
		throw new Error(
			`cannot verify that comment ${comment.id} belongs to ${reference}`,
		);
	}
	throw new Error(
		`comment ${comment.id} belongs to #${indexes.join(" or #")}, not ${reference}`,
	);
}

export function formatForgejoReview(review: ForgejoPullReview): string {
	const reviewer = review.user?.login
		? `@${review.user.login}`
		: review.team?.name
			? `team:${review.team.name}`
			: "unknown";
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

export function formatForgejoReviewComment(
	comment: ForgejoPullReviewComment,
): string {
	const author = comment.user?.login ? `@${comment.user.login}` : "unknown";
	const edited =
		comment.updated_at === comment.created_at
			? ""
			: `, edited ${comment.updated_at}`;
	const positions = [`current ${comment.position}`];
	if (comment.original_position !== undefined)
		positions.push(`original ${comment.original_position}`);
	const lines = [
		`Inline comment ${comment.id} by ${author} at ${comment.created_at}${edited}`,
		`File: ${comment.path} (${positions.join(", ")})`,
		`Commit: ${comment.commit_id}`,
	];
	if (comment.original_commit_id)
		lines.push(`Original commit: ${comment.original_commit_id}`);
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
	const reference = repository
		? `${repository}#${issue.number}`
		: `#${issue.number}`;
	return `${reference} ${issue.title}`;
}

export function formatTimelineEvent(event: ForgejoTimelineEvent): string {
	const updated =
		event.updated_at && event.updated_at !== event.created_at
			? `, updated ${event.updated_at}`
			: "";
	const lines = [
		`${event.created_at} ${timelineActor(event)} [${event.type} #${event.id}${updated}]`,
	];
	if (event.body?.trim()) lines.push(event.body);
	if (event.old_title || event.new_title)
		lines.push(
			`Title: ${event.old_title || "(empty)"} -> ${event.new_title || "(empty)"}`,
		);
	if (event.old_ref || event.new_ref)
		lines.push(
			`Ref: ${event.old_ref || "(none)"} -> ${event.new_ref || "(none)"}`,
		);
	if (event.label) lines.push(`Label: ${event.label.name}`);
	if (event.assignee)
		lines.push(
			`Assignee ${event.removed_assignee ? "removed" : "added"}: @${event.assignee.login}`,
		);
	if (event.assignee_team)
		lines.push(
			`Team ${event.removed_assignee ? "removed" : "added"}: ${event.assignee_team.name}`,
		);
	if (event.old_milestone || event.milestone) {
		lines.push(
			`Milestone: ${event.old_milestone?.title ?? "(none)"} -> ${event.milestone?.title ?? "(none)"}`,
		);
	}
	if (event.old_project_id || event.project_id) {
		lines.push(
			`Project: ${event.old_project_id || "(none)"} -> ${event.project_id || "(none)"}`,
		);
	}
	if (event.review_id) lines.push(`Review: ${event.review_id}`);
	if (event.ref_action) lines.push(`Reference action: ${event.ref_action}`);
	if (event.ref_commit_sha) lines.push(`Commit: ${event.ref_commit_sha}`);
	const relatedIssue = issueEventReference(event);
	if (relatedIssue) lines.push(`Related issue: ${relatedIssue}`);
	if (event.ref_comment) lines.push(`Related comment: ${event.ref_comment.id}`);
	if (event.tracked_time?.time !== undefined)
		lines.push(`Tracked time: ${event.tracked_time.time} seconds`);
	if (event.resolve_doer)
		lines.push(`Resolved by: @${event.resolve_doer.login}`);
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
	const hasMore =
		totalCount === undefined
			? events.length === limit
			: page * limit < totalCount;
	const nextPage = hasMore ? page + 1 : undefined;
	const body = [
		`Timeline ${reference} — page ${page}`,
		...events.map(formatTimelineEvent),
	].join("\n\n");
	const footer = (truncated: boolean): string =>
		[
			"",
			`Page: ${page}`,
			`Returned: ${events.length}`,
			`Total: ${totalCount ?? "unknown"}`,
			`Has more: ${hasMore ? "yes" : "no"}`,
			`Next page: ${nextPage ?? "none"}`,
			`Truncated: ${truncated ? "yes" : "no"}`,
			...(truncated
				? [
						`Recovery: repeat page ${page} with a smaller limit or narrower since/before filters`,
					]
				: []),
		].join("\n");
	let bounded = boundModelTextWithSuffix(
		body,
		`\n${footer(false)}`,
		maximumBytes,
	);
	if (bounded.truncated)
		bounded = boundModelTextWithSuffix(body, `\n${footer(true)}`, maximumBytes);
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

type ToolResult = ReturnType<typeof toolResult>;
type CommentAction = "get_comment" | "edit_comment" | "delete_comment";
type SubscriptionAction = "subscription" | "subscribe" | "unsubscribe";
type PlanningAction =
	| "set_labels"
	| "set_assignees"
	| "set_milestone"
	| "clear_milestone"
	| "set_due_date"
	| "clear_due_date";

interface PlanningResource extends ForgejoIssue {
	labels?: Array<{ id: number; name: string }>;
}

function requestSignal(signal?: AbortSignal): { signal?: AbortSignal } {
	return signal === undefined ? {} : { signal };
}

export async function createConversationComment(
	runtime: ForgejoRuntime,
	client: ForgejoClient,
	commentsPath: string,
	reference: string,
	body: string | undefined,
	resourceName: "issue" | "pull request",
	signal?: AbortSignal,
): Promise<ToolResult> {
	if (!body) throw new Error(`body is required to comment on a ${resourceName}`);
	const response = await client.request<ForgejoComment>(commentsPath, {
		method: "POST",
		body: { body },
		...requestSignal(signal),
	});
	await runtime.dashboard.refreshIfObserved(signal);
	return toolResult(
		`Commented on ${reference}\n\n${formatForgejoComment(response.data)}`,
		response.data,
	);
}

export async function handleConversationComment(
	runtime: ForgejoRuntime,
	client: ForgejoClient,
	ref: ResourceRef,
	reference: string,
	action: CommentAction,
	commentId: number | undefined,
	body: string | undefined,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<ToolResult> {
	if (commentId === undefined)
		throw new Error(`comment_id is required for ${action}`);
	if (action === "edit_comment" && body === undefined) {
		throw new Error(
			"body is required to edit a comment; use an empty string to clear it",
		);
	}
	const commentPath = apiPath(
		"repos",
		ref.owner,
		ref.repo,
		"issues",
		"comments",
		commentId,
	);
	const current = await client.request<ForgejoComment>(
		commentPath,
		requestSignal(signal),
	);
	assertForgejoCommentTarget(current.data, ref.index, reference);
	if (action === "get_comment") {
		return toolResult(
			`Comment on ${reference}\n\n${formatForgejoComment(current.data)}`,
			current.data,
		);
	}
	if (action === "edit_comment") {
		const response = await client.request<ForgejoComment>(commentPath, {
			method: "PATCH",
			body: { body },
			...requestSignal(signal),
		});
		await runtime.dashboard.refreshIfObserved(signal);
		return toolResult(
			`Edited comment ${commentId} on ${reference}\n\n${formatForgejoComment(response.data)}`,
			response.data,
		);
	}
	const preview = boundModelText(current.data.body || "(empty)", 2_000);
	const label = ref.kind === "pull" ? "pull request" : "issue";
	const marker = ref.kind === "pull" ? "!" : "#";
	await confirmMutation(runtime, ctx, {
		signal,
		approval:
			ref.kind === "pull" ? "comment.pull.delete" : "comment.issue.delete",
		title: `Delete Forgejo ${label} comment`,
		message: `Server: ${ref.server}\nRepository: ${ref.owner}/${ref.repo}\n${ref.kind === "pull" ? "Pull request" : "Issue"}: ${marker}${ref.index}\nComment: ${commentId}\nCurrent comment body:\n${preview.text}`,
	});
	await client.request<void>(commentPath, {
		method: "DELETE",
		...requestSignal(signal),
	});
	await runtime.dashboard.refreshIfObserved(signal);
	return toolResult(`Deleted comment ${commentId} from ${reference}`, {
		reference,
		commentId,
		deleted: true,
	});
}

export async function handleSubscription(
	runtime: ForgejoRuntime,
	client: ForgejoClient,
	ref: ResourceRef,
	reference: string,
	action: SubscriptionAction,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const issuePath = apiPath("repos", ref.owner, ref.repo, "issues", ref.index);
	const checkPath = `${issuePath}/subscriptions/check`;
	if (action === "subscription") {
		const response = await client.request<ForgejoWatchInfo>(
			checkPath,
			requestSignal(signal),
		);
		return toolResult(
			`Subscription for ${reference}: ${response.data.subscribed ? "subscribed" : "not subscribed"}${response.data.ignored ? ", ignored" : ""}`,
			response.data,
		);
	}
	const user = await authenticatedUserName(runtime, ref.server, signal);
	await client.request<void>(
		`${issuePath}/subscriptions/${encodeURIComponent(user)}`,
		{
			method: action === "subscribe" ? "PUT" : "DELETE",
			...requestSignal(signal),
		},
	);
	const response = await client.request<ForgejoWatchInfo>(
		checkPath,
		requestSignal(signal),
	);
	const expected = action === "subscribe";
	if (response.data.subscribed !== expected) {
		throw new Error(
			`Forgejo did not ${expected ? "subscribe to" : "unsubscribe from"} ${reference}`,
		);
	}
	await runtime.dashboard.refreshIfObserved(signal);
	return toolResult(
		`${expected ? "Subscribed to" : "Unsubscribed from"} ${reference} as @${user}`,
		{
			user,
			...response.data,
		},
	);
}

interface PlanningMutationParams {
	labels?: string[];
	assignees?: string[];
	milestone?: string;
	milestone_id?: number;
	due_date?: string;
}

interface PlanningMutationOptions<T extends PlanningResource> {
	runtime: ForgejoRuntime;
	client: ForgejoClient;
	ref: ResourceRef;
	reference: string;
	resourcePath: string;
	action: PlanningAction;
	params: PlanningMutationParams;
	summary: (prefix: string, resource: T, reference: string) => string;
	signal: AbortSignal | undefined;
}

export async function handlePlanningMutation<T extends PlanningResource>(
	options: PlanningMutationOptions<T>,
): Promise<ToolResult> {
	const {
		runtime,
		client,
		ref,
		reference,
		resourcePath,
		action,
		params,
		summary,
		signal,
	} = options;
	if (action === "set_labels") {
		if (!params.labels)
			throw new Error(
				"labels is required for set_labels; use an empty list to clear labels",
			);
		const ids = await labelIds(
			client,
			ref.owner,
			ref.repo,
			params.labels,
			signal,
		);
		const response =
			ref.kind === "issue"
				? await client.request<ForgejoLabel[]>(`${resourcePath}/labels`, {
						method: "PUT",
						body: { labels: ids },
						...requestSignal(signal),
					})
				: await client.request<T>(resourcePath, {
						method: "PATCH",
						body: { labels: ids },
						...requestSignal(signal),
					});
		const labels = Array.isArray(response.data)
			? response.data
			: (response.data.labels ?? []);
		const actual = new Set(labels.map((label) => label.id));
		if (actual.size !== ids.length || ids.some((id) => !actual.has(id))) {
			throw new Error(
				`Forgejo did not apply the requested labels to ${reference}`,
			);
		}
		await runtime.dashboard.refreshIfObserved(signal);
		return toolResult(
			`Set labels on ${reference}: ${params.labels.join(", ") || "none"}`,
			response.data,
		);
	}
	if (action === "set_assignees") {
		if (!params.assignees)
			throw new Error(
				"assignees is required for set_assignees; use an empty list to clear assignees",
			);
		const assignees = uniqueNames(params.assignees, "assignees");
		const response = await client.request<T>(resourcePath, {
			method: "PATCH",
			body: { assignees },
			...requestSignal(signal),
		});
		const actual = new Set(
			response.data.assignees?.map((user) => user.login.toLowerCase()) ?? [],
		);
		if (
			actual.size !== assignees.length ||
			assignees.some((name) => !actual.has(name.toLowerCase()))
		) {
			throw new Error(
				`Forgejo did not apply the requested assignees to ${reference}`,
			);
		}
		await runtime.dashboard.refreshIfObserved(signal);
		return toolResult(
			summary("Updated assignees on", response.data, reference),
			response.data,
		);
	}
	if (action === "set_milestone" || action === "clear_milestone") {
		const id =
			action === "clear_milestone"
				? 0
				: await milestoneId(
						client,
						ref.owner,
						ref.repo,
						params.milestone,
						params.milestone_id,
						signal,
					);
		const response = await client.request<T>(resourcePath, {
			method: "PATCH",
			body: { milestone: id },
			...requestSignal(signal),
		});
		const actual = response.data.milestone?.id ?? 0;
		if (actual !== id)
			throw new Error(
				`Forgejo did not ${id === 0 ? "clear" : "set"} the requested milestone on ${reference}`,
			);
		await runtime.dashboard.refreshIfObserved(signal);
		return toolResult(
			`${id === 0 ? "Cleared milestone on" : `Set milestone '${response.data.milestone?.title ?? id}' on`} ${reference}`,
			response.data,
		);
	}
	if (action === "set_due_date" && params.due_date === undefined) {
		throw new Error("due_date is required for set_due_date");
	}
	const dueDate =
		action === "set_due_date"
			? normalizedDueDate(params.due_date ?? "")
			: undefined;
	const response = await client.request<T>(resourcePath, {
		method: "PATCH",
		body:
			dueDate === undefined ? { unset_due_date: true } : { due_date: dueDate },
		...requestSignal(signal),
	});
	if (
		dueDate === undefined
			? Boolean(response.data.due_date)
			: Date.parse(response.data.due_date ?? "") !== Date.parse(dueDate)
	) {
		throw new Error(
			`Forgejo did not ${dueDate === undefined ? "clear" : "set"} the requested due date on ${reference}`,
		);
	}
	await runtime.dashboard.refreshIfObserved(signal);
	return toolResult(
		`${dueDate === undefined ? "Cleared due date on" : `Set due date ${dueDate} on`} ${reference}`,
		response.data,
	);
}

const ALLOW_ONCE = "Allow once";
const ALWAYS_THIS_SESSION =
	"Always allow on all servers and repositories this session";
const ALWAYS_SAVED =
	"Always allow on all servers and repositories (save globally)";
const MUTATION_CANCEL = "Cancel";

interface MutationConfirmation {
	approval: MutationApprovalKey;
	title: string;
	message: string;
	signal?: AbortSignal | undefined;
}

export async function confirmMutation(
	runtime: ForgejoRuntime,
	ctx: ExtensionContext,
	confirmation: MutationConfirmation,
): Promise<void> {
	const { approval, title, message, signal } = confirmation;
	signal?.throwIfAborted();
	// Persistent (global config) and session approvals apply even without a UI,
	// so approved mutations also work in print/JSON mode.
	if (runtime.sessionMutationApprovals.has(approval)) return;
	const globallyAllowed = await loadGlobalAllowedMutations(
		runtime.globalConfigPath,
	);
	if (globallyAllowed.includes(approval)) return;
	if (!ctx.hasUI) throw new Error(`${title} requires interactive confirmation`);
	const prompt = `${title}\n\n${message}\n\nApprove this mutation?`;
	const choices = [
		ALLOW_ONCE,
		ALWAYS_THIS_SESSION,
		ALWAYS_SAVED,
		MUTATION_CANCEL,
	];
	const choice = signal
		? await ctx.ui.select(prompt, choices, { signal })
		: await ctx.ui.select(prompt, choices);
	signal?.throwIfAborted();
	if (choice === ALWAYS_SAVED) {
		runtime.sessionMutationApprovals.add(approval);
		try {
			await saveAllowedMutation(runtime.globalConfigPath, approval);
		} catch (error) {
			ctx.ui.notify(
				`Could not save approval for "${title}": ${
					error instanceof Error ? error.message : String(error)
				}. Approved for this session only.`,
				"warning",
			);
		}
		return;
	}
	if (choice === ALWAYS_THIS_SESSION)
		runtime.sessionMutationApprovals.add(approval);
	else if (choice !== ALLOW_ONCE) throw new Error(`${title} cancelled by user`);
}

export function positiveLimit(
	value: number | undefined,
	fallback = 20,
	maximum = 100,
): number {
	if (value === undefined) return fallback;
	return Math.min(maximum, Math.max(1, value));
}
