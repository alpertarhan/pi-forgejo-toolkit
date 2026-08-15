import type { CommandExecutor } from "./process.js";
import type {
  ForgejoConfig,
  GitRemote,
  RepoResolution,
  ResolvedRemote,
} from "./types.js";

interface ParsedRemoteUrl {
  host: string;
  path: string;
  enforceBasePath: boolean;
  sshHost?: string;
  sshPort?: string;
}

function parseRemoteUrl(value: string): ParsedRemoteUrl | undefined {
  const scpMatch = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/.exec(value);
  if (scpMatch && !value.includes("://")) {
    const [, host, path] = scpMatch;
    if (!host || !path) return undefined;
    return {
      host: host.toLowerCase(),
      path,
      enforceBasePath: false,
      sshHost: host.toLowerCase(),
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol))
    return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const parsed: ParsedRemoteUrl = {
    host: url.host.toLowerCase(),
    path,
    enforceBasePath: url.protocol === "http:" || url.protocol === "https:",
  };
  if (url.protocol === "ssh:") {
    parsed.sshHost = url.hostname.toLowerCase();
    if (url.port) parsed.sshPort = url.port;
  }
  return parsed;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function repoSegments(
  path: string,
  baseUrl: string,
  enforceBasePath: boolean,
): { owner: string; repo: string } | undefined {
  let normalized = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const parsedBase = parseUrl(baseUrl);
  if (!parsedBase) return undefined;
  const basePath = parsedBase.pathname.replace(/^\/+|\/+$/g, "");
  if (basePath && enforceBasePath) {
    if (!normalized.startsWith(`${basePath}/`)) return undefined;
    normalized = normalized.slice(basePath.length + 1);
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const owner = segments.at(-2);
  const repo = segments.at(-1);
  if (!owner || !repo) return undefined;
  return { owner, repo };
}

export function parseGitRemotes(output: string): GitRemote[] {
  const remotes: GitRemote[] = [];
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(.+?)\s+\((fetch|push)\)\s*$/.exec(line);
    if (!match) continue;
    const [, name, url, direction] = match;
    if (!name || !url || (direction !== "fetch" && direction !== "push"))
      continue;
    remotes.push({ name, url, direction });
  }
  return remotes;
}

export const NON_FORGEJO_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
]);

function nonForgejoRemoteHost(remotes: GitRemote[]): string | undefined {
  for (const remote of remotes) {
    if (remote.direction !== "fetch") continue;
    const parsed = parseRemoteUrl(remote.url);
    if (!parsed) continue;
    const host = parsed.host.split(":")[0] ?? "";
    if (NON_FORGEJO_HOSTS.has(host)) return host;
  }
  return undefined;
}

export type SshHostAliases = Record<string, string[]>;

export async function discoverSshHostAliases(
  exec: CommandExecutor,
  cwd: string,
  remotes: GitRemote[],
  signal?: AbortSignal,
): Promise<SshHostAliases> {
  const destinations = new Map<string, { host: string; port?: string }>();
  for (const remote of remotes) {
    if (remote.direction !== "fetch") continue;
    const parsed = parseRemoteUrl(remote.url);
    if (!parsed?.sshHost) continue;
    const key = `${parsed.sshHost}:${parsed.sshPort ?? ""}`;
    const destination: { host: string; port?: string } = {
      host: parsed.sshHost,
    };
    if (parsed.sshPort) destination.port = parsed.sshPort;
    destinations.set(key, destination);
  }
  const aliases: SshHostAliases = {};
  await Promise.all(
    [...destinations.values()].map(async (destination) => {
      const args = ["-G"];
      if (destination.port) args.push("-p", destination.port);
      args.push("--", destination.host);
      const options =
        signal === undefined
          ? { cwd, timeout: 5_000 }
          : { cwd, timeout: 5_000, signal };
      const result = await exec("ssh", args, options);
      if (result.code !== 0) return undefined;
      let hostname: string | undefined;
      let port: string | undefined;
      for (const line of result.stdout.split("\n")) {
        const separator = line.indexOf(" ");
        if (separator < 1) continue;
        const key = line.slice(0, separator).toLowerCase();
        const value = line
          .slice(separator + 1)
          .trim()
          .toLowerCase();
        if (key === "hostname") hostname = value;
        if (key === "port") port = value;
      }
      if (!hostname) return undefined;
      aliases[destination.host] = [
        ...new Set([hostname, port ? `${hostname}:${port}` : hostname]),
      ];
      return undefined;
    }),
  );
  return aliases;
}

