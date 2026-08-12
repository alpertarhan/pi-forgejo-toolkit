import { describe, expect, it, vi } from "vitest";
import { ForgejoClient, ForgejoError } from "../src/client.js";

const SERVER = {
  baseUrl: "https://forgejo.example/internal",
  hostname: "forgejo.example",
  credentialProvider: "env" as const,
  tokenEnv: "FORGEJO_TOKEN",
  remoteHosts: ["forgejo.example"],
};

describe("ForgejoClient", () => {
  it("uses the subpath API URL, authorization header, and pagination metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://forgejo.example/internal/api/v1/repos/issues/search?state=open&status-types=unread&status-types=pinned");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("token secret-value");
      expect(init?.redirect).toBe("manual");
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json", "x-total-count": "42" },
      });
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });
    const result = await client.request<unknown[]>("repos/issues/search", {
      query: { state: "open", "status-types": ["unread", "pinned"] },
    });
    expect(result.data).toEqual([]);
    expect(result.totalCount).toBe(42);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts token values from HTTP errors", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('{"message":"token secret-value was rejected"}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });
    await expect(client.request("user")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ForgejoError);
      expect((error as ForgejoError).code).toBe("auth");
      expect((error as Error).message).toContain("[REDACTED]");
      expect((error as Error).message).not.toContain("secret-value");
      return true;
    });
  });

  it("never forwards credentials across origins", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/capture" },
      }),
    );
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });
    await expect(client.request("user")).rejects.toMatchObject({ code: "redirect" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not follow redirects for mutations", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 307,
        headers: { location: "https://forgejo.example/internal/api/v1/issues/2" },
      }),
    );
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });
    await expect(client.request("issues/1", { method: "PATCH", body: { state: "closed" } })).rejects.toMatchObject({
      code: "redirect",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["11.0.0", "unavailable"],
    ["12.0.0", "available"],
    ["development", "unknown"],
  ] as const)("detects Actions runs support for Forgejo %s", async (version, expected) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/version")) {
        return new Response(JSON.stringify({ version }), { headers: { "content-type": "application/json" } });
      }
      if (pathname.endsWith("/user")) {
        return new Response(JSON.stringify({ id: 7, login: "alice" }), { headers: { "content-type": "application/json" } });
      }
      if (pathname.endsWith("/settings/api")) {
        return new Response(JSON.stringify({ default_paging_num: 30 }), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request: ${pathname}`);
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });

    await expect(client.discoverCapabilities()).resolves.toMatchObject({
      version,
      features: { actionsRuns: expected },
    });
  });

  it("discovers individual Actions routes from same-origin Swagger without sending credentials", async () => {
    const paths = {
      "/repos/{owner}/{repo}/actions/runs": {},
      "/repos/{owner}/{repo}/actions/workflows/{workflowfilename}/dispatches": {},
      "/repos/{owner}/{repo}/actions/runs/{run_id}/cancel": {},
      "/repos/{owner}/{repo}/actions/artifacts": {},
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/internal/swagger.v1.json") {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        return new Response(JSON.stringify({ paths }), { headers: { "content-type": "application/json" } });
      }
      if (pathname.endsWith("/version")) {
        return new Response(JSON.stringify({ version: "16.0.2" }), { headers: { "content-type": "application/json" } });
      }
      if (pathname.endsWith("/user")) {
        return new Response(JSON.stringify({ id: 7, login: "alice" }), { headers: { "content-type": "application/json" } });
      }
      if (pathname.endsWith("/settings/api")) {
        return new Response(JSON.stringify({ default_paging_num: 30 }), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request: ${pathname}`);
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });

    await expect(client.discoverCapabilities()).resolves.toMatchObject({
      features: {
        actionsRuns: "available",
        actionsDispatch: "available",
        actionsCancel: "available",
        actionsRerun: "unavailable",
        actionsArtifacts: "available",
      },
    });
  });

  it("rejects an unbounded binary response once it crosses the caller limit", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });

    await expect(
      client.request<Uint8Array>("repos/acme/app/archive", {
        accept: "application/octet-stream",
        responseType: "bytes",
        maxResponseBytes: 4,
      }),
    ).rejects.toThrow("response exceeds the 4 byte limit");
  });
});
