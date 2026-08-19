import { waitWithSignal } from "./abort.js";
import type { ForgejoServerConfig } from "./types.js";
import type { CommandExecutor } from "./process.js";

export interface CredentialProvider {
  readonly kind: "env" | "fgj";
  getToken(signal?: AbortSignal): Promise<string>;
  clear(): void;
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export class EnvironmentCredentialProvider implements CredentialProvider {
  readonly kind = "env" as const;

  constructor(
    private readonly server: string,
    private readonly variable: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  async getToken(): Promise<string> {
    const token = this.environment[this.variable];
    if (!token)
      throw new CredentialError(
        `Forgejo ${this.server} API token environment variable ${this.variable} is not set`,
      );
    if (/\s/.test(token)) {
      throw new CredentialError(
        `Forgejo ${this.server} API token environment variable ${this.variable} is invalid`,
      );
    }
    return token;
  }

  clear(): void {}
}

export class FgjCredentialProvider implements CredentialProvider {
  readonly kind = "fgj" as const;
  private cachedToken: string | undefined;
  private pending: Promise<string> | undefined;
  private controller: AbortController | undefined;
  private generation = 0;

  constructor(
    private readonly server: string,
    private readonly hostname: string,
    private readonly cwd: string,
    private readonly exec: CommandExecutor,
    private readonly configPath?: string,
  ) {}

  getToken(signal?: AbortSignal): Promise<string> {
    if (this.cachedToken) {
      signal?.throwIfAborted();
      return Promise.resolve(this.cachedToken);
    }
    if (!this.pending) {
      const args = this.configPath
        ? [
            "--config",
            this.configPath,
            "auth",
            "token",
            "--hostname",
            this.hostname,
          ]
        : ["auth", "token", "--hostname", this.hostname];
      const generation = this.generation;
      const controller = new AbortController();
      this.controller = controller;
      let request: Promise<string>;
      request = this.exec("fgj", args, {
        cwd: this.cwd,
        timeout: 10_000,
        signal: controller.signal,
      })
        .then((result) => {
          if (result.code !== 0) {
            const detail = result.stderr
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 300);
            throw new CredentialError(
              `fgj authentication failed for ${this.server} (${this.hostname})${detail ? `: ${detail}` : ""}`,
            );
          }
          const token = result.stdout.trim();
          if (!token || /\s/.test(token)) {
            throw new CredentialError(
              `fgj returned an invalid token for ${this.server} (${this.hostname})`,
            );
          }
          if (generation !== this.generation || controller.signal.aborted) {
            throw new CredentialError(
              `fgj credential request was cancelled for ${this.server}`,
            );
          }
          this.cachedToken = token;
          return token;
        })
        .finally(() => {
          if (this.pending === request) this.pending = undefined;
          if (this.controller === controller) this.controller = undefined;
        });
      this.pending = request;
    }
    return waitWithSignal(this.pending, signal);
  }

  clear(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
    this.cachedToken = undefined;
    this.pending = undefined;
  }
}

export function createCredentialProvider(
  alias: string,
  config: ForgejoServerConfig,
  cwd: string,
  exec: CommandExecutor,
  environment: NodeJS.ProcessEnv = process.env,
): CredentialProvider {
  if (config.credentialProvider === "fgj") {
    return new FgjCredentialProvider(
      alias,
      config.hostname,
      cwd,
      exec,
      config.fgjConfig,
    );
  }
  if (!config.tokenEnv)
    throw new CredentialError(
      `Forgejo ${alias} environment credential provider is missing tokenEnv`,
    );
  return new EnvironmentCredentialProvider(alias, config.tokenEnv, environment);
}
