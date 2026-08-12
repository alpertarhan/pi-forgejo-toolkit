import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ApiResult, ResourceRef } from "../src/types.js";
import type { ForgejoClient, RequestOptions } from "../src/client.js";
import type { ForgejoRuntime } from "../src/runtime.js";
import { timelineToolResult } from "../src/tools/common.js";
import { registerIssueTool } from "../src/tools/issue.js";
import { registerNotificationTool } from "../src/tools/notifications.js";
import { registerPullTool } from "../src/tools/pull.js";
import { registerReviewTool } from "../src/tools/review.js";

interface CapturedTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

interface ToolOutput {
  content: Array<{ type: "text"; text: string }>;
  details: { data: unknown };
}

type RegisterTool = (api: ExtensionAPI, runtimeProvider: () => ForgejoRuntime) => void;

function captureTool(register: RegisterTool, runtime: ForgejoRuntime): CapturedTool {
  let captured: CapturedTool | undefined;
  const api = {
    registerTool(definition: CapturedTool) {
      captured = definition;
    },
  } as unknown as ExtensionAPI;
  register(api, () => runtime);
  if (!captured) throw new Error("tool was not registered");
  return captured;
}

function apiResult<T>(data: T, totalCount?: number): ApiResult<T> {
  const result: ApiResult<T> = { data, status: 200, headers: new Headers() };
  if (totalCount !== undefined) result.totalCount = totalCount;
  return result;
}

function isToolOutput(value: unknown): value is ToolOutput {
  if (typeof value !== "object" || value === null || !("content" in value) || !("details" in value)) return false;
  if (!Array.isArray(value.content) || !value.content.every((item: unknown) => {
    return typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string";
  })) {
    return false;
  }
  const details = value.details;
  return typeof details === "object" && details !== null && "data" in details;
}

function requireToolOutput(value: unknown): ToolOutput {
  if (!isToolOutput(value)) throw new Error("tool returned an invalid result");
  return value;
}

function outputText(result: unknown): string {
  return requireToolOutput(result).content.map((item) => item.text).join("\n");
}

const signal = new AbortController().signal;
const noUi = { hasUI: false } as ExtensionContext;
const repo = { server: "work", owner: "acme", repo: "app" } as const;

function issueRuntime(body = "The complete issue body is visible.") {
  const ref: ResourceRef = { ...repo, kind: "issue", index: 12 };
  const request = vi.fn(async (path: string, options?: RequestOptions) => {
    if (path.endsWith("/issues/12/comments")) {
      return apiResult([
        {
          id: 91,
          body: "Production log shows the timeout.",
          user: { id: 2, login: "bob" },
          created_at: "2026-08-12T10:10:00Z",
          updated_at: "2026-08-12T10:12:00Z",
          html_url: "https://work.example/acme/app/issues/12#issuecomment-91",
        },
      ]);
    }
    if (path.endsWith("/issues/12/timeline")) {
      expect(options?.query).toEqual({
        page: 2,
        limit: 1,
        since: "2026-08-12T10:00:00Z",
        before: "2026-08-13T00:00:00Z",
      });
      return apiResult(
        [
          {
            id: 101,
            type: "comment",
            user: { id: 3, login: "alice" },
            body: "This is the follow-up timeline comment.",
            created_at: "2026-08-12T10:20:00Z",
            updated_at: "2026-08-12T10:20:00Z",
          },
        ],
        3,
      );
    }
    if (path.endsWith("/issues/12")) {
      return apiResult({
        id: 12,
        number: 12,
        title: "Timeout under load",
        body,
        state: "open",
        html_url: "https://work.example/acme/app/issues/12",
        created_at: "2026-08-12T10:00:00Z",
        updated_at: "2026-08-12T10:12:00Z",
        user: { id: 1, login: "alice" },
        labels: [{ id: 4, name: "bug" }],
        comments: 1,
      });
    }
    throw new Error(`unexpected request: ${path}`);
  });
  const runtime = {
    resolveRepo: () => repo,
    resolveResource: () => ref,
    client: () => ({ request } as unknown as ForgejoClient),
    dashboard: { refresh: vi.fn(async () => undefined), refreshIfObserved: vi.fn(async () => undefined) },
  } as unknown as ForgejoRuntime;
  return { runtime, request };
}

