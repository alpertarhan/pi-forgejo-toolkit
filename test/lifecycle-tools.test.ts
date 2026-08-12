import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ForgejoClient, RequestOptions } from "../src/client.js";
import type { ConversationCursor, ForgejoRuntime } from "../src/runtime.js";
import { incrementalConversationUpdates } from "../src/tools/conversation.js";
import { toolResult } from "../src/tools/common.js";
import { registerIssueTool } from "../src/tools/issue.js";
import { registerNotificationTool } from "../src/tools/notifications.js";
import { registerPullTool } from "../src/tools/pull.js";
import { registerForgejoTools } from "../src/tools/index.js";
import { registerSearchTool } from "../src/tools/search.js";
import type { ApiResult, ResourceRef } from "../src/types.js";

interface CapturedTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

interface RegisteredTool extends CapturedTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: {
    properties?: Record<string, { maximum?: number; maxItems?: number; items?: { enum?: unknown[] } }>;
  };
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
  if (typeof value !== "object" || value === null) return false;
  if (!("content" in value) || !("details" in value) || !Array.isArray(value.content)) return false;
  return value.content.every((item: unknown) => {
    return typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string";
  });
}

function requireToolOutput(value: unknown): ToolOutput {
  if (!isToolOutput(value)) throw new Error("tool returned an invalid result");
  return value;
}

function outputText(value: unknown): string {
  return requireToolOutput(value).content.map((item) => item.text).join("\n");
}

const repo = { server: "work", owner: "acme", repo: "app" } as const;
const issueRef: ResourceRef = { ...repo, kind: "issue", index: 12 };
const pullRef: ResourceRef = { ...repo, kind: "pull", index: 9 };
const signal = new AbortController().signal;
const noUi = { hasUI: false } as ExtensionContext;

function confirmedContext(confirm = vi.fn(async (_title: string, _message: string) => true)): { ctx: ExtensionContext; confirm: typeof confirm } {
  return {
    ctx: { hasUI: true, ui: { confirm } } as unknown as ExtensionContext,
    confirm,
  };
}

function resourceRuntime(
  ref: ResourceRef,
  request: (path: string, options?: RequestOptions) => Promise<ApiResult<unknown>>,
): ForgejoRuntime {
  return {
    resolveRepo: () => repo,
    resolveResource: () => ref,
    client: () => ({ request } as unknown as ForgejoClient),
    capabilities: {
      get: () => ({ user: { id: 1, login: "alice" } }),
    },
    dashboard: { refresh: vi.fn(async () => undefined), refreshIfObserved: vi.fn(async () => undefined) },
  } as unknown as ForgejoRuntime;
}

function comment(issue: number) {
  return {
    id: 44,
    body: "Current comment body",
    user: { id: 1, login: "alice" },
    issue_url: `https://work.example/api/v1/repos/acme/app/issues/${issue}`,
    html_url: `https://work.example/acme/app/issues/${issue}#issuecomment-44`,
    created_at: "2026-08-12T10:00:00Z",
    updated_at: "2026-08-12T10:00:00Z",
  };
}

