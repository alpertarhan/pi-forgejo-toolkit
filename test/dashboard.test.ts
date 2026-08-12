import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ForgejoClient, ForgejoClientPool } from "../src/client.js";
import { DashboardNotifier } from "../src/dashboard/notifier.js";
import { DashboardStore } from "../src/dashboard/store.js";
import { renderWidgetLines } from "../src/dashboard/widget.js";

function jsonResponse(data: unknown, total?: number): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (total !== undefined) headers.set("x-total-count", String(total));
  return new Response(JSON.stringify(data), { status: 200, headers });
}

function issue(number: number, title: string, pull = false): Record<string, unknown> {
  return {
    id: number,
    number,
    title,
    state: "open",
    html_url: `https://work.example/acme/app/${pull ? "pulls" : "issues"}/${number}`,
    updated_at: "2026-08-12T10:00:00Z",
    repository: {
      id: 1,
      name: "app",
      full_name: "acme/app",
      html_url: "https://work.example/acme/app",
    },
    ...(pull ? { pull_request: {} } : {}),
  };
}

function dashboardFetch(state: { review: boolean; failWork: boolean }): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "community.example") throw new Error("community offline");
    if (state.failWork) throw new Error("work offline");
    if (url.pathname.endsWith("/user")) return jsonResponse({ id: 7, login: "alice" });
    if (url.pathname.endsWith("/repos/issues/search")) {
      if (url.searchParams.get("assigned") === "true") return jsonResponse([issue(10, "Assigned issue")], 4);
      if (url.searchParams.get("created") === "true") return jsonResponse([issue(20, "Authored pull", true)], 2);
      if (url.searchParams.get("review_requested") === "true") {
        return jsonResponse(state.review ? [issue(30, "Review this", true)] : [], state.review ? 1 : 0);
      }
    }
    if (url.pathname.endsWith("/actions/runs")) {
      expect(url.searchParams.get("page")).toBe("1");
      expect(url.searchParams.get("limit")).toBe("50");
      return jsonResponse({
        total_count: 3,
        workflow_runs: [
          {
            id: 51,
            title: "CI failed",
            workflow_id: "ci.yml",
            index_in_repo: 9,
            prettyref: "main",
            commit_sha: "failed-sha",
            event: "push",
            status: "failure",
            started: "2026-08-12T10:04:00Z",
            stopped: "2026-08-12T10:05:00Z",
            created: "2026-08-12T10:04:00Z",
            updated: "2026-08-12T10:05:00Z",
            html_url: "https://work.example/acme/app/actions/runs/9",
          },
          {
            id: 50,
            title: "Docs recovered",
            workflow_id: "docs.yml",
            index_in_repo: 8,
            prettyref: "main",
            commit_sha: "docs-new",
            event: "push",
            status: "success",
            started: "2026-08-12T10:03:00Z",
            stopped: "2026-08-12T10:04:00Z",
            created: "2026-08-12T10:03:00Z",
            updated: "2026-08-12T10:04:00Z",
            html_url: "https://work.example/acme/app/actions/runs/8",
          },
          {
            id: 49,
            title: "Old docs failure",
            workflow_id: "docs.yml",
            index_in_repo: 7,
            prettyref: "main",
            commit_sha: "docs-old",
            event: "push",
            status: "failure",
            started: "2026-08-12T10:01:00Z",
            stopped: "2026-08-12T10:02:00Z",
            created: "2026-08-12T10:01:00Z",
            updated: "2026-08-12T10:02:00Z",
            html_url: "https://work.example/acme/app/actions/runs/7",
          },
        ],
      });
    }
    if (url.pathname.endsWith("/notifications")) {
      return jsonResponse(
        [
          {
            id: 40,
            unread: true,
            pinned: false,
            updated_at: "2026-08-12T10:01:00Z",
            subject: {
              title: "Mentioned issue",
              type: "Issue",
              url: "https://work.example/api/v1/repos/acme/app/issues/11",
            },
            repository: {
              id: 1,
              name: "app",
              full_name: "acme/app",
              html_url: "https://work.example/acme/app",
            },
          },
        ],
        7,
      );
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

function clients(fetchImpl: typeof fetch, includeCommunity: boolean): ForgejoClientPool {
  const entries: Record<string, ForgejoClient> = {
    work: new ForgejoClient(
      "work",
      {
        baseUrl: "https://work.example",
        hostname: "work.example",
        credentialProvider: "env",
        tokenEnv: "WORK_TOKEN",
        remoteHosts: ["work.example"],
      },
      { environment: { WORK_TOKEN: "work-secret" }, fetchImpl },
    ),
  };
  if (includeCommunity) {
    entries.community = new ForgejoClient(
      "community",
      {
        baseUrl: "https://community.example",
        hostname: "community.example",
        credentialProvider: "env",
        tokenEnv: "COMMUNITY_TOKEN",
        remoteHosts: ["community.example"],
      },
      { environment: { COMMUNITY_TOKEN: "community-secret" }, fetchImpl },
    );
  }
  return new ForgejoClientPool(entries);
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

describe("DashboardStore", () => {
  it("keeps successful server data when another server fails", async () => {
    const state = { review: true, failWork: false };
    const store = new DashboardStore(clients(dashboardFetch(state), true), 3, {
      server: "work",
      owner: "acme",
      repo: "app",
    });
    await store.refresh();
    const snapshot = store.snapshot();
    expect(snapshot.servers.work?.health).toBe("ready");
    expect(snapshot.servers.community?.health).toBe("error");
    expect(snapshot.totals).toMatchObject({ assignedIssues: 4, authoredPulls: 2, reviewRequests: 1, notifications: 7, failedRuns: 1 });
    expect(snapshot.attention[0]).toMatchObject({ kind: "review", index: 30, server: "work" });

    state.failWork = true;
    await store.refresh();
    expect(store.snapshot().servers.work?.health).toBe("stale");
    expect(store.snapshot().totals.assignedIssues).toBe(4);
    store.close();
  });

  it("does not notify on initial load and deduplicates later review requests", async () => {
    const state = { review: false, failWork: false };
    const store = new DashboardStore(clients(dashboardFetch(state), false), 3);
    const notify = vi.fn();
    const notifier = new DashboardNotifier(store, "important", notify);
    await store.refresh();
    expect(notify).not.toHaveBeenCalled();

    state.review = true;
    await store.refresh();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain("work:acme/app!30");

    await store.refresh();
    expect(notify).toHaveBeenCalledTimes(1);
    notifier.close();
    store.close();
  });

  it("renders stable compact and wide widget layouts", async () => {
    const state = { review: true, failWork: false };
    const store = new DashboardStore(clients(dashboardFetch(state), false), 3, {
      server: "work",
      owner: "acme",
      repo: "app",
    });
    await store.refresh();
    const compact = renderWidgetLines(store.snapshot(), 45, theme, "full");
    const wide = renderWidgetLines(store.snapshot(), 100, theme, "full");
    expect(compact).toHaveLength(1);
    expect(compact[0]).toContain("I:4 P:2 R:1 N:7 C:1");
    expect(wide).toHaveLength(3);
    expect(wide[1]).toBe("Issues 4 | My PRs 2 | Reviews 1 | Inbox 7 | CI failed 1");
    expect(wide[2]).toContain("Next: review work:acme/app!30");
    store.close();
  });
});
