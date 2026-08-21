import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ForgejoClient } from "../src/client.js";
import type { ForgejoRuntime } from "../src/runtime.js";
import { registerReviewTool } from "../src/tools/review.js";
import type { ResourceRef, ReviewDraft } from "../src/types.js";

interface CapturedTool {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<unknown>;
}

function captureReviewTool(runtime: ForgejoRuntime): CapturedTool {
	let captured: CapturedTool | undefined;
	const api = {
		registerTool(definition: CapturedTool) {
			captured = definition;
		},
	} as unknown as ExtensionAPI;
	registerReviewTool(api, () => runtime);
	if (!captured) throw new Error("review tool was not registered");
	return captured;
}

function fakeRuntime(heads: string[], postState = "APPROVED") {
	const ref: ResourceRef = {
		server: "work",
		owner: "acme",
		repo: "app",
		kind: "pull",
		index: 9,
	};
	const drafts = new Map<string, ReviewDraft>();
	const request = vi.fn(
		async (_path: string, options?: { method?: string; body?: unknown }) => {
			if (options?.method === "POST") {
				return {
					data: { id: 77, state: postState },
					status: 200,
					headers: new Headers(),
				};
			}
			const sha = heads.shift() ?? "same-sha";
			return {
				data: {
					id: 9,
					number: 9,
					title: "Change",
					state: "open",
					html_url: "https://work.example/acme/app/pulls/9",
					updated_at: "2026-08-12T10:00:00Z",
					head: { ref: "feature", sha },
					base: { ref: "main", sha: "base" },
				},
				status: 200,
				headers: new Headers(),
			};
		},
	);
	const runtime = {
		sessionMutationApprovals: new Set<string>(),
		globalConfigPath: ".test-no-forgejo-config.json",
		resolveResource: () => ref,
		client: () => ({ request }) as unknown as ForgejoClient,
		draftKey: () => "work:acme/app!9",
		drafts,
		dashboard: {
			refresh: vi.fn(async () => undefined),
			refreshIfObserved: vi.fn(async () => undefined),
		},
	} as unknown as ForgejoRuntime;
	return { runtime, request, drafts };
}

const target = {
	action: "create_draft",
	ref: "work:acme/app!9",
	verdict: "APPROVED",
	body: "Looks correct",
};
const signal = new AbortController().signal;

