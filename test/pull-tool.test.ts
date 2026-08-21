import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ForgejoClient } from "../src/client.js";
import type { ForgejoRuntime } from "../src/runtime.js";
import { registerPullTool } from "../src/tools/pull.js";
import type { ForgejoPullReview, ResourceRef } from "../src/types.js";

interface CapturedTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

interface FixtureOptions {
  heads?: string[];
  checkState?:
    | "pending"
    | "success"
    | "error"
    | "failure"
    | "warning"
    | "skipped";
  requiredApprovals?: number;
  reviews?: ForgejoPullReview[];
  reviewPages?: ForgejoPullReview[][];
  requestedReviewers?: Array<{ id: number; login: string }>;
  blockOnOfficialReviewRequests?: boolean;
  blockOnRejectedReviews?: boolean;
  title?: string;
  omitDraft?: boolean;
}

function capturePullTool(runtime: ForgejoRuntime): CapturedTool {
  let captured: CapturedTool | undefined;
  const api = {
    registerTool(definition: CapturedTool) {
      captured = definition;
    },
  } as unknown as ExtensionAPI;
  registerPullTool(api, () => runtime);
  if (!captured) throw new Error("pull tool was not registered");
  return captured;
}

function fakeRuntime(options: FixtureOptions = {}) {
  const ref: ResourceRef = {
    server: "work",
    owner: "acme",
    repo: "app",
    kind: "pull",
    index: 9,
  };
  const heads = [...(options.heads ?? ["head-sha", "head-sha"])];
  const checkState = options.checkState ?? "success";
  const request = vi.fn(
    async (
      path: string,
      requestOptions?: {
        method?: string;
        body?: unknown;
        query?: { page?: number };
      },
    ) => {
      if (
        requestOptions?.method === "POST" &&
        path.endsWith("/pulls/9/merge")
      ) {
        return { data: undefined, status: 200, headers: new Headers() };
      }
      if (path.endsWith("/pulls/9")) {
        const head = heads.shift() ?? "head-sha";
        return {
          data: {
            id: 9,
            number: 9,
            title: options.title ?? "Safe change",
            state: "open",
            html_url: "https://work.example/acme/app/pulls/9",
            updated_at: "2026-08-12T10:00:00Z",
            ...(options.omitDraft ? {} : { draft: false }),
            mergeable: true,
            merged: false,
            requested_reviewers: options.requestedReviewers ?? [],
            requested_reviewers_teams: [],
            head: { ref: "feature", sha: head },
            base: { ref: "main", sha: "base-sha" },
          },
          status: 200,
          headers: new Headers(),
        };
      }
      if (path.endsWith("/branches/main")) {
        return {
          data: {
            name: "main",
            protected: (options.requiredApprovals ?? 0) > 0,
            enable_status_check: true,
            required_approvals: options.requiredApprovals ?? 0,
            block_on_rejected_reviews: options.blockOnRejectedReviews ?? false,
            block_on_official_review_requests:
              options.blockOnOfficialReviewRequests ?? false,
            status_check_contexts: ["ci"],
            user_can_merge: true,
          },
          status: 200,
          headers: new Headers(),
        };
      }
      if (path.includes("/commits/") && path.endsWith("/status")) {
        return {
          data: {
            state: checkState,
            sha: path.split("/").at(-2),
            total_count: 1,
            statuses: [{ id: 1, context: "ci", status: checkState }],
          },
          status: 200,
          headers: new Headers(),
        };
      }
      if (path.endsWith("/pulls/9/reviews")) {
        const page = requestOptions?.query?.page ?? 1;
        return {
          data: options.reviewPages
            ? (options.reviewPages[page - 1] ?? [])
            : page === 1
              ? (options.reviews ?? [])
              : [],
          status: 200,
          headers: new Headers(),
        };
      }
      throw new Error(`unexpected request: ${path}`);
    },
  );
  const refresh = vi.fn(async () => undefined);
  const runtime = {
    sessionMutationApprovals: new Set<string>(),
    globalConfigPath: ".test-no-forgejo-config.json",
    resolveRepo: () => ({ server: "work", owner: "acme", repo: "app" }),
    resolveResource: () => ref,
    client: () => ({ request }) as unknown as ForgejoClient,
    dashboard: { refresh, refreshIfObserved: refresh },
  } as unknown as ForgejoRuntime;
  return { runtime, request, refresh };
}

