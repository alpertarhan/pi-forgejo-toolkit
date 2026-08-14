import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/config.js";
import {
  discoverSshHostAliases,
  matchForgejoRemotes,
  parseGitRemotes,
  resolveRepoFromRemotes,
} from "../src/remote-resolver.js";

const config = parseConfig({
  servers: {
    work: {
      baseUrl: "https://forgejo.work.example/git",
      tokenEnv: "WORK_TOKEN",
      remoteHosts: ["forgejo-work"],
    },
    community: {
      baseUrl: "https://code.example.org",
      tokenEnv: "COMMUNITY_TOKEN",
      remoteHosts: ["forgejo-community"],
    },
  },
});

describe("Git remote resolution", () => {
  it("parses fetch and push records", () => {
    expect(
      parseGitRemotes(
        "origin\tgit@forgejo-work:platform/api.git (fetch)\norigin\tgit@forgejo-work:platform/api.git (push)\n",
      ),
    ).toEqual([
			{
				name: "origin",
				url: "git@forgejo-work:platform/api.git",
				direction: "fetch",
			},
			{
				name: "origin",
				url: "git@forgejo-work:platform/api.git",
				direction: "push",
			},
    ]);
  });

  it("matches HTTPS subpaths, SSH URLs, and SSH aliases", () => {
    const remotes = parseGitRemotes(
      [
        "one https://forgejo.work.example/git/platform/api.git (fetch)",
        "two ssh://git@code.example.org/community/runner.git (fetch)",
        "three git@forgejo-community:docs/site.git (fetch)",
      ].join("\n"),
    );
    expect(matchForgejoRemotes(remotes, config)).toEqual([
      {
        server: "work",
        owner: "platform",
        repo: "api",
        remote: "one",
        url: "https://forgejo.work.example/git/platform/api.git",
      },
      {
        server: "community",
        owner: "community",
        repo: "runner",
        remote: "two",
        url: "ssh://git@code.example.org/community/runner.git",
      },
      {
        server: "community",
        owner: "docs",
        repo: "site",
        remote: "three",
        url: "git@forgejo-community:docs/site.git",
      },
    ]);
  });

	it("ignores malformed escapes and HTTPS remotes outside the configured base path", () => {
		const remotes = parseGitRemotes(
			[
				"bad https://forgejo.work.example/git/%E0%A4%A/api.git (fetch)",
				"outside https://forgejo.work.example/other/platform/api.git (fetch)",
			].join("\n"),
		);
		expect(matchForgejoRemotes(remotes, config)).toEqual([]);
	});

  it("resolves SSH config aliases without opening a connection", async () => {
		const remotes = parseGitRemotes(
			"origin git@work-alias:platform/api.git (fetch)",
		);
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: "host work-alias\nhostname forgejo.work.example\nport 2222\n",
      stderr: "",
    }));

    const aliases = await discoverSshHostAliases(exec, "/workspace", remotes);

    expect(exec).toHaveBeenCalledWith("ssh", ["-G", "--", "work-alias"], {
      cwd: "/workspace",
      timeout: 5_000,
    });
    expect(aliases).toEqual({
      "work-alias": ["forgejo.work.example", "forgejo.work.example:2222"],
    });
    expect(resolveRepoFromRemotes(remotes, config, aliases)).toEqual({
      status: "resolved",
      repo: { server: "work", owner: "platform", repo: "api" },
      remote: "origin",
    });
  });

  it("resolves one canonical repository across duplicate remotes", () => {
    const remotes = parseGitRemotes(
      "origin git@forgejo-work:platform/api.git (fetch)\nmirror https://forgejo.work.example/git/platform/api.git (fetch)",
    );
    expect(resolveRepoFromRemotes(remotes, config)).toEqual({
      status: "resolved",
      repo: { server: "work", owner: "platform", repo: "api" },
      remote: "origin",
    });
  });

  it("refuses to silently choose between two Forgejo repositories", () => {
    const remotes = parseGitRemotes(
      "origin git@forgejo-work:platform/api.git (fetch)\nmirror git@forgejo-community:platform/api.git (fetch)",
    );
    const resolution = resolveRepoFromRemotes(remotes, config);
    expect(resolution.status).toBe("ambiguous");
		if (resolution.status === "ambiguous")
			expect(resolution.matches).toHaveLength(2);
  });
});