describe("forgejo_review submission safety", () => {
	it("does not publish without interactive confirmation", async () => {
		const fixture = fakeRuntime(["head-sha", "head-sha"]);
		const tool = captureReviewTool(fixture.runtime);
		const noUi = { hasUI: false } as ExtensionContext;
		await tool.execute("create", target, signal, undefined, noUi);
		await tool.execute(
			"preview",
			{ action: "preview", ref: "work:acme/app!9" },
			signal,
			undefined,
			noUi,
		);
		await expect(
			tool.execute(
				"submit",
				{ action: "submit", ref: "work:acme/app!9" },
				signal,
				undefined,
				noUi,
			),
		).rejects.toThrow("requires interactive confirmation");
		expect(
			fixture.request.mock.calls.some((call) => call[1]?.method === "POST"),
		).toBe(false);
		expect(fixture.drafts.has("work:acme/app!9")).toBe(true);
	});

	it("requires replace=true before overwriting an existing draft", async () => {
		const fixture = fakeRuntime(["head-sha", "head-sha"]);
		const tool = captureReviewTool(fixture.runtime);
		const noUi = { hasUI: false } as ExtensionContext;
		await tool.execute("create", target, signal, undefined, noUi);
		await expect(
			tool.execute("replace", target, signal, undefined, noUi),
		).rejects.toThrow("pass replace=true");
		await expect(
			tool.execute(
				"replace",
				{ ...target, replace: true, body: "Replacement" },
				signal,
				undefined,
				noUi,
			),
		).resolves.toBeDefined();
		expect(fixture.drafts.get("work:acme/app!9")?.body).toBe("Replacement");
	});

	it("requires an explicit preview before submission", async () => {
		const fixture = fakeRuntime(["head-sha"]);
		const tool = captureReviewTool(fixture.runtime);
		const select = vi.fn(async () => "Allow once");
		const ui = { hasUI: true, ui: { select } } as unknown as ExtensionContext;
		await tool.execute("create", target, signal, undefined, ui);
		await expect(
			tool.execute(
				"submit",
				{ action: "submit", ref: "work:acme/app!9" },
				signal,
				undefined,
				ui,
			),
		).rejects.toThrow("must be previewed before submit");
		expect(select).not.toHaveBeenCalled();
		expect(fixture.request).toHaveBeenCalledOnce();
	});

	it("rejects a stale draft before prompting or publishing", async () => {
		const fixture = fakeRuntime(["old-sha", "new-sha"]);
		const tool = captureReviewTool(fixture.runtime);
		const select = vi.fn(async () => "Allow once");
		const ui = { hasUI: true, ui: { select } } as unknown as ExtensionContext;
		await tool.execute("create", target, signal, undefined, ui);
		await tool.execute(
			"preview",
			{ action: "preview", ref: "work:acme/app!9" },
			signal,
			undefined,
			ui,
		);
		await expect(
			tool.execute(
				"submit",
				{ action: "submit", ref: "work:acme/app!9" },
				signal,
				undefined,
				ui,
			),
		).rejects.toThrow("pull request head changed from old-sha to new-sha");
		expect(select).not.toHaveBeenCalled();
		expect(
			fixture.request.mock.calls.some((call) => call[1]?.method === "POST"),
		).toBe(false);
	});

	it("publishes the complete draft only after confirmation", async () => {
		const fixture = fakeRuntime(["head-sha", "head-sha"]);
		const tool = captureReviewTool(fixture.runtime);
		const select = vi.fn(
			async (_prompt: string, _options: string[]) => "Allow once",
		);
		const ui = { hasUI: true, ui: { select } } as unknown as ExtensionContext;
		await tool.execute("create", target, signal, undefined, ui);
		await tool.execute(
			"comment",
			{
				action: "add_inline_comment",
				ref: "work:acme/app!9",
				path: "src/auth.ts",
				body: "This branch skips validation.",
				new_position: 42,
			},
			signal,
			undefined,
			ui,
		);
		await tool.execute(
			"preview",
			{ action: "preview", ref: "work:acme/app!9" },
			signal,
			undefined,
			ui,
		);
		await tool.execute(
			"submit",
			{ action: "submit", ref: "work:acme/app!9" },
			signal,
			undefined,
			ui,
		);
		const post = fixture.request.mock.calls.find(
			(call) => call[1]?.method === "POST",
		);
		expect(select).toHaveBeenCalledOnce();
		expect(select.mock.calls[0]?.[0]).toContain("Summary: Looks correct");
		expect(select.mock.calls[0]?.[0]).toContain(
			"src/auth.ts:new:42 This branch skips validation.",
		);
		expect(post?.[1]?.body).toMatchObject({
			event: "APPROVED",
			commit_id: "head-sha",
			comments: [
				{
					path: "src/auth.ts",
					body: "This branch skips validation.",
					new_position: 42,
					old_position: 0,
				},
			],
		});
		expect(fixture.drafts.has("work:acme/app!9")).toBe(false);
	});

	it("rejects a review that stays PENDING after submit", async () => {
		const fixture = fakeRuntime(["head-sha", "head-sha"], "PENDING");
		const tool = captureReviewTool(fixture.runtime);
		const select = vi.fn(async () => "Allow once");
		const ui = { hasUI: true, ui: { select } } as unknown as ExtensionContext;
		await tool.execute("create", target, signal, undefined, ui);
		await tool.execute(
			"preview",
			{ action: "preview", ref: "work:acme/app!9" },
			signal,
			undefined,
			ui,
		);
		await expect(
			tool.execute(
				"submit",
				{ action: "submit", ref: "work:acme/app!9" },
				signal,
				undefined,
				ui,
			),
		).rejects.toThrow("stayed PENDING");
		expect(fixture.drafts.has("work:acme/app!9")).toBe(true);
	});
});
