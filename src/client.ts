import {
	EnvironmentCredentialProvider,
	type CredentialProvider,
} from "./credentials.js";
import type {
  ApiResult,
  ForgejoCapabilities,
  ForgejoServerConfig,
  ForgejoUser,
  ServerAlias,
} from "./types.js";

export type QueryValue =
	| string
	| number
	| boolean
	| readonly (string | number | boolean)[]
	| undefined;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const USER_AGENT = "pi-forgejo-toolkit/0.5.2";

export function paginationComplete<T>(
	response: ApiResult<readonly T[]>,
	received: number,
): boolean {
	const link = response.headers.get("link");
	if (link !== null) return !/<[^>]+>;\s*rel="?next"?/i.test(link);
	if (response.totalCount !== undefined) return received >= response.totalCount;
	return response.data.length === 0;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
  byteRange?: { start: number; end: number };
	responseType?: "auto" | "bytes" | "stream";
  maxResponseBytes?: number;
	truncateResponse?: boolean;
	timeoutMs?: number;
}

export class ForgejoError extends Error {
  readonly server: string;
  readonly status?: number;
	readonly code:
		| "auth"
		| "forbidden"
		| "not-found"
		| "conflict"
		| "rate-limit"
		| "http"
		| "network"
		| "redirect";

  constructor(
    message: string,
    options: {
      server: string;
      status?: number;
      code: ForgejoError["code"];
      cause?: unknown;
    },
  ) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
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
	if (status === 409 || status === 412 || status === 422 || status === 423)
		return "conflict";
  if (status === 429) return "rate-limit";
  return "http";
}

function safeErrorText(value: string, token: string): string {
  const redacted = token ? value.split(token).join("[REDACTED]") : value;
  return redacted.replace(/\s+/g, " ").trim().slice(0, 500);
}