export function matchForgejoRemotes(
  remotes: GitRemote[],
  config: ForgejoConfig,
  sshAliases: SshHostAliases = {},
): ResolvedRemote[] {
  const matches: ResolvedRemote[] = [];
  for (const remote of remotes) {
    if (remote.direction !== "fetch") continue;
    const parsed = parseRemoteUrl(remote.url);
    if (!parsed) continue;
    for (const [server, serverConfig] of Object.entries(config.servers)) {
      const baseUrl = parseUrl(serverConfig.baseUrl);
      if (!baseUrl) continue;
      const candidateHosts = [
        parsed.host,
        parsed.host.split(":")[0],
        ...(parsed.sshHost ? (sshAliases[parsed.sshHost] ?? []) : []),
      ].filter((value): value is string => Boolean(value));
      const configuredHosts = [
        baseUrl.host,
        baseUrl.hostname,
        ...serverConfig.remoteHosts,
      ].map((host) => host.toLowerCase());
      if (!candidateHosts.some((host) => configuredHosts.includes(host)))
        continue;
      const repo = repoSegments(
        parsed.path,
        serverConfig.baseUrl,
        parsed.enforceBasePath,
      );
      if (!repo) continue;
      matches.push({
        server,
        owner: repo.owner,
        repo: repo.repo,
        remote: remote.name,
        url: remote.url,
      });
    }
  }
  return matches;
}

export function resolveRepoFromRemotes(
  remotes: GitRemote[],
  config: ForgejoConfig,
  sshAliases: SshHostAliases = {},
): RepoResolution {
  const matches = matchForgejoRemotes(remotes, config, sshAliases);
  if (matches.length === 0) {
    const nonForgejo = nonForgejoRemoteHost(remotes);
    return {
      status: "none",
      reason: nonForgejo
        ? `git remote is hosted on ${nonForgejo}, which is not Forgejo; use the 'gh' CLI or plain git instead of Forgejo tools`
        : "no Git remote matches a configured Forgejo server",
    };
  }

  const unique = new Map<string, ResolvedRemote>();
  for (const match of matches) {
    const key = `${match.server}\u0000${match.owner}\u0000${match.repo}`;
    const current = unique.get(key);
    if (!current || (current.remote !== "origin" && match.remote === "origin"))
      unique.set(key, match);
  }
  const repositories = [...unique.values()];
  if (repositories.length !== 1) {
    return {
      status: "ambiguous",
      matches: repositories,
      reason:
        "multiple configured Forgejo repositories match local Git remotes; select one explicitly",
    };
  }
  const [match] = repositories;
  if (!match)
    return { status: "none", reason: "no Forgejo repository resolved" };
  return {
    status: "resolved",
    repo: { server: match.server, owner: match.owner, repo: match.repo },
    remote: match.remote,
  };
}

export async function resolveRepository(
  exec: CommandExecutor,
  cwd: string,
  config: ForgejoConfig,
): Promise<RepoResolution> {
  const result = await exec("git", ["remote", "-v"], { cwd, timeout: 5_000 });
  if (result.code !== 0) {
    return {
      status: "none",
      reason:
        result.stderr.trim() || "current directory is not a Git repository",
    };
  }
  const remotes = parseGitRemotes(result.stdout);
  const sshAliases = await discoverSshHostAliases(exec, cwd, remotes);
  return resolveRepoFromRemotes(remotes, config, sshAliases);
}
