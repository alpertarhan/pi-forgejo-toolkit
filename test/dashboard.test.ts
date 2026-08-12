import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ForgejoClient, ForgejoClientPool } from "../src/client.js";
import { DashboardNotifier } from "../src/dashboard/notifier.js";
import { DashboardStore } from "../src/dashboard/store.js";
import { renderDashboardStatus, renderWidgetLines } from "../src/dashboard/widget.js";

function jsonResponse(data: unknown, total?: number): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (total !== undefined) headers.set("x-total-count", String(total));
  return new Response(JSON.stringify(data), { status: 200, headers });
}

function issue(number: number, title: string, pull = false, state: "open" | "closed" = "open"): Record<string, unknown> {
  return {
    id: number,
    number,
    title,
    state,
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

function dashboardFetch(state: { review: boolean; failWork: boolean; includeClosed?: boolean }): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "community.example") throw new Error("community offline");
    if (state.failWork) throw new Error("work offline");
    if (url.pathname.endsWith("/user")) return jsonResponse({ id: 7, login: "alice" });
    if (url.pathname.endsWith("/repos/issues/search")) {
      expect(url.searchParams.get("state")).toBe("open");
      if (url.searchParams.get("assigned") === "true") {
        return jsonResponse(
          [issue(10, "Assigned issue"), ...(state.includeClosed ? [issue(11, "Closed assigned issue", false, "closed")] : [])],
          state.includeClosed ? 5 : 4,
        );
      }
      if (url.searchParams.get("created") === "true") {
        return jsonResponse(
          [issue(20, "Authored pull", true), ...(state.includeClosed ? [issue(21, "Closed authored pull", true, "closed")] : [])],
          state.includeClosed ? 3 : 2,
        );
      }
      if (url.searchParams.get("review_requested") === "true") {
        const items = [
          ...(state.review ? [issue(30, "Review this", true)] : []),
          ...(state.includeClosed ? [issue(31, "Closed review request", true, "closed")] : []),
        ];
        return jsonResponse(items, items.length);
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
  it("isolates server failures and clears every stale item from the failed server", async () => {
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
    expect(store.snapshot().servers.work?.health).toBe("error");
    expect(store.snapshot().totals).toEqual({ assignedIssues: 0, authoredPulls: 0, reviewRequests: 0, notifications: 0, failedRuns: 0 });
    expect(store.snapshot().attention).toEqual([]);
    store.close();
  });

  it("clears repository-scoped CI runs immediately when repository context changes", async () => {
    const state = { review: false, failWork: false };
    const store = new DashboardStore(clients(dashboardFetch(state), false), 3, {
      server: "work",
      owner: "acme",
      repo: "app",
    });
    await store.refresh();
    expect(store.snapshot().totals.failedRuns).toBe(1);

    store.setActiveRepo({ server: "work", owner: "acme", repo: "next" });
    expect(store.snapshot().servers.work?.failedRuns).toEqual({ total: 0, items: [] });
    expect(store.snapshot().totals.failedRuns).toBe(0);
    expect(store.snapshot().totals.authoredPulls).toBe(2);
    expect(store.snapshot().attention.some((item) => item.kind === "ci-failed")).toBe(false);
    store.close();
  });

  it("excludes closed results and labels authored pull totals as open", async () => {
    const state = { review: true, failWork: false, includeClosed: true };
    const store = new DashboardStore(clients(dashboardFetch(state), false), 3);
    await store.refresh();
    const server = store.snapshot().servers.work;

    expect(server?.assignedIssues).toMatchObject({ total: 1, items: [{ index: 10 }] });
    expect(server?.authoredPulls).toMatchObject({ total: 1, items: [{ index: 20 }] });
    expect(server?.reviewRequests).toMatchObject({ total: 1, items: [{ index: 30 }] });
    expect(store.snapshot().attention.map((item) => item.index)).not.toEqual(expect.arrayContaining([11, 21, 31]));
    expect(renderWidgetLines(store.snapshot(), 100, theme, "full")[1]).toContain("My Open PRs 1");
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

  it("refreshes lazily until a dashboard observer exists", async () => {
    const state = { review: false, failWork: false };
    const store = new DashboardStore(clients(dashboardFetch(state), false), 3);
    const refresh = vi.spyOn(store, "refresh");

    await store.refreshIfObserved();
    expect(refresh).not.toHaveBeenCalled();
    expect(store.snapshot().fetchedAt).toBeUndefined();

    const unsubscribe = store.subscribe(() => undefined);
    await store.refreshIfObserved();
    expect(refresh).toHaveBeenCalledOnce();
    expect(store.snapshot().fetchedAt).toBeDefined();

    unsubscribe();
    await store.refreshIfObserved();
    expect(refresh).toHaveBeenCalledOnce();
    store.close();
  });

  it("refreshes dirty data once and reports status without leaking repository identity", async () => {
    const state = { review: true, failWork: false };
    const store = new DashboardStore(clients(dashboardFetch(state), false), 3, {
      server: "work",
      owner: "acme",
      repo: "app",
    });
    const refresh = vi.spyOn(store, "refresh");
    await store.ensureFresh();
    await store.ensureFresh();
    expect(refresh).toHaveBeenCalledOnce();

    store.setActiveRepo({ server: "work", owner: "acme", repo: "app" });
    await store.ensureFresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(renderDashboardStatus(store.snapshot(), "counts-only")).toBe("fj all · 9 attention");
    expect(renderDashboardStatus({ ...store.snapshot(), refreshing: true }, "full")).toBe("fj work:acme/app · syncing");
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
    expect(wide[1]).toBe("Issues 4 | My Open PRs 2 | Reviews 1 | Inbox 7 | CI failed 1");
    expect(wide[2]).toContain("Next: review work:acme/app!30");
    store.close();
  });
});
