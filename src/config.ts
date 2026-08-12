import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  DashboardConfig,
  DashboardScope,
  ForgejoConfig,
  ForgejoServerConfig,
  NotificationLevel,
  PrivacyMode,
} from "./types.js";

const DEFAULT_DASHBOARD: DashboardConfig = {
  enabled: true,
  scope: "all",
  refreshSeconds: 90,
  previewLimit: 3,
  notifications: "important",
  privacy: "full",
};

interface RawServerConfig {
  baseUrl?: unknown;
  hostname?: unknown;
  credentialProvider?: unknown;
  tokenEnv?: unknown;
  fgjConfig?: unknown;
  remoteHosts?: unknown;
  token?: unknown;
}

interface RawConfig {
  servers?: unknown;
  dashboard?: unknown;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeBaseUrl(value: unknown, field: string): string {
  const raw = assertString(value, field);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${field} must be an absolute http(s) URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${field} must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${field} must not contain credentials, a query, or a fragment`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeHostname(value: unknown, field: string): string {
  const raw = assertString(value, field).toLowerCase();
  let url: URL;
  try {
    url = new URL(`https://${raw}`);
  } catch {
    throw new ConfigError(`${field} must be a host name with an optional port`);
  }
  if (url.host !== raw || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new ConfigError(`${field} must be a host name with an optional port`);
  }
  return raw;
}

function normalizeRemoteHosts(value: unknown, baseUrl: string, hostname: string, field: string): string[] {
  if (value !== undefined && (!Array.isArray(value) || value.some((host) => typeof host !== "string" || host.trim() === ""))) {
    throw new ConfigError(`${field} must be an array of non-empty host names`);
  }
  const configured = value === undefined ? [] : value.map((host) => (host as string).trim().toLowerCase());
  const base = new URL(baseUrl);
  return [...new Set([base.host.toLowerCase(), base.hostname.toLowerCase(), hostname, ...configured])];
}

function parseServer(alias: string, value: unknown): ForgejoServerConfig {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(alias)) {
    throw new ConfigError(`server alias '${alias}' must contain lowercase letters, numbers, or hyphens`);
  }
  if (!isObject(value)) {
    throw new ConfigError(`servers.${alias} must be an object`);
  }
  const raw = value as RawServerConfig;
  if (raw.token !== undefined) {
    throw new ConfigError(`servers.${alias}.token is forbidden; use an environment variable or fgj credential provider`);
  }
  const provider =
    raw.credentialProvider === undefined
      ? "env"
      : parseChoice(raw.credentialProvider, ["env", "fgj"] as const, `servers.${alias}.credentialProvider`, "env");
  const hostname =
    raw.hostname === undefined
      ? raw.baseUrl === undefined
        ? undefined
        : new URL(normalizeBaseUrl(raw.baseUrl, `servers.${alias}.baseUrl`)).host.toLowerCase()
      : normalizeHostname(raw.hostname, `servers.${alias}.hostname`);
  if (!hostname) throw new ConfigError(`servers.${alias} requires baseUrl or hostname`);
  const baseUrl =
    raw.baseUrl === undefined
      ? normalizeBaseUrl(`https://${hostname}`, `servers.${alias}.baseUrl`)
      : normalizeBaseUrl(raw.baseUrl, `servers.${alias}.baseUrl`);
  const server: ForgejoServerConfig = {
    baseUrl,
    hostname,
    credentialProvider: provider,
    remoteHosts: normalizeRemoteHosts(raw.remoteHosts, baseUrl, hostname, `servers.${alias}.remoteHosts`),
  };
  if (provider === "env") {
    const tokenEnv = assertString(raw.tokenEnv, `servers.${alias}.tokenEnv`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
      throw new ConfigError(`servers.${alias}.tokenEnv is not a valid environment variable name`);
    }
    server.tokenEnv = tokenEnv;
  } else {
    if (raw.tokenEnv !== undefined) {
      throw new ConfigError(`servers.${alias}.tokenEnv cannot be used with credentialProvider 'fgj'`);
    }
    if (raw.fgjConfig !== undefined) server.fgjConfig = assertString(raw.fgjConfig, `servers.${alias}.fgjConfig`);
  }
  return server;
}

function mergeObjects(base: unknown, override: unknown): Record<string, unknown> {
  return {
    ...(isObject(base) ? base : {}),
    ...(isObject(override) ? override : {}),
  };
}

function parseChoice<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ConfigError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseInteger(value: unknown, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ConfigError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function parseDashboard(globalValue: unknown, projectValue: unknown): DashboardConfig {
  const value = mergeObjects(globalValue, projectValue);
  const enabled = value.enabled ?? DEFAULT_DASHBOARD.enabled;
  if (typeof enabled !== "boolean") {
    throw new ConfigError("dashboard.enabled must be a boolean");
  }
  return {
    enabled,
    scope: parseChoice<DashboardScope>(value.scope, ["all", "current"], "dashboard.scope", DEFAULT_DASHBOARD.scope),
    refreshSeconds: parseInteger(value.refreshSeconds, "dashboard.refreshSeconds", DEFAULT_DASHBOARD.refreshSeconds, 30, 3600),
    previewLimit: parseInteger(value.previewLimit, "dashboard.previewLimit", DEFAULT_DASHBOARD.previewLimit, 1, 20),
    notifications: parseChoice<NotificationLevel>(
      value.notifications,
      ["off", "important", "all"],
      "dashboard.notifications",
      DEFAULT_DASHBOARD.notifications,
    ),
    privacy: parseChoice<PrivacyMode>(value.privacy, ["full", "counts-only"], "dashboard.privacy", DEFAULT_DASHBOARD.privacy),
  };
}

export function parseConfig(globalValue: unknown, projectValue: unknown = {}): ForgejoConfig {
  const globalConfig = isObject(globalValue) ? (globalValue as RawConfig) : {};
  const projectConfig = isObject(projectValue) ? (projectValue as RawConfig) : {};
  const serverValues = mergeObjects(globalConfig.servers, projectConfig.servers);
  const servers = Object.fromEntries(Object.entries(serverValues).map(([alias, value]) => [alias, parseServer(alias, value)]));
  if (Object.keys(servers).length === 0) {
    throw new ConfigError("no Forgejo servers configured");
  }
  return {
    servers,
    dashboard: parseDashboard(globalConfig.dashboard, projectConfig.dashboard),
  };
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new ConfigError(`invalid JSON in ${path}: ${error.message}`);
    throw error;
  }
}

export function configPaths(cwd: string, env: NodeJS.ProcessEnv = process.env): { global: string; project: string } {
  return {
    global: env.PI_FORGEJO_CONFIG ? resolve(env.PI_FORGEJO_CONFIG) : resolve(homedir(), ".pi", "agent", "forgejo.json"),
    project: resolve(cwd, ".pi", "forgejo.json"),
  };
}

export async function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<ForgejoConfig> {
  const paths = configPaths(cwd, env);
  const [globalValue, projectValue] = await Promise.all([readJsonIfPresent(paths.global), readJsonIfPresent(paths.project)]);
  if (globalValue === undefined && projectValue === undefined) {
    throw new ConfigError(`Forgejo config not found; create ${paths.global} or ${paths.project}`);
  }
  return parseConfig(globalValue ?? {}, projectValue ?? {});
}