describe("issue conversation output", () => {
  it("places the issue body and complete discussion comments in model-facing content", async () => {
    const fixture = issueRuntime();
    const tool = captureTool(registerIssueTool, fixture.runtime);
    const result = await tool.execute("get", { action: "get", ref: "work:acme/app#12" }, signal, undefined, noUi);
    const text = outputText(result);

    expect(text).toContain("The complete issue body is visible.");
    expect(text).toContain("Comment 91 by @bob");
    expect(text).toContain("Production log shows the timeout.");
    const commentCall = fixture.request.mock.calls.find((call) => call[0].endsWith("/issues/12/comments"));
    expect(commentCall?.[1]?.query).toBeUndefined();
  });

  it("bounds issue snapshots to 32 KB by default", async () => {
    const fixture = issueRuntime("x".repeat(40_000));
    const tool = captureTool(registerIssueTool, fixture.runtime);
    const result = requireToolOutput(
      await tool.execute("get", { action: "get", ref: "work:acme/app#12" }, signal, undefined, noUi),
    );
    const text = outputText(result);

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32_000);
    expect(text).toContain("[output truncated at 32000 bytes]");
    expect(result.details.data).toMatchObject({ truncated: true, renderedBytes: 32_000 });
  });

  it("uses timeline pagination and timestamp bounds without hiding event bodies", async () => {
    const fixture = issueRuntime();
    const tool = captureTool(registerIssueTool, fixture.runtime);
    const result = requireToolOutput(await tool.execute(
      "timeline",
      {
        action: "timeline",
        ref: "work:acme/app#12",
        page: 2,
        limit: 1,
        since: "2026-08-12T10:00:00Z",
        before: "2026-08-13T00:00:00Z",
      },
      signal,
      undefined,
      noUi,
    ));

    expect(outputText(result)).toContain("This is the follow-up timeline comment.");
    expect(outputText(result)).toContain("Next page: 3");
    expect(result.details.data).toMatchObject({ page: 2, limit: 1, total: 3, hasMore: true, nextPage: 3 });
  });
});

function pullRuntime() {
  const ref: ResourceRef = { ...repo, kind: "pull", index: 9 };
  const refresh = vi.fn(async () => undefined);
  const request = vi.fn(async (path: string, options?: RequestOptions) => {
    if (path.endsWith("/issues/9/comments") && options?.method === "POST") {
      return apiResult({
        id: 44,
        body:
          typeof options.body === "object" &&
          options.body !== null &&
          "body" in options.body &&
          typeof options.body.body === "string"
            ? options.body.body
            : "",
        user: { id: 1, login: "alice" },
        created_at: "2026-08-12T12:00:00Z",
        updated_at: "2026-08-12T12:00:00Z",
      });
    }
    if (path.endsWith("/issues/9/timeline")) {
      return apiResult(
        [
          {
            id: 77,
            type: "pull_push",
            user: { id: 2, login: "bob" },
            old_ref: "old-head-sha",
            new_ref: "new-head-sha",
            created_at: "2026-08-12T11:00:00Z",
            updated_at: "2026-08-12T11:00:00Z",
          },
        ],
        1,
      );
    }
    if (path.endsWith("/pulls/9/files")) {
      expect(options?.query).toEqual({ page: 2, limit: 10 });
      return apiResult(
        [{ filename: "src/cache.ts", status: "modified", additions: 18, deletions: 4, changes: 22 }],
        21,
      );
    }
    if (path.endsWith("/pulls/9/commits")) {
      expect(options?.query).toEqual({ page: 1, limit: 5, files: false });
      return apiResult([
        {
          sha: "6b2bc031d844bea805121bf37ba039ddcb58b489",
          html_url: "https://work.example/acme/app/commit/6b2bc031",
          author: { id: 2, login: "bob" },
          commit: {
            message: "Fix cache invalidation\n\nPreserve lock ordering.",
            author: { name: "Bob", date: "2026-08-12T10:30:00Z" },
          },
        },
      ]);
    }
    if (path.endsWith("/pulls/9/reviews")) {
      return apiResult([
        {
          id: 42,
          user: { id: 3, login: "carol" },
          state: "REQUEST_CHANGES",
          body: "The lock is released too late.",
          commit_id: "head-sha",
          comments_count: 1,
          submitted_at: "2026-08-12T10:40:00Z",
          updated_at: "2026-08-12T10:40:00Z",
          official: true,
          stale: false,
          dismissed: false,
        },
      ]);
    }
    if (path.endsWith("/pulls/9")) {
      return apiResult({
        id: 9,
        number: 9,
        title: "Safe cache change",
        body: "The complete pull request body is visible.",
        state: "open",
        html_url: "https://work.example/acme/app/pulls/9",
        created_at: "2026-08-12T10:00:00Z",
        updated_at: "2026-08-12T11:00:00Z",
        user: { id: 1, login: "alice" },
        head: { ref: "feature", sha: "head-sha" },
        base: { ref: "main", sha: "base-sha" },
        draft: false,
        mergeable: true,
        merged: false,
      });
    }
    throw new Error(`unexpected request: ${path}`);
  });
  const runtime = {
    resolveRepo: () => repo,
    resolveResource: () => ref,
    client: () => ({ request } as unknown as ForgejoClient),
    dashboard: { refresh, refreshIfObserved: refresh },
  } as unknown as ForgejoRuntime;
  return { runtime, request, refresh };
}

