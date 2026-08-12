import { parseConfig } from "./config.js";
import type { ForgejoConfig } from "./types.js";
import type { CommandExecutor } from "./process.js";

export interface FgjInstance {
  hostname: string;
  user: string;
}


export function parseFgjAuthStatus(output: string): FgjInstance[] {
  const instances: FgjInstance[] = [];
  for (const line of output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split("\n")) {
    const match = /^[\s•*-]*([A-Za-z0-9.-]+(?::\d+)?)\s+\(user:\s*([^)]+)\)\s*$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    instances.push({ hostname: match[1].toLowerCase(), user: match[2].trim() });
  }
  return instances;
}

export async function discoverFgjInstances(
  exec: CommandExecutor,
  cwd: string,
  configPath?: string,
  signal?: AbortSignal,
): Promise<FgjInstance[]> {
  const args = configPath ? ["--config", configPath, "auth", "status"] : ["auth", "status"];
  const options = signal === undefined ? { cwd, timeout: 10_000 } : { cwd, timeout: 10_000, signal };
  const result = await exec("fgj", args, options);
  if (result.code !== 0) {
    const detail = result.stderr.replace(/\s+/g, " ").trim().slice(0, 300);
    throw new Error(`fgj auth status failed${detail ? `: ${detail}` : ""}`);
  }
  const instances = parseFgjAuthStatus(result.stdout);
  if (instances.length === 0) throw new Error("fgj auth status returned no authenticated Forgejo instances");
  return instances;
}

export function suggestServerAlias(hostname: string): string {
  const host = hostname.split(":")[0] ?? hostname;
  const labels = host.split(".").filter(Boolean);
  if (labels.length > 2 && ["git", "code", "forgejo"].includes(labels[0] ?? "")) labels.shift();
  const candidate = (labels[0] ?? "forgejo").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return candidate || "forgejo";
}

export function buildFgjConfig(instances: FgjInstance[]): ForgejoConfig {
  const used = new Set<string>();
  const servers: Record<string, unknown> = {};
  for (const instance of instances) {
    const base = suggestServerAlias(instance.hostname);
    let alias = base;
    let suffix = 2;
    while (used.has(alias)) {
      alias = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(alias);
    servers[alias] = {
      hostname: instance.hostname,
      credentialProvider: "fgj",
    };
  }
  return parseConfig({ servers });
}
