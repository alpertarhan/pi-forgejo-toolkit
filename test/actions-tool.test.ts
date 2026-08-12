import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ForgejoClient, RequestOptions } from "../src/client.js";
import type { ForgejoRuntime } from "../src/runtime.js";
import { registerActionsTool } from "../src/tools/actions.js";
import type { ApiResult, ForgejoCapabilities } from "../src/types.js";

interface CapturedTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

function captureActionsTool(runtime: ForgejoRuntime): CapturedTool {
  let captured: CapturedTool | undefined;
  const api = {
    registerTool(definition: CapturedTool) {
      captured = definition;
    },
  } as unknown as ExtensionAPI;
  registerActionsTool(api, () => runtime);
  if (!captured) throw new Error("Actions tool was not registered");
  return captured;
}

function apiResult<T>(data: T, status = 200, totalCount?: number): ApiResult<T> {
  const result: ApiResult<T> = { data, status, headers: new Headers() };
  if (totalCount !== undefined) result.totalCount = totalCount;
  return result;
}

function capabilities(overrides: Partial<ForgejoCapabilities["features"]> = {}): ForgejoCapabilities {
  return {
    server: "work",
    version: "16.0.2",
    user: { id: 1, login: "alice" },
    paging: {},
    features: {
      dashboardSearch: true,
      notifications: true,
      reviews: true,
      actionsRuns: "available",
      actionsDispatch: "available",
      actionsCancel: "available",
      actionsRerun: "available",
      actionsArtifacts: "available",
      ...overrides,
    },
  };
}

function fakeRuntime(
  request: (path: string, options?: RequestOptions) => Promise<ApiResult<unknown>>,
  options: { cwd?: string; features?: Partial<ForgejoCapabilities["features"]> } = {},
): ForgejoRuntime {
  const capability = capabilities(options.features);
  return {
    cwd: options.cwd ?? process.cwd(),
    resolveRepo: () => ({ server: "work", owner: "acme", repo: "app" }),
    client: () => ({ request } as unknown as ForgejoClient),
    capabilities: {
      get: () => capability,
      refresh: vi.fn(async () => ({ values: { work: capability }, errors: {} })),
    },
    dashboard: { refresh: vi.fn(async () => undefined) },
  } as unknown as ForgejoRuntime;
}
function confirmedContext(confirm = vi.fn(async (_title: string, _message: string) => true)): { ctx: ExtensionContext; confirm: typeof confirm } {
  return {
    ctx: { hasUI: true, ui: { confirm } } as unknown as ExtensionContext,
    confirm,
  };
}

const signal = new AbortController().signal;
const noUi = { hasUI: false } as ExtensionContext;

function actionRun(status: "running" | "success") {
  return {
    id: 91,
    title: "Release",
    workflow_id: "release.yml",
    index_in_repo: 7,
    prettyref: "refs/heads/main",
    commit_sha: "abc123",
    event: "workflow_dispatch",
    status,
    started: "2026-08-12T10:00:00Z",
    stopped: "2026-08-12T10:01:00Z",
    created: "2026-08-12T10:00:00Z",
    updated: "2026-08-12T10:01:00Z",
    html_url: "https://forgejo.example/acme/app/actions/runs/7",
  };
}