describe("pull request conversation output", () => {
  it("renders the pull body and remote review body", async () => {
    const fixture = pullRuntime();
    const tool = captureTool(registerPullTool, fixture.runtime);
    const result = await tool.execute("get", { action: "get", ref: "work:acme/app!9" }, signal, undefined, noUi);
    const text = outputText(result);

    expect(text).toContain("The complete pull request body is visible.");
    expect(text).toContain("Review 42 by @carol [REQUEST_CHANGES]");
    expect(text).toContain("The lock is released too late.");
  });

  it("keeps normal discussion comments separate from reviews", async () => {
    const fixture = pullRuntime();
    const tool = captureTool(registerPullTool, fixture.runtime);
    const result = await tool.execute(
      "comment",
      { action: "comment", ref: "work:acme/app!9", body: "Normal PR discussion comment" },
      signal,
      undefined,
      noUi,
    );

    expect(outputText(result)).toContain("Normal PR discussion comment");
    const post = fixture.request.mock.calls.find((call) => call[1]?.method === "POST");
    expect(post?.[0]).toBe("repos/acme/app/issues/9/comments");
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });

  it("renders push events, changed files, and commit messages with pagination", async () => {
    const fixture = pullRuntime();
    const tool = captureTool(registerPullTool, fixture.runtime);
    const timeline = await tool.execute(
      "timeline",
      { action: "timeline", ref: "work:acme/app!9", page: 1, limit: 10 },
      signal,
      undefined,
      noUi,
    );
    const files = await tool.execute(
      "files",
      { action: "files", ref: "work:acme/app!9", page: 2, limit: 10 },
      signal,
      undefined,
      noUi,
    );
    const commits = await tool.execute(
      "commits",
      { action: "commits", ref: "work:acme/app!9", page: 1, limit: 5 },
      signal,
      undefined,
      noUi,
    );

    expect(outputText(timeline)).toContain("Ref: old-head-sha -> new-head-sha");
    expect(outputText(files)).toContain("src/cache.ts [modified] +18 -4");
    expect(outputText(files)).toContain("Next page: 3");
    expect(outputText(commits)).toContain("Fix cache invalidation");
  });
});

