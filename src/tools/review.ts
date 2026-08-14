import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { apiPath } from "../client.js";
import { formatResourceRef } from "../refs.js";
import type {
	ForgejoPullRequest,
	ForgejoPullReview,
	ForgejoPullReviewComment,
	ReviewDraft,
} from "../types.js";
import {
  boundModelText,
  DEFAULT_MODEL_OUTPUT_BYTES,
  modelOutputBytes,
  confirmMutation,
  formatForgejoReview,
  formatForgejoReviewComment,
  positiveLimit,
  resourceTargetProperties,
  toolResult,
  type RuntimeProvider,
} from "./common.js";

function draftSummary(draft: ReviewDraft): string {
  const reference = formatResourceRef(draft.ref);
  const lines = [
    `${reference} review draft`,
    `Verdict: ${draft.verdict}`,
    `Commit: ${draft.commitId ?? "unknown"}`,
    `Summary: ${draft.body || "(empty)"}`,
    `Inline comments: ${draft.comments.length}`,
  ];
  for (const comment of draft.comments) {
		const position = comment.newPosition
			? `new:${comment.newPosition}`
			: `old:${comment.oldPosition ?? 0}`;
    lines.push(`- ${comment.path}:${position} ${comment.body}`);
  }
  return lines.join("\n");
}