describe("issue conversation lifecycle", () => {
  it("validates comment ownership and confirmation before deletion", async () => {
    let targetIssue = 99;
    const request = vi.fn(async (path: string, options?: RequestOptions) => {
      expect(path).toBe("repos/acme/app/issues/comments/44");
      if (options?.method === "DELETE") return apiResult(undefined);
      return apiResult(comment(targetIssue));
    });
    const runtime = resourceRuntime(issueRef, request);
    const tool = captureTool(registerIssueTool, runtime);
    const ui = confirmedContext();

    await expect(
      tool.execute("wrong-target", { action: "delete_comment", ref: "work:acme/app#12", comment_id: 44 }, signal, undefined, ui.ctx),
    ).rejects.toThrow("belongs to #99");
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();

    targetIssue = 12;
    await expect(
      tool.execute("no-ui", { action: "delete_comment", ref: "work:acme/app#12", comment_id: 44 }, signal, undefined, noUi),
    ).rejects.toThrow("requires interactive confirmation");
    expect(request.mock.calls.some((call) => call[1]?.method === "DELETE")).toBe(false);

    await tool.execute(
      "confirmed",
      { action: "delete_comment", ref: "work:acme/app#12", comment_id: 44 },
      signal,
      undefined,
      ui.ctx,
    );
    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(ui.confirm.mock.calls[0]?.[1]).toContain("Current comment body");
    expect(request.mock.calls.filter((call) => call[1]?.method === "DELETE")).toHaveLength(1);
  });

  it("uses the authenticated username and verifies subscription state after mutation", async () => {
    const request = vi.fn(async (path: string, options?: RequestOptions) => {
      if (path.endsWith("/subscriptions/alice")) {
        expect(options?.method).toBe("PUT");
        return apiResult(undefined);
      }
      expect(path).toBe("repos/acme/app/issues/12/subscriptions/check");
      return apiResult({ subscribed: true, ignored: false });
    });
    const runtime = resourceRuntime(issueRef, request);
    const tool = captureTool(registerIssueTool, runtime);

    const result = await tool.execute(
      "subscribe",
      { action: "subscribe", ref: "work:acme/app#12" },
      signal,
      undefined,
      noUi,
    );

    expect(outputText(result)).toContain("Subscribed to work:acme/app#12 as @alice");
    expect(request.mock.calls.map((call) => [call[0], call[1]?.method ?? "GET"])).toEqual([
      ["repos/acme/app/issues/12/subscriptions/alice", "PUT"],
      ["repos/acme/app/issues/12/subscriptions/check", "GET"],
    ]);
  });

  it("does not advance an incremental cursor after an incomplete timeline scan", async () => {
    const previous: ConversationCursor = {
      reference: "work:acme/app#12",
      fetchedThrough: "2026-08-12T10:00:00Z",
      eventVersions: new Map(),
      lastUpdatedAt: "2026-08-12T09:59:00Z",
      lastState: "open",
      lastTitle: "Timeout",
    };
    const saveConversationCursor = vi.fn();
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/timeline")) {
        return apiResult(
          [{ id: 1, type: "comment", body: "new", created_at: "2026-08-12T10:01:00Z", updated_at: "2026-08-12T10:01:00Z" }],
          2,
        );
      }
      return apiResult({
        id: 12,
        number: 12,
        title: "Timeout",
        state: "open",
        updated_at: "2026-08-12T10:01:00Z",
      });
    });
    const runtime = {
      client: () => ({ request } as unknown as ForgejoClient),
      conversationCursor: () => previous,
      saveConversationCursor,
    } as unknown as ForgejoRuntime;

    const result = requireToolOutput(await incrementalConversationUpdates(runtime, issueRef, {
      currentPath: "repos/acme/app/issues/12",
      timelinePath: "repos/acme/app/issues/12/timeline",
      pageLimit: 1,
      maxPages: 1,
      maximumBytes: 20_000,
    }));

    expect(result.details.data).toMatchObject({ complete: false, cursorAdvanced: false, scanned: 1 });
    expect(outputText(result)).toContain("Recovery: narrow since or increase max_pages above 1");
    expect(saveConversationCursor).not.toHaveBeenCalled();
  });
});

