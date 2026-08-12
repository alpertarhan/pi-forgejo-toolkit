import { describe, expect, it, vi } from "vitest";
import { buildFgjConfig, discoverFgjInstances, parseFgjAuthStatus } from "../src/fgj.js";
import type { CommandExecutor } from "../src/process.js";

describe("fgj instance discovery", () => {
  it("parses authenticated instances from fgj output", () => {
    const output = [
      "Authenticated instances:",
      "",
      "  \u001b[32m•\u001b[0m git.acme.example (user: alice)",
      "  • git.community.example (user: release-bot)",
    ].join("\n");

    expect(parseFgjAuthStatus(output)).toEqual([
      { hostname: "git.acme.example", user: "alice" },
      { hostname: "git.community.example", user: "release-bot" },
    ]);
  });

  it("uses fgj auth status and never requests token output during discovery", async () => {
    const exec = vi.fn<CommandExecutor>(async () => ({
      code: 0,
      stdout: "Authenticated instances:\n\n  • git.example.dev (user: alice)\n",
      stderr: "",
    }));

    await expect(discoverFgjInstances(exec, "/workspace", "/tmp/fgj.yaml")).resolves.toEqual([
      { hostname: "git.example.dev", user: "alice" },
    ]);
    expect(exec).toHaveBeenCalledWith("fgj", ["--config", "/tmp/fgj.yaml", "auth", "status"], {
      cwd: "/workspace",
      timeout: 10_000,
    });
  });

  it("builds deterministic aliases and fgj-backed server config", () => {
    const config = buildFgjConfig([
      { hostname: "git.acme.example", user: "alice" },
      { hostname: "git.community.example", user: "alice" },
      { hostname: "code.acme.example", user: "alice" },
    ]);

    expect(config.servers).toEqual({
      acme: {
        baseUrl: "https://git.acme.example",
        hostname: "git.acme.example",
        credentialProvider: "fgj",
        remoteHosts: ["git.acme.example"],
      },
      community: {
        baseUrl: "https://git.community.example",
        hostname: "git.community.example",
        credentialProvider: "fgj",
        remoteHosts: ["git.community.example"],
      },
      "acme-2": {
        baseUrl: "https://code.acme.example",
        hostname: "code.acme.example",
        credentialProvider: "fgj",
        remoteHosts: ["code.acme.example"],
      },
    });
  });
});