describe("forgejo_actions mutation safety", () => {
  it("confirms exact dispatch inputs but keeps their values out of model-facing output", async () => {
    const request = vi.fn(async (path: string, options?: RequestOptions) => {
      expect(path).toBe("repos/acme/app/actions/workflows/release.yml/dispatches");
      expect(options).toMatchObject({
        method: "POST",
        body: {
          ref: "refs/heads/main",
          inputs: { channel: "stable", token: "sensitive-input" },
          return_run_info: true,
        },
      });
      return apiResult({ id: 91, run_number: 7, jobs: ["publish"] }, 201);
    });
    const runtime = fakeRuntime(request);
    const tool = captureActionsTool(runtime);
    const ui = confirmedContext();

    const result = await tool.execute(
      "dispatch",
      {
        action: "dispatch",
        workflow_id: "release.yml",
        git_ref: "refs/heads/main",
        inputs: { channel: "stable", token: "sensitive-input" },
      },
      signal,
      undefined,
      ui.ctx,
    );

    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(ui.confirm.mock.calls[0]?.[1]).toContain('"token": "sensitive-input"');
    expect(JSON.stringify(result)).not.toContain("sensitive-input");
    expect(request).toHaveBeenCalledOnce();
  });

  it("refuses an unadvertised rerun before reading or mutating the run", async () => {
    const request = vi.fn(async () => apiResult(undefined));
    const runtime = fakeRuntime(request, { features: { actionsRerun: "unavailable" } });
    const tool = captureActionsTool(runtime);
    const ui = confirmedContext();

    await expect(
      tool.execute("rerun", { action: "rerun", run_id: 91 }, signal, undefined, ui.ctx),
    ).rejects.toThrow("does not advertise the run rerun API");
    expect(request).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("cancels an active run only after confirmation and reads back its state", async () => {
    let readCount = 0;
    const request = vi.fn(async (path: string, options?: RequestOptions) => {
      if (options?.method === "POST") {
        expect(path).toBe("repos/acme/app/actions/runs/91/cancel");
        return apiResult(undefined, 204);
      }
      readCount += 1;
      return apiResult(actionRun(readCount === 1 ? "running" : "success"));
    });
    const runtime = fakeRuntime(request);
    const tool = captureActionsTool(runtime);
    const ui = confirmedContext();

    await tool.execute("cancel", { action: "cancel", run_id: 91 }, signal, undefined, ui.ctx);

    expect(ui.confirm).toHaveBeenCalledOnce();
    expect(request.mock.calls.map((call) => [call[0], call[1]?.method ?? "GET"])).toEqual([
      ["repos/acme/app/actions/runs/91", "GET"],
      ["repos/acme/app/actions/runs/91/cancel", "POST"],
      ["repos/acme/app/actions/runs/91", "GET"],
    ]);
  });
});

describe("forgejo_actions artifact download safety", () => {
  it("writes exact ZIP bytes atomically and refuses an implicit overwrite", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgejo-actions-tool-"));
    const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff]);
    let downloadCalls = 0;
    const request = vi.fn(async (path: string, options?: RequestOptions) => {
      if (path.endsWith("/zip")) {
        downloadCalls += 1;
        expect(options).toMatchObject({
          accept: "application/zip",
          responseType: "bytes",
          maxResponseBytes: 10_000,
        });
        return apiResult(archive);
      }
      return apiResult({
        id: 6,
        name: "coverage",
        size_in_bytes: archive.byteLength,
        archive_download_url: "https://forgejo.example/api/v1/repos/acme/app/actions/artifacts/6/zip",
        expired: false,
        run_id: 44,
        created_at: "2026-08-12T10:00:00Z",
        updated_at: "2026-08-12T10:01:00Z",
        expires_at: "2026-08-19T10:00:00Z",
      });
    });
    const runtime = fakeRuntime(request, { cwd });
    const tool = captureActionsTool(runtime);

    try {
      await tool.execute(
        "download",
        { action: "download_artifact", artifact_id: 6, output_path: "coverage.zip", max_download_bytes: 10_000 },
        signal,
        undefined,
        noUi,
      );
      expect([...(await readFile(join(cwd, "coverage.zip")))]).toEqual([...archive]);

      await expect(
        tool.execute(
          "download-again",
          { action: "download_artifact", artifact_id: 6, output_path: "coverage.zip", max_download_bytes: 10_000 },
          signal,
          undefined,
          noUi,
        ),
      ).rejects.toThrow("artifact output already exists");
      expect(downloadCalls).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a destination outside the workspace before downloading bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgejo-actions-path-"));
    let downloadCalls = 0;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/zip")) {
        downloadCalls += 1;
        return apiResult(new Uint8Array([1]));
      }
      return apiResult({
        id: 6,
        name: "coverage",
        size_in_bytes: 1,
        archive_download_url: "https://forgejo.example/archive.zip",
        expired: false,
        run_id: 44,
        created_at: "2026-08-12T10:00:00Z",
        updated_at: "2026-08-12T10:01:00Z",
        expires_at: "2026-08-19T10:00:00Z",
      });
    });
    const runtime = fakeRuntime(request, { cwd });
    const tool = captureActionsTool(runtime);

    try {
      await expect(
        tool.execute(
          "escape",
          { action: "download_artifact", artifact_id: 6, output_path: "../escape.zip" },
          signal,
          undefined,
          noUi,
        ),
      ).rejects.toThrow("must stay inside the current workspace");
      expect(downloadCalls).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