export function registerReviewTool(
	pi: ExtensionAPI,
	runtimeProvider: RuntimeProvider,
): void {
  pi.registerTool({
    name: "forgejo_review",
    label: "Forgejo Review",
		description:
			"Read complete remote reviews and inline comments or prepare an in-memory review draft. Submitting always previews and asks the user for confirmation.",
    parameters: Type.Object({
			action: StringEnum([
				"list",
				"get",
				"get_comments",
				"create_draft",
				"add_inline_comment",
				"preview",
				"submit",
				"discard",
			] as const),
      ...resourceTargetProperties,
      review_id: Type.Optional(Type.Integer({ minimum: 1 })),
			verdict: Type.Optional(
				StringEnum(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const),
			),
      body: Type.Optional(Type.String()),
			replace: Type.Optional(
				Type.Boolean({
					description: "Replace an existing in-memory review draft",
				}),
			),
      path: Type.Optional(Type.String()),
      new_position: Type.Optional(Type.Integer({ minimum: 1 })),
      old_position: Type.Optional(Type.Integer({ minimum: 1 })),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      max_bytes: modelOutputBytes(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runtime = runtimeProvider();
      const ref = runtime.resolveResource(params, "pull");
      const client = runtime.client(ref.server);
      const reference = formatResourceRef(ref);
			const pullPath = apiPath(
				"repos",
				ref.owner,
				ref.repo,
				"pulls",
				ref.index,
			);
      const reviewsPath = `${pullPath}/reviews`;
      const requestOptions = signal === undefined ? {} : { signal };

      if (params.action === "list") {
        const page = params.page ?? 1;
				const response = await client.request<ForgejoPullReview[]>(
					reviewsPath,
					{
          ...requestOptions,
          query: { page, limit: positiveLimit(params.limit, 50) },
					},
				);
        const text = [
          `Reviews for ${reference}: ${response.totalCount ?? response.data.length}`,
          ...response.data.map(formatForgejoReview),
          `Page: ${page}`,
        ].join("\n\n");
				const bounded = boundModelText(
					text,
					params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES,
				);
        return toolResult(bounded.text, {
          items: response.data,
          total: response.totalCount ?? response.data.length,
          page,
          truncated: bounded.truncated,
          originalBytes: bounded.originalBytes,
          renderedBytes: bounded.renderedBytes,
        });
      }
      if (params.action === "get" || params.action === "get_comments") {
				if (!params.review_id)
					throw new Error(`review_id is required for ${params.action}`);
        const commentsPath = `${reviewsPath}/${params.review_id}/comments`;
        if (params.action === "get_comments") {
					const response = await client.request<ForgejoPullReviewComment[]>(
						commentsPath,
						requestOptions,
					);
          const text = [
            `Review ${params.review_id} inline comments for ${reference}: ${response.data.length}`,
            ...response.data.map(formatForgejoReviewComment),
          ].join("\n\n");
					const bounded = boundModelText(
						text,
						params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES,
					);
          return toolResult(bounded.text, {
            reviewId: params.review_id,
            comments: response.data,
            truncated: bounded.truncated,
            originalBytes: bounded.originalBytes,
            renderedBytes: bounded.renderedBytes,
          });
        }
        const [review, comments] = await Promise.all([
					client.request<ForgejoPullReview>(
						`${reviewsPath}/${params.review_id}`,
						requestOptions,
					),
					client.request<ForgejoPullReviewComment[]>(
						commentsPath,
						requestOptions,
					),
        ]);
        const text = [
          `${formatForgejoReview(review.data)}`,
          `Inline comments (${comments.data.length}):`,
					comments.data.length > 0
						? comments.data.map(formatForgejoReviewComment).join("\n\n")
						: "(none)",
        ].join("\n\n");
				const bounded = boundModelText(
					text,
					params.max_bytes ?? DEFAULT_MODEL_OUTPUT_BYTES,
				);
        return toolResult(bounded.text, {
          review: review.data,
          comments: comments.data,
          truncated: bounded.truncated,
          originalBytes: bounded.originalBytes,
          renderedBytes: bounded.renderedBytes,
        });
      }

      const key = runtime.draftKey(ref);
      if (params.action === "create_draft") {
				if (!params.verdict)
					throw new Error("verdict is required for create_draft");
				if (runtime.drafts.has(key) && !params.replace) {
					throw new Error(
						`review draft already exists for ${reference}; pass replace=true to replace it`,
					);
				}
				const pull = await client.request<ForgejoPullRequest>(
					pullPath,
					requestOptions,
				);
        const draft: ReviewDraft = {
          ref,
          body: params.body ?? "",
          verdict: params.verdict,
          commitId: pull.data.head.sha,
          comments: [],
          createdAt: new Date().toISOString(),
        };
        runtime.drafts.set(key, draft);
        return toolResult(draftSummary(draft), draft);
      }

      const draft = runtime.drafts.get(key);
			if (!draft)
				throw new Error(
					`no review draft exists for ${reference}; create one first`,
				);
      if (params.action === "add_inline_comment") {
				if (!params.path || !params.body)
					throw new Error("path and body are required for add_inline_comment");
				if (!params.new_position && !params.old_position)
					throw new Error(
						"new_position or old_position is required for add_inline_comment",
					);
				const comment = {
					path: params.path,
					body: params.body,
				} as ReviewDraft["comments"][number];
				if (params.new_position !== undefined)
					comment.newPosition = params.new_position;
				if (params.old_position !== undefined)
					comment.oldPosition = params.old_position;
        draft.comments.push(comment);
        delete draft.previewedAt;
        return toolResult(draftSummary(draft), draft);
      }
      if (params.action === "preview") {
        draft.previewedAt = new Date().toISOString();
        return toolResult(draftSummary(draft), draft);
      }
      if (params.action === "discard") {
        runtime.drafts.delete(key);
				return toolResult(`Discarded review draft for ${reference}`, {
					discarded: true,
					ref,
				});
      }
			if (!draft.previewedAt)
				throw new Error(
					`review draft for ${reference} must be previewed before submit`,
				);

			const currentPull = await client.request<ForgejoPullRequest>(
				pullPath,
				requestOptions,
			);
      if (draft.commitId && currentPull.data.head.sha !== draft.commitId) {
				throw new Error(
					`pull request head changed from ${draft.commitId} to ${currentPull.data.head.sha}; rebuild the review draft`,
      );
			}
			await confirmMutation(ctx, "Submit Forgejo review", draftSummary(draft));
      const comments = draft.comments.map((comment) => ({
        path: comment.path,
        body: comment.body,
        new_position: comment.newPosition ?? 0,
        old_position: comment.oldPosition ?? 0,
      }));
      const response = await client.request<unknown>(reviewsPath, {
        ...requestOptions,
        method: "POST",
        body: {
          body: draft.body,
          event: draft.verdict,
          commit_id: draft.commitId,
          comments,
        },
      });
      runtime.drafts.delete(key);
      await runtime.dashboard.refreshIfObserved(signal);
			return toolResult(
				`Submitted ${draft.verdict} review for ${reference}`,
				response.data,
			);
    },
  });
}