describe("remote review output", () => {
  it("renders review bodies and inline comment evidence", async () => {
    const ref: ResourceRef = { ...repo, kind: "pull", index: 9 };
    const review = {
      id: 42,
      user: { id: 3, login: "carol" },
      state: "REQUEST_CHANGES",
      body: "Please fix the unlock path.",
      commit_id: "head-sha",
      comments_count: 1,
      submitted_at: "2026-08-12T10:40:00Z",
      updated_at: "2026-08-12T10:40:00Z",
    };
    const comments = [
      {
        id: 501,
        body: "This return leaks the lock.",
        user: { id: 3, login: "carol" },
        pull_request_review_id: 42,
        created_at: "2026-08-12T10:41:00Z",
        updated_at: "2026-08-12T10:41:00Z",
        path: "src/cache.ts",
        commit_id: "head-sha",
        original_commit_id: "head-sha",
        diff_hunk: "@@ -80,3 +80,4 @@",
        position: 84,
        original_position: 84,
      },
    ];
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/reviews/42/comments")) return apiResult(comments);
      if (path.endsWith("/reviews/42")) return apiResult(review);
      if (path.endsWith("/reviews")) return apiResult([review]);
      throw new Error(`unexpected request: ${path}`);
    });
    const runtime = {
      resolveResource: () => ref,
      client: () => ({ request } as unknown as ForgejoClient),
      draftKey: () => "work:acme/app!9",
      drafts: new Map(),
      dashboard: { refresh: vi.fn(async () => undefined), refreshIfObserved: vi.fn(async () => undefined) },
    } as unknown as ForgejoRuntime;
    const tool = captureTool(registerReviewTool, runtime);

    const list = await tool.execute("list", { action: "list", ref: "work:acme/app!9" }, signal, undefined, noUi);
    const get = await tool.execute(
      "get",
      { action: "get", ref: "work:acme/app!9", review_id: 42 },
      signal,
      undefined,
      noUi,
    );

    expect(outputText(list)).toContain("Please fix the unlock path.");
    expect(outputText(get)).toContain("src/cache.ts (current 84, original 84)");
    expect(outputText(get)).toContain("@@ -80,3 +80,4 @@");
    expect(outputText(get)).toContain("This return leaks the lock.");
  });
});

describe("notification output", () => {
  it("shows the qualified resource, update timestamp, and latest-comment signal", async () => {
    const notification = {
      id: 768,
      unread: true,
      pinned: false,
      updated_at: "2026-08-12T12:25:33Z",
      subject: {
        title: "Safe cache change",
        type: "Pull",
        state: "open",
        url: "https://work.example/api/v1/repos/acme/app/pulls/9",
        latest_comment_url: "https://work.example/api/v1/repos/acme/app/issues/comments/44",
        html_url: "https://work.example/acme/app/pulls/9",
      },
      repository: {
        id: 1,
        name: "app",
        full_name: "acme/app",
        html_url: "https://work.example/acme/app",
      },
    };
    const request = vi.fn(async () => apiResult([notification], 1));
    const runtime = {
      client: () => ({ request } as unknown as ForgejoClient),
      clients: { aliases: () => ["work"] },
      currentServer: () => "work",
      dashboard: { refresh: vi.fn(async () => undefined), refreshIfObserved: vi.fn(async () => undefined) },
    } as unknown as ForgejoRuntime;
    const tool = captureTool(registerNotificationTool, runtime);
    const result = await tool.execute(
      "list",
      { action: "list", server: "work", limit: 20 },
      signal,
      undefined,
      noUi,
    );
    const text = outputText(result);

    expect(text).toContain("Resource: work:acme/app!9");
    expect(text).toContain("Updated: 2026-08-12T12:25:33Z");
    expect(text).toContain("Latest comment available: yes");
  });
});

describe("timeline byte bounds", () => {
  it("keeps UTF-8 valid and preserves recovery metadata when truncated", () => {
    const result = timelineToolResult(
      "work:acme/app#12",
      [
        {
          id: 1,
          type: "comment",
          user: { id: 1, login: "alice" },
          body: "ş".repeat(1_000),
          created_at: "2026-08-12T10:00:00Z",
          updated_at: "2026-08-12T10:00:00Z",
        },
      ],
      1,
      1,
      2,
      1_000,
    );
    const text = outputText(result);

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_000);
    expect(text).not.toContain("�");
    expect(text).toContain("Truncated: yes");
    expect(text).toContain("Next page: 2");
    expect(result.details.data).toMatchObject({ truncated: true, hasMore: true, nextPage: 2 });
  });
});