const signal = new AbortController().signal;
const noUi = { hasUI: false } as ExtensionContext;

describe("forgejo_pull guarded merge", () => {
  it("reports failed checks, requested changes, missing approvals, and pending reviewers", async () => {
    const fixture = fakeRuntime({
      checkState: "failure",
      requiredApprovals: 1,
      blockOnRejectedReviews: true,
      blockOnOfficialReviewRequests: true,
      requestedReviewers: [{ id: 3, login: "alice" }],
      reviews: [
        {
          id: 7,
          user: { id: 4, login: "bob" },
          state: "REQUEST_CHANGES",
          official: true,
          commit_id: "head-sha",
        },
      ],
    });
    const tool = capturePullTool(fixture.runtime);

    const result = (await tool.execute(
      "readiness",
      { action: "readiness", ref: "work:acme/app!9" },
      signal,
      undefined,
      noUi,
    )) as { details: { data: { ready: boolean; blockers: string[] } } };

    expect(result.details.data.ready).toBe(false);
    expect(result.details.data.blockers).toEqual(
      expect.arrayContaining([
        "combined commit status is failure",
        "required check 'ci' is failure",
        "changes requested by bob",
        "requires 1 approvals; found 0",
        "review still requested from alice",
      ]),
    );
  });

  it("treats a draft title as draft when Forgejo omits the draft field", async () => {
    const fixture = fakeRuntime({
      title: "WIP: risky change",
      omitDraft: true,
    });
    const tool = capturePullTool(fixture.runtime);

    const result = (await tool.execute(
      "draft-readiness",
      { action: "readiness", ref: "work:acme/app!9" },
      signal,
      undefined,
      noUi,
    )) as {
      details: { data: { ready: boolean; draft: boolean; blockers: string[] } };
    };

    expect(result.details.data).toMatchObject({
      ready: false,
      draft: true,
      blockers: expect.arrayContaining(["pull request is a draft"]),
    });
  });

  it("paginates reviews when Forgejo clamps the requested page size", async () => {
    const oldApprovals = Array.from(
      { length: 50 },
      (_, index) =>
        ({
          id: index + 1,
          user: { id: index + 1, login: `reviewer-${index + 1}` },
          state: "APPROVED",
          official: true,
          commit_id: "head-sha",
        }) satisfies ForgejoPullReview,
    );
    const fixture = fakeRuntime({
      requiredApprovals: 1,
      blockOnRejectedReviews: true,
      reviewPages: [
        oldApprovals,
        [
          {
            id: 101,
            user: { id: 1, login: "reviewer-1" },
            state: "REQUEST_CHANGES",
            official: true,
            commit_id: "head-sha",
            updated_at: "2026-08-12T11:00:00Z",
          },
        ],
      ],
    });
    const tool = capturePullTool(fixture.runtime);
    const result = (await tool.execute(
      "paginated-readiness",
      { action: "readiness", ref: "work:acme/app!9" },
      signal,
      undefined,
      noUi,
    )) as { details: { data: { ready: boolean; blockers: string[] } } };
    expect(result.details.data.ready).toBe(false);
    expect(result.details.data.blockers).toContain(
      "changes requested by reviewer-1",
    );
    expect(
      fixture.request.mock.calls
        .filter((call) => String(call[0]).endsWith("/reviews"))
        .map((call) => call[1]?.query?.page),
    ).toEqual([1, 2, 3]);
  });

  it("does not block on advisory review requests when branch protection allows", async () => {
    const fixture = fakeRuntime({
      requestedReviewers: [{ id: 3, login: "alice" }],
      reviews: [
        {
          id: 7,
          user: { id: 4, login: "bob" },
          state: "REQUEST_CHANGES",
          official: true,
          commit_id: "head-sha",
        },
      ],
    });
    const tool = capturePullTool(fixture.runtime);

    const result = (await tool.execute(
      "advisory-readiness",
      { action: "readiness", ref: "work:acme/app!9" },
      signal,
      undefined,
      noUi,
    )) as { details: { data: { ready: boolean; blockers: string[] } } };

    expect(result.details.data.ready).toBe(true);
    expect(result.details.data.blockers).toEqual([]);
  });

  it("treats an outstanding request as answered once that reviewer has a current review", async () => {
    const fixture = fakeRuntime({
      blockOnOfficialReviewRequests: true,
      requestedReviewers: [{ id: 4, login: "bob" }],
      reviews: [
        {
          id: 7,
          user: { id: 4, login: "bob" },
          state: "APPROVED",
          official: true,
          commit_id: "head-sha",
        },
      ],
    });
    const tool = capturePullTool(fixture.runtime);

    const result = (await tool.execute(
      "answered-request-readiness",
      { action: "readiness", ref: "work:acme/app!9" },
      signal,
      undefined,
      noUi,
    )) as { details: { data: { ready: boolean; blockers: string[] } } };

    expect(result.details.data.ready).toBe(true);
    expect(result.details.data.blockers).toEqual([]);
  });

  it("blocks failed checks before asking for confirmation", async () => {
    const fixture = fakeRuntime({ checkState: "failure" });
    const tool = capturePullTool(fixture.runtime);
    const select = vi.fn(async () => "Allow once");
    const ui = { hasUI: true, ui: { select } } as unknown as ExtensionContext;

    await expect(
      tool.execute(
        "merge",
        { action: "merge", ref: "work:acme/app!9", merge_method: "squash" },
        signal,
        undefined,
        ui,
      ),
    ).rejects.toThrow("combined commit status is failure");
    expect(select).not.toHaveBeenCalled();
    expect(
      fixture.request.mock.calls.some((call) => call[1]?.method === "POST"),
    ).toBe(false);
  });

  it("requires interactive confirmation before merge", async () => {
    const fixture = fakeRuntime();
    const tool = capturePullTool(fixture.runtime);

    await expect(
      tool.execute(
        "merge",
        { action: "merge", ref: "work:acme/app!9", merge_method: "squash" },
        signal,
        undefined,
        noUi,
      ),
    ).rejects.toThrow("requires interactive confirmation");
    expect(
      fixture.request.mock.calls.some((call) => call[1]?.method === "POST"),
    ).toBe(false);
  });

  it("rejects a changed head after confirmation", async () => {
    const fixture = fakeRuntime({ heads: ["old-sha", "new-sha"] });
    const tool = capturePullTool(fixture.runtime);
    const select = vi.fn(async () => "Allow once");
    const ui = { hasUI: true, ui: { select } } as unknown as ExtensionContext;

    await expect(
      tool.execute(
        "merge",
        { action: "merge", ref: "work:acme/app!9", merge_method: "merge" },
        signal,
        undefined,
        ui,
      ),
    ).rejects.toThrow("pull request head changed from old-sha to new-sha");
    expect(select).toHaveBeenCalledOnce();
    expect(
      fixture.request.mock.calls.some((call) => call[1]?.method === "POST"),
    ).toBe(false);
  });

  it("posts the guarded strategy and expected head only after rechecking readiness", async () => {
    const fixture = fakeRuntime();
    const tool = capturePullTool(fixture.runtime);
    const select = vi.fn(async () => "Allow once");
    const ui = { hasUI: true, ui: { select } } as unknown as ExtensionContext;

    await tool.execute(
      "merge",
      {
        action: "merge",
        ref: "work:acme/app!9",
        merge_method: "rebase",
        delete_branch: true,
      },
      signal,
      undefined,
      ui,
    );

    const post = fixture.request.mock.calls.find(
      (call) => call[1]?.method === "POST",
    );
    expect(select).toHaveBeenCalledOnce();
    expect(post?.[0]).toBe("repos/acme/app/pulls/9/merge");
    expect(post?.[1]?.body).toEqual({
      Do: "rebase",
      head_commit_id: "head-sha",
      delete_branch_after_merge: true,
    });
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });
});
