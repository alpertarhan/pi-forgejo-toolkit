import { CapabilityRegistry } from "./capabilities.js";
import { ForgejoClient, ForgejoClientPool } from "./client.js";
import { configPaths, loadConfig } from "./config.js";
import { createCredentialProvider } from "./credentials.js";
import type { MutationApprovalKey } from "./mutation-approvals.js";
import { DashboardStore } from "./dashboard/store.js";
import { parseResourceRef } from "./refs.js";
import { resolveRepository } from "./remote-resolver.js";
import type { CommandExecutor } from "./process.js";
import type {
  ForgejoConfig,
  RepoRef,
  RepoResolution,
  ResourceRef,
  ReviewDraft,
} from "./types.js";

export interface RepoInput {
  ref?: string;
  server?: string;
  owner?: string;
  repo?: string;
}

export interface ResourceInput extends RepoInput {
  index?: number;
}

export interface ConversationCursor {
  reference: string;
  fetchedThrough: string;
  eventVersions: Map<number, string>;
  lastUpdatedAt: string;
  lastState: string;
  lastTitle: string;
  lastHeadSha?: string;
}

export class ForgejoRuntime {
  readonly drafts = new Map<string, ReviewDraft>();
  readonly sessionMutationApprovals = new Set<MutationApprovalKey>();
  private readonly conversationCursors = new Map<string, ConversationCursor>();
  private selectedRepo: RepoRef | undefined;
  private selectedServer: string | undefined;

  constructor(
    readonly cwd: string,
    readonly config: ForgejoConfig,
    readonly clients: ForgejoClientPool,
    readonly capabilities: CapabilityRegistry,
    readonly dashboard: DashboardStore,
    readonly repoResolution: RepoResolution,
    readonly globalConfigPath: string = configPaths(cwd, process.env).global,
  ) {
    if (repoResolution.status === "resolved") {
      this.selectedRepo = repoResolution.repo;
      this.selectedServer = repoResolution.repo.server;
    }
  }

  currentRepo(): RepoRef | undefined {
    return this.selectedRepo;
  }

  currentServer(): string | undefined {
    if (this.selectedServer) return this.selectedServer;
    const aliases = this.clients.aliases();
    return aliases.length === 1 ? aliases[0] : undefined;
  }

  selectServer(alias: string): RepoRef | undefined {
    this.clients.get(alias);
    this.selectedServer = alias;
    let repo: RepoRef | undefined;
    if (
      this.repoResolution.status === "resolved" &&
      this.repoResolution.repo.server === alias
    ) {
      repo = this.repoResolution.repo;
    } else if (this.repoResolution.status === "ambiguous") {
      const matches = this.repoResolution.matches.filter(
        (match) => match.server === alias,
      );
      if (matches.length === 1) {
        const match = matches[0];
        if (match)
          repo = { server: match.server, owner: match.owner, repo: match.repo };
      }
    }
    this.selectedRepo = repo;
    this.dashboard.setActiveRepo(repo);
    return repo;
  }

  resolveRepo(input: RepoInput): RepoRef {
    const explicit = [input.server, input.owner, input.repo].filter(
      (value) => value !== undefined,
    );
    if (input.ref && explicit.length > 0) {
      throw new Error("ref cannot be combined with server, owner, or repo");
    }
    if (input.ref) {
      const resource = parseResourceRef(input.ref);
      if (!resource)
        throw new Error(`invalid Forgejo reference '${input.ref}'`);
      this.clients.get(resource.server);
      return {
        server: resource.server,
        owner: resource.owner,
        repo: resource.repo,
      };
    }
    if (explicit.length > 0 && explicit.length < 3) {
      throw new Error("server, owner, and repo must be supplied together");
    }
    if (input.server && input.owner && input.repo) {
      this.clients.get(input.server);
      return { server: input.server, owner: input.owner, repo: input.repo };
    }
    if (this.selectedRepo) return this.selectedRepo;
    throw new Error(
      this.repoResolution.status === "ambiguous"
        ? this.repoResolution.reason
        : "no active Forgejo repository; provide server, owner, and repo",
    );
  }

  resolveResource(input: ResourceInput, kind: "issue" | "pull"): ResourceRef {
    if (
      input.ref &&
      [input.server, input.owner, input.repo, input.index].some(
        (value) => value !== undefined,
      )
    ) {
      throw new Error(
        "ref cannot be combined with server, owner, repo, or index",
      );
    }
    if (input.ref) {
      const resource = parseResourceRef(input.ref);
      if (!resource)
        throw new Error(`invalid Forgejo reference '${input.ref}'`);
      if (resource.kind !== kind)
        throw new Error(`reference '${input.ref}' is not a ${kind}`);
      this.clients.get(resource.server);
      return resource;
    }
    if (!Number.isInteger(input.index) || (input.index ?? 0) < 1) {
      throw new Error(`${kind} index must be a positive integer`);
    }
    return { ...this.resolveRepo(input), kind, index: input.index as number };
  }

  client(alias: string): ForgejoClient {
    return this.clients.get(alias);
  }

  draftKey(ref: ResourceRef): string {
    return `${ref.server}:${ref.owner}/${ref.repo}!${ref.index}`;
  }

  conversationCursor(ref: ResourceRef): ConversationCursor | undefined {
    return this.conversationCursors.get(this.conversationKey(ref));
  }

  saveConversationCursor(ref: ResourceRef, cursor: ConversationCursor): void {
    this.conversationCursors.set(this.conversationKey(ref), cursor);
  }

  private conversationKey(ref: ResourceRef): string {
    return `${ref.server}:${ref.owner}/${ref.repo}${ref.kind === "pull" ? "!" : "#"}${ref.index}`;
  }

  close(): void {
    this.dashboard.close();
    this.clients.clearCredentials();
    this.drafts.clear();
    this.conversationCursors.clear();
  }
}

export async function createRuntime(
  cwd: string,
  exec: CommandExecutor,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  projectTrusted = false,
): Promise<ForgejoRuntime> {
  const config = await loadConfig(cwd, environment, { projectTrusted });
  const clients = new ForgejoClientPool(
    Object.fromEntries(
      Object.entries(config.servers).map(([alias, server]) => {
        const credentialProvider = createCredentialProvider(
          alias,
          server,
          cwd,
          exec,
          environment,
        );
        return [
          alias,
          new ForgejoClient(alias, server, { credentialProvider, fetchImpl }),
        ];
      }),
    ),
  );
  const capabilities = new CapabilityRegistry(clients);
  const resolution: RepoResolution = projectTrusted
    ? await resolveRepository(exec, cwd, config)
    : {
        status: "none",
        reason:
          "project-local Forgejo discovery is disabled until the project is trusted",
      };
  const activeRepo =
    resolution.status === "resolved" ? resolution.repo : undefined;
  const dashboard = new DashboardStore(
    clients,
    config.dashboard.previewLimit,
    activeRepo,
    (alias) => capabilities.get(alias)?.user,
    (alias) => capabilities.get(alias)?.features.actionsRuns ?? "unknown",
  );
  return new ForgejoRuntime(
    cwd,
    config,
    clients,
    capabilities,
    dashboard,
    resolution,
    configPaths(cwd, environment).global,
  );
}
