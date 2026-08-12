import { EnvironmentCredentialProvider, type CredentialProvider } from "./credentials.js";
import type {
  ApiResult,
  ForgejoCapabilities,
  ForgejoServerConfig,
  ForgejoUser,
  ServerAlias,
} from "./types.js";

export type QueryValue = string | number | boolean | readonly (string | number | boolean)[] | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
  byteRange?: { start: number; end: number };
  responseType?: "auto" | "bytes";
  maxResponseBytes?: number;
}

export class ForgejoError extends Error {
  readonly server: string;
  readonly status?: number;
  readonly code: "auth" | "forbidden" | "not-found" | "conflict" | "rate-limit" | "http" | "network" | "redirect";

  constructor(
    message: string,
    options: {
      server: string;
      status?: number;
      code: ForgejoError["code"];
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ForgejoError";
    this.server = options.server;
    if (options.status !== undefined) this.status = options.status;
    this.code = options.code;
  }
}

function errorCode(status: number): ForgejoError["code"] {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409 || status === 412 || status === 422 || status === 423) return "conflict";
  if (status === 429) return "rate-limit";
  return "http";
}

function safeErrorText(value: string, token: string): string {
  const redacted = token ? value.split(token).join("[REDACTED]") : value;
  return redacted.replace(/\s+/g, " ").trim().slice(0, 500);
}

function appendQuery(url: URL, query: Record<string, QueryValue> | undefined): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

const ACTION_RUNS_PATH = "/repos/{owner}/{repo}/actions/runs";
const ACTION_DISPATCH_PATH = "/repos/{owner}/{repo}/actions/workflows/{workflowfilename}/dispatches";
const ACTION_CANCEL_PATH = "/repos/{owner}/{repo}/actions/runs/{run_id}/cancel";
const ACTION_RERUN_PATH = "/repos/{owner}/{repo}/actions/runs/{run_id}/rerun";
const ACTION_ARTIFACTS_PATH = "/repos/{owner}/{repo}/actions/artifacts";

function fallbackActionRunsAvailability(version: string): ForgejoCapabilities["features"]["actionsRuns"] {
  const match = /^v?(\d+)\./.exec(version);
  if (!match?.[1]) return "unknown";
  return Number(match[1]) >= 12 ? "available" : "unavailable";
}

function actionPathAvailability(
  paths: ReadonlySet<string> | undefined,
  path: string,
  fallback: ForgejoCapabilities["features"]["actionsRuns"] = "unknown",
): ForgejoCapabilities["features"]["actionsRuns"] {
  if (!paths) return fallback;
  return paths.has(path) ? "available" : "unavailable";
}

function swaggerPaths(value: unknown): Set<string> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const document = value as Record<string, unknown>;
  const paths = document.paths;
  if (typeof paths !== "object" || paths === null || Array.isArray(paths)) return undefined;
  return new Set(Object.keys(paths));
}