function appendQuery(
	url: URL,
	query: Record<string, QueryValue> | undefined,
): void {
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

function parseUrl(value: string | URL, base?: URL): URL {
	try {
		return new URL(value, base);
	} catch (cause) {
		throw new TypeError("Forgejo server URL is invalid", { cause });
	}
}

function isWithinPath(path: string, root: string): boolean {
	const normalizedRoot = root.replace(/\/+$/, "");
	return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

const ACTION_RUNS_PATH = "/repos/{owner}/{repo}/actions/runs";
const ACTION_DISPATCH_PATH =
	"/repos/{owner}/{repo}/actions/workflows/{workflowfilename}/dispatches";
const ACTION_CANCEL_PATH = "/repos/{owner}/{repo}/actions/runs/{run_id}/cancel";
const ACTION_RERUN_PATH = "/repos/{owner}/{repo}/actions/runs/{run_id}/rerun";
const ACTION_ARTIFACTS_PATH = "/repos/{owner}/{repo}/actions/artifacts";

function fallbackActionRunsAvailability(
	version: string,
): ForgejoCapabilities["features"]["actionsRuns"] {
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
	if (typeof paths !== "object" || paths === null || Array.isArray(paths))
		return undefined;
  return new Set(Object.keys(paths));
}

async function readBytes(
	response: Response,
	maximum: number,
	server: string,
	truncate = false,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!response.body) return { bytes: new Uint8Array(), truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let wasTruncated = false;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (total + chunk.value.byteLength > maximum) {
				if (!truncate) {
					await reader.cancel();
					throw new ForgejoError(
						`Forgejo ${server} response exceeds the ${maximum} byte limit`,
						{
							server,
							status: response.status,
							code: "http",
						},
					);
				}
				const remaining = maximum - total;
				if (remaining > 0) chunks.push(chunk.value.subarray(0, remaining));
				total = maximum;
				wasTruncated = true;
				await reader.cancel();
				break;
			}
			total += chunk.value.byteLength;
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated: wasTruncated };
}

function decodeUtf8(
	bytes: Uint8Array,
	truncated: boolean,
	maximum: number,
): string {
	const decoded = new TextDecoder().decode(bytes, { stream: truncated });
	if (Buffer.byteLength(decoded, "utf8") <= maximum) return decoded;
	const bounded: string[] = [];
	let used = 0;
	for (const character of decoded) {
		const size = Buffer.byteLength(character, "utf8");
		if (used + size > maximum) break;
		bounded.push(character);
		used += size;
	}
	return bounded.join("");
}

export class ForgejoClient {
  readonly alias: ServerAlias;
  readonly config: ForgejoServerConfig;
	private readonly baseUrl: URL;
  private readonly credentials: CredentialProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(
    alias: ServerAlias,
    config: ForgejoServerConfig,
		options: {
			environment?: NodeJS.ProcessEnv;
			fetchImpl?: typeof fetch;
			credentialProvider?: CredentialProvider;
		} = {},
  ) {
    this.alias = alias;
    this.config = config;
		this.baseUrl = parseUrl(config.baseUrl);
		if (options.credentialProvider)
			this.credentials = options.credentialProvider;
    else {
      if (config.credentialProvider !== "env" || !config.tokenEnv) {
				throw new Error(
					`Forgejo ${alias} requires an explicit ${config.credentialProvider} credential provider`,
				);
      }
			this.credentials = new EnvironmentCredentialProvider(
				alias,
				config.tokenEnv,
				options.environment ?? process.env,
			);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private serverUrl(path: string): URL {
		const base = parseUrl(this.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    base.pathname = `${basePath}/${path.replace(/^\/+/, "")}`;
    return base;
  }

	private async discoverSwaggerPaths(
		signal?: AbortSignal,
	): Promise<Set<string> | undefined> {
    const url = this.serverUrl("swagger.v1.json");
		const timeout = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const init: RequestInit = {
			headers: {
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
			redirect: "manual",
			signal: requestSignal,
    };
    try {
      const response = await this.fetchImpl(url, init);
			if (!response.ok || response.status >= 300) return undefined;
			const length = response.headers.get("content-length");
			if (
				length !== null &&
				/^\d+$/.test(length) &&
				Number(length) > 20_000_000
			)
				return undefined;
			const { bytes } = await readBytes(response, 20_000_000, this.alias);
			const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return swaggerPaths(document);
    } catch (error) {
      if (signal?.aborted) throw error;
      return undefined;
    }
  }

  private apiUrl(path: string, query?: Record<string, QueryValue>): URL {
		const base = parseUrl(this.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, "");
    const resourcePath = path.replace(/^\/+/, "");
    base.pathname = `${basePath}/api/v1/${resourcePath}`;
    appendQuery(base, query);
    return base;
  }

	async request<T>(
		path: string,
		options: RequestOptions = {},
	): Promise<ApiResult<T>> {
    const method = options.method ?? "GET";
    if (
      options.maxResponseBytes !== undefined &&
			(!Number.isSafeInteger(options.maxResponseBytes) ||
				options.maxResponseBytes < 0)
    ) {
			throw new TypeError(
				"maxResponseBytes must be a non-negative safe integer",
			);
    }
		if (
			options.timeoutMs !== undefined &&
			(!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
		) {
			throw new TypeError("timeoutMs must be a positive safe integer");
		}
		const timeout = AbortSignal.timeout(
			options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
		);
		const requestSignal = options.signal
			? AbortSignal.any([options.signal, timeout])
			: timeout;
		const token = await this.credentials.getToken(requestSignal);
    let url = this.apiUrl(path, options.query);
    let redirects = 0;

    while (true) {
      const headers = new Headers({
        Accept: options.accept ?? "application/json",
        Authorization: `token ${token}`,
				"User-Agent": USER_AGENT,
      });
			if (options.byteRange)
				headers.set(
					"Range",
					`bytes=${options.byteRange.start}-${options.byteRange.end}`,
				);
			let requestBody: string | undefined;
      if (options.body !== undefined) {
        headers.set("Content-Type", "application/json");
				requestBody = JSON.stringify(options.body);
      }
      const init: RequestInit = { method, headers, redirect: "manual" };
			if (requestBody !== undefined) init.body = requestBody;
			init.signal = requestSignal;

      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        if (error instanceof ForgejoError) throw error;
        if (options.signal?.aborted) throw error;
				const message = timeout.aborted
					? "timed out"
					: error instanceof Error
						? error.message
						: String(error);
				throw new ForgejoError(
					`Forgejo ${this.alias} request failed: ${message}`,
					{
          server: this.alias,
          code: "network",
          cause: error,
					},
				);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
					throw new ForgejoError(
						`Forgejo ${this.alias} returned a redirect without Location`,
						{
            server: this.alias,
            status: response.status,
            code: "redirect",
						},
					);
        }
				const next = parseUrl(location, url);
				const apiRoot = this.apiUrl("").pathname;
				if (
					next.origin !== url.origin ||
					!isWithinPath(next.pathname, apiRoot)
				) {
					throw new ForgejoError(
						`Forgejo ${this.alias} refused redirect outside its API root`,
						{
            server: this.alias,
            status: response.status,
            code: "redirect",
						},
					);
        }
        if (method !== "GET" || redirects >= 3) {
					throw new ForgejoError(
						`Forgejo ${this.alias} refused redirect for ${method} request`,
						{
            server: this.alias,
            status: response.status,
            code: "redirect",
						},
					);
        }
        redirects += 1;
        url = next;
        continue;
      }

			if (response.ok && options.responseType === "stream") {
        const maximum = options.maxResponseBytes;
        const rawLength = response.headers.get("content-length");
				if (
					maximum !== undefined &&
					rawLength !== null &&
					/^\d+$/.test(rawLength) &&
					Number(rawLength) > maximum
				) {
					await response.body?.cancel();
					throw new ForgejoError(
						`Forgejo ${this.alias} response exceeds the ${maximum} byte limit`,
						{
            server: this.alias,
            status: response.status,
            code: "http",
						},
					);
        }
				const stream =
					response.body ??
					new ReadableStream<Uint8Array>({
						start: (controller) => controller.close(),
                });
				return {
					data: stream as T,
					status: response.status,
					headers: response.headers,
				};
              }

			if (response.ok && options.responseType === "bytes") {
				const maximum = options.maxResponseBytes;
				const body =
					maximum === undefined
						? {
								bytes: new Uint8Array(await response.arrayBuffer()),
								truncated: false,
							}
						: await readBytes(
								response,
								maximum,
								this.alias,
								options.truncateResponse,
							);
				const result: ApiResult<T> = {
					data: body.bytes as T,
					status: response.status,
					headers: response.headers,
				};
        const rawTotal = response.headers.get("x-total-count");
				if (rawTotal !== null && /^\d+$/.test(rawTotal))
					result.totalCount = Number(rawTotal);
				if (body.truncated) result.truncated = true;
        return result;
      }

			const maximum =
				options.maxResponseBytes ?? (response.ok ? 20_000_000 : 64_000);
			const rawLength = response.headers.get("content-length");
			if (
				!options.truncateResponse &&
				rawLength !== null &&
				/^\d+$/.test(rawLength) &&
				Number(rawLength) > maximum
			) {
				throw new ForgejoError(
					`Forgejo ${this.alias} response exceeds the ${maximum} byte limit`,
					{
						server: this.alias,
						status: response.status,
						code: "http",
					},
				);
			}
			const body =
				response.status === 204
					? { bytes: new Uint8Array(), truncated: false }
					: await readBytes(
							response,
							maximum,
							this.alias,
							options.truncateResponse || !response.ok,
						);
			const raw = decodeUtf8(body.bytes, body.truncated, maximum);
      if (!response.ok) {
        const detail = safeErrorText(raw, token);
        const suffix = detail ? `: ${detail}` : "";
				throw new ForgejoError(
					`Forgejo ${this.alias} returned HTTP ${response.status}${suffix}`,
					{
          server: this.alias,
          status: response.status,
          code: errorCode(response.status),
					},
				);
      }

      let data: T;
      const contentType = response.headers.get("content-type") ?? "";
			if (!raw && body.bytes.byteLength === 0 && !body.truncated) {
        data = undefined as T;
			} else if (
				contentType.includes("json") ||
				(options.accept ?? "application/json").includes("json")
			) {
        try {
          data = JSON.parse(raw) as T;
        } catch (error) {
					throw new ForgejoError(
						`Forgejo ${this.alias} returned invalid JSON`,
						{
            server: this.alias,
            status: response.status,
            code: "http",
            cause: error,
						},
					);
        }
      } else {
        data = raw as T;
      }

      const rawTotal = response.headers.get("x-total-count");
			const result: ApiResult<T> = {
				data,
				status: response.status,
				headers: response.headers,
			};
			if (rawTotal !== null && /^\d+$/.test(rawTotal))
				result.totalCount = Number(rawTotal);
			if (body.truncated) result.truncated = true;
      return result;
    }
  }

	async discoverCapabilities(
		signal?: AbortSignal,
	): Promise<ForgejoCapabilities> {
    const requestOptions = signal === undefined ? {} : { signal };
		const [versionResult, userResult, settingsResult, paths] =
			await Promise.all([
      this.request<{ version?: string }>("version", requestOptions),
      this.request<ForgejoUser>("user", requestOptions),
				this.request<{
					default_paging_num?: number;
					max_response_items?: number;
				}>("settings/api", requestOptions),
      this.discoverSwaggerPaths(signal),
    ]);
    const paging: ForgejoCapabilities["paging"] = {};
		if (settingsResult.data.default_paging_num !== undefined)
			paging.defaultLimit = settingsResult.data.default_paging_num;
		if (settingsResult.data.max_response_items !== undefined)
			paging.maxLimit = settingsResult.data.max_response_items;
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
				actionsRuns: actionPathAvailability(
					paths,
					ACTION_RUNS_PATH,
					fallbackActionRunsAvailability(version),
				),
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
	return segments
		.map((segment) => encodeURIComponent(String(segment)))
		.join("/");
}