describe("notification resolution safety", () => {
  it("rejects a cross-origin latest-comment URL before a second HTTP request", async () => {
    const notification = {
      id: 7,
      unread: true,
      pinned: false,
      updated_at: "2026-08-12T10:00:00Z",
      subject: {
        type: "Issue",
        title: "Timeout",
        url: "https://work.example/api/v1/repos/acme/app/issues/12",
        latest_comment_url: "https://attacker.example/api/v1/repos/acme/app/issues/comments/44",
      },
      repository: { id: 1, name: "app", full_name: "acme/app", html_url: "https://work.example/acme/app" },
    };
    const request = vi.fn(async () => apiResult(notification));
    const client = { config: { baseUrl: "https://work.example" }, request } as unknown as ForgejoClient;
    const runtime = {
      clients: { aliases: () => ["work"] },
      client: () => client,
      currentServer: () => "work",
    } as unknown as ForgejoRuntime;
    const tool = captureTool(registerNotificationTool, runtime);

    await expect(
      tool.execute("latest", { action: "get", server: "work", id: 7, resolve_latest: true }, signal, undefined, noUi),
    ).rejects.toThrow("points outside configured Forgejo origin");
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps healthy server notifications when another server fails", async () => {
    const clients = {
      work: { request: vi.fn(async () => { throw new Error("work unavailable"); }) },
      community: {
        request: vi.fn(async () => apiResult([
          {
            id: 8,
            unread: true,
            pinned: false,
            updated_at: "2026-08-12T10:00:00Z",
            subject: { type: "Pull", title: "Fix", url: "https://community.example/api/v1/repos/acme/app/pulls/9" },
            repository: { id: 1, name: "app", full_name: "acme/app", html_url: "https://community.example/acme/app" },
          },
        ])),
      },
    };
    const runtime = {
      clients: { aliases: () => ["work", "community"] },
      client: (alias: "work" | "community") => clients[alias] as unknown as ForgejoClient,
    } as unknown as ForgejoRuntime;
    const tool = captureTool(registerNotificationTool, runtime);

    const result = await tool.execute("list", { action: "list" }, signal, undefined, noUi);

    expect(outputText(result)).toContain("work: error — work unavailable");
    expect(outputText(result)).toContain("community: 1 unread");
    expect(outputText(result)).toContain("community:acme/app!9");
  });
});