export class ForgejoClient {
  readonly alias: ServerAlias;
  readonly config: ForgejoServerConfig;
  private readonly credentials: CredentialProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(
    alias: ServerAlias,
    config: ForgejoServerConfig,
    options: { environment?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; credentialProvider?: CredentialProvider } = {},
  ) {
    this.alias = alias;
    this.config = config;
    if (options.credentialProvider) this.credentials = options.credentialProvider;
    else {
      if (config.credentialProvider !== "env" || !config.tokenEnv) {
        throw new Error(`Forgejo ${alias} requires an explicit ${config.credentialProvider} credential provider`);
      }
      this.credentials = new EnvironmentCredentialProvider(alias, config.tokenEnv, options.environment ?? process.env);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }


  private serverUrl(path: string): URL {
    const base = new URL(this.config.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    base.pathname = `${basePath}/${path.replace(/^\/+/, "")}`;
    return base;
  }

  private async discoverSwaggerPaths(signal?: AbortSignal): Promise<Set<string> | undefined> {
    const url = this.serverUrl("swagger.v1.json");
    const init: RequestInit = {
      headers: { Accept: "application/json", "User-Agent": "pi-forgejo-toolkit/0.1" },
      redirect: "follow",
    };
    if (signal !== undefined) init.signal = signal;
    try {
      const response = await this.fetchImpl(url, init);
      if (!response.ok || (response.url && new URL(response.url).origin !== url.origin)) return undefined;
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 20_000_000) return undefined;
      const document: unknown = JSON.parse(raw);
      return swaggerPaths(document);
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  private apiUrl(path: string, query?: Record<string, QueryValue>): URL {
    const base = new URL(this.config.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    const resourcePath = path.replace(/^\/+/, "");
    base.pathname = `${basePath}/api/v1/${resourcePath}`;
    appendQuery(base, query);
    return base;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    const method = options.method ?? "GET";
    if (
      options.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 0)
    ) {
      throw new TypeError("maxResponseBytes must be a non-negative safe integer");
    }
    const token = await this.credentials.getToken(options.signal);
    let url = this.apiUrl(path, options.query);
    let redirects = 0;

    while (true) {
      const headers = new Headers({
        Accept: options.accept ?? "application/json",
        Authorization: `token ${token}`,
        "User-Agent": "pi-forgejo-toolkit/0.1",
      });
      if (options.byteRange) headers.set("Range", `bytes=${options.byteRange.start}-${options.byteRange.end}`);
      let body: string | undefined;
      if (options.body !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(options.body);
      }
      const init: RequestInit = { method, headers, redirect: "manual" };
      if (body !== undefined) init.body = body;
      if (options.signal !== undefined) init.signal = options.signal;

      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        if (error instanceof ForgejoError) throw error;
        if (options.signal?.aborted) throw error;
        throw new ForgejoError(`Forgejo ${this.alias} request failed: ${error instanceof Error ? error.message : String(error)}`, {
          server: this.alias,
          code: "network",
          cause: error,
        });
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new ForgejoError(`Forgejo ${this.alias} returned a redirect without Location`, {
            server: this.alias,
            status: response.status,
            code: "redirect",
          });
        }
        const next = new URL(location, url);
        if (next.origin !== url.origin) {
          throw new ForgejoError(`Forgejo ${this.alias} refused cross-origin redirect to ${next.origin}`, {
            server: this.alias,
            status: response.status,
            code: "redirect",
          });
        }
        if (method !== "GET" || redirects >= 3) {
          throw new ForgejoError(`Forgejo ${this.alias} refused redirect for ${method} request`, {
            server: this.alias,
            status: response.status,
            code: "redirect",
          });
        }
        redirects += 1;
        url = next;
        continue;
      }

      if (response.ok && options.responseType === "bytes") {
        const maximum = options.maxResponseBytes;
        const rawLength = response.headers.get("content-length");
        if (maximum !== undefined && rawLength !== null && /^\d+$/.test(rawLength) && Number(rawLength) > maximum) {
          throw new ForgejoError(`Forgejo ${this.alias} response exceeds the ${maximum} byte limit`, {
            server: this.alias,
            status: response.status,
            code: "http",
          });
        }
        let bytes: Uint8Array;
        if (maximum === undefined) {
          bytes = new Uint8Array(await response.arrayBuffer());
        } else if (!response.body) {
          bytes = new Uint8Array();
        } else {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              total += chunk.value.byteLength;
              if (total > maximum) {
                await reader.cancel();
                throw new ForgejoError(`Forgejo ${this.alias} response exceeds the ${maximum} byte limit`, {
                  server: this.alias,
                  status: response.status,
                  code: "http",
                });
              }
              chunks.push(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
          bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
        }
        const data = bytes as T;
        const rawTotal = response.headers.get("x-total-count");
        const result: ApiResult<T> = { data, status: response.status, headers: response.headers };
        if (rawTotal !== null && /^\d+$/.test(rawTotal)) result.totalCount = Number(rawTotal);
        return result;
      }

      const raw = response.status === 204 ? "" : await response.text();
      if (!response.ok) {
        const detail = safeErrorText(raw, token);
        const suffix = detail ? `: ${detail}` : "";
        throw new ForgejoError(`Forgejo ${this.alias} returned HTTP ${response.status}${suffix}`, {
          server: this.alias,
          status: response.status,
          code: errorCode(response.status),
        });
      }

      let data: T;
      const contentType = response.headers.get("content-type") ?? "";
      if (!raw) {
        data = undefined as T;
      } else if (contentType.includes("json") || (options.accept ?? "").includes("json")) {
        try {
          data = JSON.parse(raw) as T;
        } catch (error) {
          throw new ForgejoError(`Forgejo ${this.alias} returned invalid JSON`, {
            server: this.alias,
            status: response.status,
            code: "http",
            cause: error,
          });
        }
      } else {
        data = raw as T;
      }

      const rawTotal = response.headers.get("x-total-count");
      const result: ApiResult<T> = { data, status: response.status, headers: response.headers };
      if (rawTotal !== null && /^\d+$/.test(rawTotal)) result.totalCount = Number(rawTotal);
      return result;
    }
  }

  async discoverCapabilities(signal?: AbortSignal): Promise<ForgejoCapabilities> {
    const requestOptions = signal === undefined ? {} : { signal };
    const [versionResult, userResult, settingsResult, paths] = await Promise.all([
      this.request<{ version?: string }>("version", requestOptions),
      this.request<ForgejoUser>("user", requestOptions),
      this.request<{ default_paging_num?: number; max_response_items?: number }>("settings/api", requestOptions),
      this.discoverSwaggerPaths(signal),
    ]);
    const paging: ForgejoCapabilities["paging"] = {};
    if (settingsResult.data.default_paging_num !== undefined) paging.defaultLimit = settingsResult.data.default_paging_num;
    if (settingsResult.data.max_response_items !== undefined) paging.maxLimit = settingsResult.data.max_response_items;
    const version = versionResult.data.version ?? "unknown";
    return {
      server: this.alias,
      version,
      user: userResult.data,
      paging,
      features: {
        dashboardSearch: true,
        notifications: true,
        reviews: true,
        actionsRuns: actionPathAvailability(paths, ACTION_RUNS_PATH, fallbackActionRunsAvailability(version)),
        actionsDispatch: actionPathAvailability(paths, ACTION_DISPATCH_PATH),
        actionsCancel: actionPathAvailability(paths, ACTION_CANCEL_PATH),
        actionsRerun: actionPathAvailability(paths, ACTION_RERUN_PATH),
        actionsArtifacts: actionPathAvailability(paths, ACTION_ARTIFACTS_PATH),
      },
    };
  }

  clearCredential(): void {
    this.credentials.clear();
  }
}

export class ForgejoClientPool {
  private readonly clients: Record<string, ForgejoClient>;

  constructor(clients: Record<string, ForgejoClient>) {
    this.clients = clients;
  }

  aliases(): string[] {
    return Object.keys(this.clients);
  }

  get(alias: string): ForgejoClient {
    const client = this.clients[alias];
    if (!client) throw new Error(`unknown Forgejo server '${alias}'`);
    return client;
  }

  entries(): Array<[string, ForgejoClient]> {
    return Object.entries(this.clients);
  }

  clearCredentials(): void {
    for (const client of Object.values(this.clients)) client.clearCredential();
  }
}

export function apiPath(...segments: Array<string | number>): string {
  return segments.map((segment) => encodeURIComponent(String(segment))).join("/");
}
