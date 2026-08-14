import { describe, expect, it, vi } from "vitest";
import {
  cancelActionRun,
  dispatchActionWorkflow,
  getActionJobLog,
  downloadActionArtifact,
  latestFailedActionRuns,
  listActionArtifacts,
  listActionRuns,
  rerunActionRun,
} from "../src/actions.js";
import { ForgejoClient } from "../src/client.js";
import type { ForgejoActionRun, RepoRef } from "../src/types.js";

const SERVER = {
  baseUrl: "https://forgejo.example",
  hostname: "forgejo.example",
  credentialProvider: "env" as const,
  tokenEnv: "FORGEJO_TOKEN",
  remoteHosts: ["forgejo.example"],
};
const REPO: RepoRef = { server: "work", owner: "acme", repo: "app" };

function run(
	id: number,
	workflow: string,
	ref: string,
	status: ForgejoActionRun["status"],
	updated: string,
): ForgejoActionRun {
  return {
    id,
    title: `Run ${id}`,
    workflow_id: workflow,
    index_in_repo: id,
    prettyref: ref,
    commit_sha: `sha-${id}`,
    event: "push",
    status,
    started: updated,
    stopped: updated,
    created: updated,
    updated,
    html_url: `https://forgejo.example/acme/app/actions/runs/${id}`,
  };
}

describe("Forgejo Actions queries", () => {
  it("sends documented pagination and filters and unwraps the run list", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/repos/acme/app/actions/runs");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        page: "2",
        limit: "10",
        event: "pull_request",
        status: "failure",
        head_sha: "head-sha",
        ref: "refs/heads/main",
        workflow_id: "ci.yml",
      });
      return new Response(
        JSON.stringify({
          total_count: 42,
					workflow_runs: [
						run(8, "ci.yml", "main", "failure", "2026-08-12T10:00:00Z"),
						null,
					],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret" },
      fetchImpl: fetchMock,
    });

    const page = await listActionRuns(client, REPO, {
      page: 2,
      limit: 10,
      event: "pull_request",
      status: "failure",
      headSha: "head-sha",
      ref: "refs/heads/main",
      workflowId: "ci.yml",
    });

    expect(page).toMatchObject({ total: 42, page: 2, limit: 10 });
    expect(page.runs.map((item) => item.id)).toEqual([8]);
  });

  it("keeps only the newest failed run for each workflow and ref", () => {
    const failures = latestFailedActionRuns([
      run(5, "ci.yml", "main", "failure", "2026-08-12T10:05:00Z"),
      run(4, "docs.yml", "main", "success", "2026-08-12T10:04:00Z"),
      run(3, "docs.yml", "main", "failure", "2026-08-12T10:03:00Z"),
      run(2, "ci.yml", "main", "success", "2026-08-12T10:02:00Z"),
      run(6, "ci.yml", "feature", "failure", "invalid-date"),
      run(1, "ci.yml", "feature", "success", "invalid-date"),
    ]);

    expect(failures.map((item) => item.id)).toEqual([5, 6]);
  });

  it("uses an HTTP byte range for bounded plaintext job logs", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
			expect(String(input)).toBe(
				"https://forgejo.example/api/v1/repos/acme/app/actions/jobs/19/logs?attempt=2",
			);
      const headers = new Headers(init?.headers);
      expect(headers.get("range")).toBe("bytes=0-3999");
      return new Response("bounded log", {
        status: 206,
        headers: { "content-type": "text/plain" },
      });
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret" },
      fetchImpl: fetchMock,
    });

    await expect(getActionJobLog(client, REPO, 19, 2, 4_000)).resolves.toEqual({
      log: "bounded log",
      truncated: true,
    });
  });

  it("dispatches exact workflow inputs and asks Forgejo to return the run", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
			expect(String(input)).toBe(
				"https://forgejo.example/api/v1/repos/acme/app/actions/workflows/release.yml/dispatches",
			);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        ref: "refs/heads/main",
        inputs: { channel: "stable", token: "sensitive-input" },
        return_run_info: true,
      });
			return new Response(
				JSON.stringify({ id: 91, run_number: 7, jobs: ["publish"] }),
				{
        status: 201,
        headers: { "content-type": "application/json" },
				},
			);
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret" },
      fetchImpl: fetchMock,
    });

    await expect(
			dispatchActionWorkflow(client, REPO, "release.yml", "refs/heads/main", {
				channel: "stable",
				token: "sensitive-input",
			}),
    ).resolves.toEqual({ id: 91, run_number: 7, jobs: ["publish"] });
  });

  it("uses separate capability-compatible endpoints for cancel and rerun", async () => {
    const paths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      paths.push(new URL(String(input)).pathname);
      expect(init?.method).toBe("POST");
      return new Response(null, { status: 204 });
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret" },
      fetchImpl: fetchMock,
    });

    await cancelActionRun(client, REPO, 12);
    await rerunActionRun(client, REPO, 12);

    expect(paths).toEqual([
      "/api/v1/repos/acme/app/actions/runs/12/cancel",
      "/api/v1/repos/acme/app/actions/runs/12/rerun",
    ]);
  });

  it("lists run artifacts with pagination and preserves binary ZIP bytes", async () => {
    const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/runs/44/artifacts")) {
				expect(Object.fromEntries(url.searchParams)).toEqual({
					name: "coverage",
					page: "2",
					limit: "5",
				});
        return new Response(
          JSON.stringify([
            {
              id: 6,
              name: "coverage",
              size_in_bytes: 800,
							archive_download_url:
								"https://forgejo.example/api/v1/repos/acme/app/actions/artifacts/6/zip",
              expired: false,
              run_id: 44,
              created_at: "2026-08-12T10:00:00Z",
              updated_at: "2026-08-12T10:01:00Z",
              expires_at: "2026-08-19T10:00:00Z",
            },
          ]),
					{
						headers: {
							"content-type": "application/json",
							"x-total-count": "9",
						},
					},
        );
      }
			expect(url.pathname).toBe(
				"/api/v1/repos/acme/app/actions/artifacts/6/zip",
			);
      expect(new Headers(init?.headers).get("accept")).toBe("application/zip");
			return new Response(archive, {
				headers: { "content-type": "application/zip" },
			});
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret" },
      fetchImpl: fetchMock,
    });

		const page = await listActionArtifacts(client, REPO, {
			runId: 44,
			name: "coverage",
			page: 2,
			limit: 5,
		});
    const downloaded = await downloadActionArtifact(client, REPO, 6, 1_000);

    expect(page).toMatchObject({ total: 9, page: 2, limit: 5, runId: 44 });
    expect(page.artifacts.map((artifact) => artifact.id)).toEqual([6]);
		expect([
			...new Uint8Array(await new Response(downloaded).arrayBuffer()),
		]).toEqual([...archive]);
  });
});