describe("issue and pull metadata mutations", () => {
  it("resolves a milestone title, patches its ID, and rejects an invalid due date locally", async () => {
    const request = vi.fn(async (path: string, options?: RequestOptions) => {
      if (path.endsWith("/milestones")) {
        expect(options?.query).toEqual({ state: "all", page: 1, limit: 100 });
        return apiResult([{ id: 4, title: "Sprint 1", state: "open" }], 1);
      }
      expect(path).toBe("repos/acme/app/issues/12");
      expect(options).toMatchObject({ method: "PATCH", body: { milestone: 4 } });
      return apiResult({
        id: 12,
        number: 12,
        title: "Timeout",
        state: "open",
        updated_at: "2026-08-12T10:00:00Z",
        milestone: { id: 4, title: "Sprint 1", state: "open" },
      });
    });
    const runtime = resourceRuntime(issueRef, request);
    const tool = captureTool(registerIssueTool, runtime);

    await tool.execute(
      "milestone",
      { action: "set_milestone", ref: "work:acme/app#12", milestone: "sprint 1" },
      signal,
      undefined,
      noUi,
    );
    const callsAfterMilestone = request.mock.calls.length;
    await expect(
      tool.execute(
        "bad-date",
        { action: "set_due_date", ref: "work:acme/app#12", due_date: "2026-08-20" },
        signal,
        undefined,
        noUi,
      ),
    ).rejects.toThrow("RFC 3339 timestamp with a timezone");
    expect(request).toHaveBeenCalledTimes(callsAfterMilestone);
  });

  it("marks a draft ready only after confirmation and verifies the returned state", async () => {
    const request = vi.fn(async (path: string, options?: RequestOptions) => {
      expect(path).toBe("repos/acme/app/pulls/9");
      if (options?.method === "PATCH") {
        expect(options.body).toEqual({ title: "Safe change" });
        return apiResult({
          id: 9,
          number: 9,
          title: "Safe change",
          state: "open",
          draft: false,
          updated_at: "2026-08-12T10:00:00Z",
          head: { ref: "feature", sha: "head-sha" },
          base: { ref: "main", sha: "base-sha" },
        });
      }
      return apiResult({
        id: 9,
        number: 9,
        title: "WIP: Safe change",
        state: "open",
        draft: true,
        updated_at: "2026-08-12T10:00:00Z",
        head: { ref: "feature", sha: "head-sha" },
        base: { ref: "main", sha: "base-sha" },
      });
    });
    const runtime = resourceRuntime(pullRef, request);
    const tool = captureTool(registerPullTool, runtime);
    const ui = confirmedContext();

    await tool.execute(
      "ready",
      { action: "mark_ready", ref: "work:acme/app!9" },
      signal,
      undefined,
      ui.ctx,
    );

    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(request.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual(["GET", "PATCH"]);
  });

  it("requests only missing users and teams and verifies the fresh pull", async () => {
    let readCount = 0;
    const request = vi.fn(async (path: string, options?: RequestOptions) => {
      if (path.endsWith("/requested_reviewers")) {
        expect(options).toMatchObject({
          method: "POST",
          body: { reviewers: ["bob"], team_reviewers: ["backend"] },
        });
        return apiResult(undefined);
      }
      readCount += 1;
      return apiResult({
        id: 9,
        number: 9,
        title: "Safe change",
        state: "open",
        draft: false,
        updated_at: "2026-08-12T10:00:00Z",
        head: { ref: "feature", sha: "head-sha" },
        base: { ref: "main", sha: "base-sha" },
        requested_reviewers: readCount === 1 ? [{ id: 2, login: "alice" }] : [{ id: 2, login: "alice" }, { id: 3, login: "bob" }],
        requested_reviewers_teams: readCount === 1 ? [] : [{ id: 8, name: "backend" }],
      });
    });
    const runtime = resourceRuntime(pullRef, request);
    const tool = captureTool(registerPullTool, runtime);

    await tool.execute(
      "reviewers",
      {
        action: "request_reviewers",
        ref: "work:acme/app!9",
        reviewers: ["alice", "bob", "BOB"],
        reviewer_teams: ["backend"],
      },
      signal,
      undefined,
      noUi,
    );

    expect(request.mock.calls.map((call) => call[0])).toEqual([
      "repos/acme/app/pulls/9",
      "repos/acme/app/pulls/9/requested_reviewers",
      "repos/acme/app/pulls/9",
    ]);
  });

  it("does not close a pull request without interactive confirmation", async () => {
    const request = vi.fn(async (_path: string, options?: RequestOptions) => {
      if (options?.method === "PATCH") throw new Error("PATCH must not be reached");
      return apiResult({
        id: 9,
        number: 9,
        title: "Safe change",
        state: "open",
        draft: false,
        updated_at: "2026-08-12T10:00:00Z",
        head: { ref: "feature", sha: "head-sha" },
        base: { ref: "main", sha: "base-sha" },
      });
    });
    const runtime = resourceRuntime(pullRef, request);
    const tool = captureTool(registerPullTool, runtime);

    await expect(
      tool.execute("close", { action: "close", ref: "work:acme/app!9" }, signal, undefined, noUi),
    ).rejects.toThrow("requires interactive confirmation");
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("cross-server search previews", () => {
  it("renders bounded single-line body previews instead of full issue bodies", async () => {
    const body = "diagnostic line\n".repeat(500);
    const request = vi.fn(async () =>
      apiResult(
        [
          {
            number: 12,
            title: "Timeout",
            state: "open",
            body,
            updated_at: "2026-08-12T10:00:00Z",
            html_url: "https://work.example/acme/app/issues/12",
            user: { login: "alice" },
            repository: { full_name: "acme/app" },
          },
        ],
        1,
      ),
    );
    const runtime = {
      client: () => ({ request } as unknown as ForgejoClient),
    } as unknown as ForgejoRuntime;
    const tool = captureTool(registerSearchTool, runtime);

    const text = outputText(
      await tool.execute(
        "search",
        { action: "issues", query: "timeout", server: "work", limit: 1 },
        signal,
        undefined,
        noUi,
      ),
    );

    expect(text).toContain("Body preview (truncated):");
    expect(text).toContain("work:acme/app#12");
    expect(text).not.toContain(body);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(1_000);
  });
});

describe("tool result persistence", () => {
  it("compacts oversized hidden details while preserving small recovery metadata", () => {
    const result = toolResult("bounded output", {
      reference: "work:acme/app#12",
      page: 2,
      body: "x".repeat(20_000),
      recovery: { nextPage: 3 },
    });
    const data = result.details.data as Record<string, unknown>;

    expect(result.content[0]?.text).toBe("bounded output");
    expect(data).toMatchObject({
      reference: "work:acme/app#12",
      page: 2,
      recovery: { nextPage: 3 },
      detailsTruncated: true,
    });
    expect(data.body).toBeUndefined();
    expect(data.detailsOriginalBytes).toBeGreaterThan(20_000);
    expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBeLessThan(2_000);
  });
});

describe("Forgejo tool activation", () => {
  it("starts with only context and loader tools, then adds requested domains", async () => {
    const tools = new Map<string, RegisteredTool>();
    let active = ["read"];
    const api = {
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
        active.push(definition.name);
      },
      getActiveTools() {
        return [...active];
      },
      setActiveTools(names: string[]) {
        active = [...names];
      },
    } as unknown as ExtensionAPI;
    const controller = registerForgejoTools(api, () => {
      throw new Error("runtime must not be created while loading tools");
    });

    controller.reset();
    expect(active).toEqual(["read", "forgejo_context", "forgejo_tools"]);

    const loader = tools.get("forgejo_tools");
    if (!loader) throw new Error("Forgejo tool loader was not registered");
    await loader.execute(
      "load",
      { domains: ["review", "actions"] },
      signal,
      undefined,
      noUi,
    );
    expect(active).toEqual([
      "read",
      "forgejo_context",
      "forgejo_tools",
      "forgejo_pull",
      "forgejo_review",
      "forgejo_actions",
    ]);

    controller.reset();
    expect(active).toEqual(["read", "forgejo_context", "forgejo_tools"]);
  });

  it("rejects all-at-once and oversized domain activation", async () => {
    const tools = new Map<string, RegisteredTool>();
    let active = ["read", "forgejo_context", "forgejo_tools"];
    const api = {
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
      },
      getActiveTools: () => [...active],
      setActiveTools(names: string[]) {
        active = [...names];
      },
    } as unknown as ExtensionAPI;
    registerForgejoTools(api, () => {
      throw new Error("runtime must not be created while loading tools");
    });
    const loader = tools.get("forgejo_tools");
    if (!loader) throw new Error("Forgejo tool loader was not registered");

    expect(loader.parameters.properties?.domains?.items?.enum).not.toContain("all");
    expect(loader.parameters.properties?.domains?.maxItems).toBe(4);
    await expect(
      loader.execute(
        "load-too-many",
        { domains: ["issue", "pull", "review", "actions", "search"] },
        signal,
        undefined,
        noUi,
      ),
    ).rejects.toThrow("at most 4 domains");
    expect(active).toEqual(["read", "forgejo_context", "forgejo_tools"]);
  });

  it("keeps lazy tools out of the system prompt and caps their model-visible output", () => {
    const tools = new Map<string, RegisteredTool>();
    const api = {
      registerTool(definition: RegisteredTool) {
        tools.set(definition.name, definition);
      },
    } as unknown as ExtensionAPI;
    registerForgejoTools(api, () => {
      throw new Error("runtime must not be created while registering tools");
    });

    const lazyNames = [
      "forgejo_actions",
      "forgejo_dashboard",
      "forgejo_issue",
      "forgejo_pull",
      "forgejo_review",
      "forgejo_notifications",
      "forgejo_search",
    ];
    for (const name of lazyNames) {
      const tool = tools.get(name);
      expect(tool?.promptSnippet, name).toBeUndefined();
      expect(tool?.promptGuidelines, name).toBeUndefined();
    }
    for (const name of lazyNames.filter((name) => name !== "forgejo_dashboard")) {
      expect(tools.get(name)?.parameters.properties?.max_bytes?.maximum, name).toBe(128_000);
    }
  });
});
