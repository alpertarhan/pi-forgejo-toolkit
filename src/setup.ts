import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { configPaths, parseConfig } from "./config.js";
import { discoverFgjInstances, suggestServerAlias } from "./fgj.js";
import type { CommandExecutor } from "./process.js";
import type { DashboardConfig, ForgejoConfig, ForgejoServerConfig } from "./types.js";

export type SetupScope = "global" | "project";
export type SetupStage = "scope" | "servers" | "dashboard" | "review";

type SetupUI = Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;

export interface ForgejoSetupOptions {
  args: string;
  cwd: string;
  ui: SetupUI;
  exec: CommandExecutor;
  environment?: NodeJS.ProcessEnv;
  onStage?: (stage: SetupStage, step: number, total: number) => void;
}

export interface ForgejoSetupResult {
  scope: SetupScope;
  target: string;
  config: ForgejoConfig;
}

interface SetupDraft {
  servers: Record<string, ForgejoServerConfig>;
  dashboard: DashboardConfig;
}

interface PreparedDraft {
  draft: SetupDraft;
  keptExisting: boolean;
}

const SCOPE_GLOBAL = "Global — use this configuration in every project";
const SCOPE_PROJECT = "Project — use this configuration only in the current project";
const UPDATE_EXISTING = "Update existing configuration — keep current servers and dashboard settings";
const REPLACE_EXISTING = "Replace existing configuration — start from a clean setup";
const DISCOVER_FGJ = "Discover servers already signed in with fgj";
const ADD_ENV = "Add a server using an API token environment variable";
const EDIT_SERVER = "Reconfigure an existing server";
const REMOVE_SERVER = "Remove a configured server";
const CONTINUE_SERVERS = "Continue to dashboard preferences";
const WRITE_CONFIG = "Write configuration and reload Pi";
const CHANGE_DASHBOARD = "Change dashboard preferences";
const CHANGE_SERVERS = "Change configured servers";
const CANCEL_SETUP = "Cancel setup";

const PLACEHOLDER_SERVER = {
  hostname: "setup.invalid",
  credentialProvider: "fgj",
} as const;

const DEFAULT_DASHBOARD = parseConfig({ servers: { setup: PLACEHOLDER_SERVER } }).dashboard;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function emptyDraft(): SetupDraft {
  return { servers: {}, dashboard: { ...DEFAULT_DASHBOARD } };
}

function parseExistingDraft(text: string, target: string): SetupDraft {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${target}: ${errorMessage(error)}`);
  }
  if (!isObject(value)) throw new Error(`${target} must contain a JSON object`);
  if (value.servers !== undefined && !isObject(value.servers)) throw new Error(`${target} field 'servers' must be an object`);
  const rawServers = isObject(value.servers) ? value.servers : {};
  const aliases = Object.keys(rawServers);
  const parsed = parseConfig({
    servers: aliases.length > 0 ? rawServers : { setup: PLACEHOLDER_SERVER },
    dashboard: value.dashboard,
  });
  return {
    servers: aliases.length > 0 ? { ...parsed.servers } : {},
    dashboard: { ...parsed.dashboard },
  };
}

async function selectScope(args: string, ui: SetupUI): Promise<SetupScope | undefined> {
  const requested = args.trim().toLowerCase();
  if (requested === "global" || requested === "project") return requested;
  if (requested) throw new Error("usage: /fj-setup [global|project]");
  const choice = await ui.select(
    "Forgejo setup · 1/4 · Configuration scope\nChoose where Pi should load these Forgejo settings.",
    [SCOPE_GLOBAL, SCOPE_PROJECT],
  );
  if (choice === SCOPE_GLOBAL) return "global";
  if (choice === SCOPE_PROJECT) return "project";
  return undefined;
}

async function prepareDraft(ui: SetupUI, target: string, originalText: string | undefined): Promise<PreparedDraft | undefined> {
  if (originalText === undefined) return { draft: emptyDraft(), keptExisting: false };

  let existing: SetupDraft | undefined;
  let invalidReason: string | undefined;
  try {
    existing = parseExistingDraft(originalText, target);
  } catch (error) {
    invalidReason = errorMessage(error);
  }

  if (existing) {
    const choice = await ui.select(
      `Forgejo setup · Existing configuration\n${target}\n\nChoose how this wizard should handle it.`,
      [UPDATE_EXISTING, REPLACE_EXISTING, CANCEL_SETUP],
    );
    if (choice === UPDATE_EXISTING) return { draft: existing, keptExisting: true };
    if (choice !== REPLACE_EXISTING) return undefined;
  } else {
    const choice = await ui.select(
      `Forgejo setup · Existing configuration needs attention\n${invalidReason ?? "The file cannot be read as Forgejo configuration."}`,
      ["Replace the invalid configuration", CANCEL_SETUP],
    );
    if (choice !== "Replace the invalid configuration") return undefined;
  }

  const confirmed = await ui.confirm(
    "Replace Forgejo configuration?",
    `This will replace the contents of:\n${target}\n\nNo API token value will be written.`,
  );
  return confirmed ? { draft: emptyDraft(), keptExisting: false } : undefined;
}

function normalizeServer(alias: string, value: Record<string, unknown>): ForgejoServerConfig {
  const server = parseConfig({ servers: { [alias]: value } }).servers[alias];
  if (!server) throw new Error(`failed to normalize Forgejo server '${alias}'`);
  return server;
}

function aliasValidation(alias: string, servers: Record<string, ForgejoServerConfig>, editing?: string): string | undefined {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(alias)) {
    return "Alias must contain lowercase letters, numbers, or hyphens and cannot begin or end with a hyphen.";
  }
  if (alias !== editing && servers[alias]) return `Alias '${alias}' is already configured. Choose another alias.`;
  return undefined;
}

async function promptValue(
  ui: SetupUI,
  title: string,
  placeholder: string,
  defaultValue: string | undefined,
  validate: (value: string) => string | undefined,
): Promise<string | undefined> {
  for (;;) {
    const response = await ui.input(title, placeholder);
    if (response === undefined) return undefined;
    const value = response.trim() || defaultValue || "";
    if (!value) {
      ui.notify("A value is required. Press Esc to go back.", "warning");
      continue;
    }
    const problem = validate(value);
    if (!problem) return value;
    ui.notify(problem, "warning");
  }
}

function uniqueSuggestedAlias(hostname: string, servers: Record<string, ForgejoServerConfig>): string {
  const base = suggestServerAlias(hostname);
  let alias = base;
  let suffix = 2;
  while (servers[alias]) {
    alias = `${base}-${suffix}`;
    suffix += 1;
  }
  return alias;
}

async function promptAlias(
  ui: SetupUI,
  hostname: string,
  servers: Record<string, ForgejoServerConfig>,
  editing?: string,
): Promise<string | undefined> {
  const fallback = editing ?? uniqueSuggestedAlias(hostname, servers);
  return promptValue(
    ui,
    `Forgejo setup · Server alias\nUsed in references such as ${fallback}:owner/repo#123. Press Enter to use '${fallback}'.`,
    fallback,
    fallback,
    (value) => aliasValidation(value, servers, editing),
  );
}

function automaticRemoteHosts(server: ForgejoServerConfig): Set<string> {
  const url = new URL(server.baseUrl);
  return new Set([url.host.toLowerCase(), url.hostname.toLowerCase(), server.hostname.toLowerCase()]);
}

function extraRemoteHosts(server: ForgejoServerConfig): string[] {
  const automatic = automaticRemoteHosts(server);
  return server.remoteHosts.filter((host) => !automatic.has(host.toLowerCase()));
}

async function promptRemoteHosts(ui: SetupUI, server: ForgejoServerConfig): Promise<string[] | undefined> {
  const current = extraRemoteHosts(server);
  const keep = current.length > 0 ? `Keep current SSH aliases — ${current.join(", ")}` : undefined;
  const detected = "Use the detected server hostname only — recommended";
  const custom = "Add or replace SSH host aliases used by Git remotes";
  const options = [...(keep ? [keep] : []), detected, custom, "Back"];
  const choice = await ui.select(
    `Forgejo setup · Git remote matching\nPi already recognizes ${server.hostname}. Add aliases only when Git remotes use names such as 'forgejo-work'.`,
    options,
  );
  if (keep && choice === keep) return current;
  if (choice === detected) return [];
  if (choice !== custom) return undefined;
  const response = await ui.input(
    "Forgejo setup · SSH host aliases\nEnter comma-separated aliases. Leave empty to use only the detected hostname.",
    current.join(", ") || "forgejo-work, work-git",
  );
  if (response === undefined) return undefined;
  return [...new Set(response.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

async function chooseFgjConfig(ui: SetupUI, current?: string): Promise<string | null | undefined> {
  const keep = current ? `Keep current custom fgj config — ${current}` : undefined;
  const useDefault = "Use the default fgj configuration";
  const useCustom = current ? "Choose a different fgj configuration file" : "Use a custom fgj configuration file";
  const choice = await ui.select(
    "Forgejo setup · fgj credential store\nThe wizard only reads fgj auth status; it never requests or writes token values.",
    [...(keep ? [keep] : []), useDefault, useCustom, "Back"],
  );
  if (keep && choice === keep) return current;
  if (choice === useDefault) return null;
  if (choice !== useCustom) return undefined;
  const path = await promptValue(
    ui,
    "Forgejo setup · fgj config path",
    "/absolute/path/to/fgj/config.yaml",
    undefined,
    () => undefined,
  );
  return path;
}

async function discoverServers(
  ui: SetupUI,
  exec: CommandExecutor,
  cwd: string,
  servers: Record<string, ForgejoServerConfig>,
): Promise<void> {
  const configPath = await chooseFgjConfig(ui);
  if (configPath === undefined) return;

  let instances;
  try {
    instances = await discoverFgjInstances(exec, cwd, configPath ?? undefined);
  } catch (error) {
    ui.notify(`${errorMessage(error)}. Sign in with 'fgj auth login' or choose the API-token option.`, "warning");
    return;
  }

  let added = 0;
  for (const instance of instances) {
    const existing = Object.entries(servers).find(([, server]) => server.hostname === instance.hostname);
    if (existing) {
      const [alias, server] = existing;
      const replace = `Use discovered fgj credentials for '${alias}'`;
      const choice = await ui.select(
        `Forgejo setup · Discovered ${instance.hostname}\nSigned in as ${instance.user}. This host is already configured with '${server.credentialProvider}'.`,
        [`Keep existing '${alias}'`, replace, "Stop discovery"],
      );
      if (choice === "Stop discovery" || choice === undefined) break;
      if (choice !== replace) continue;
      const customHosts = extraRemoteHosts(server);
      const raw: Record<string, unknown> = {
        baseUrl: server.baseUrl,
        hostname: instance.hostname,
        credentialProvider: "fgj",
        remoteHosts: customHosts,
      };
      if (configPath) raw.fgjConfig = configPath;
      servers[alias] = normalizeServer(alias, raw);
      added += 1;
      continue;
    }

    const add = "Add this Forgejo server";
    const choice = await ui.select(
      `Forgejo setup · Discovered ${instance.hostname}\nSigned in as ${instance.user}. Add this instance to Pi?`,
      [add, "Skip this server", "Stop discovery"],
    );
    if (choice === "Stop discovery" || choice === undefined) break;
    if (choice !== add) continue;

    const alias = await promptAlias(ui, instance.hostname, servers);
    if (!alias) continue;
    const initialRaw: Record<string, unknown> = { hostname: instance.hostname, credentialProvider: "fgj" };
    if (configPath) initialRaw.fgjConfig = configPath;
    const initial = normalizeServer(alias, initialRaw);
    const remoteHosts = await promptRemoteHosts(ui, initial);
    if (remoteHosts === undefined) continue;
    servers[alias] = normalizeServer(alias, { ...initialRaw, remoteHosts });
    added += 1;
  }
  ui.notify(
    added > 0 ? `Added or updated ${added} fgj-backed Forgejo server${added === 1 ? "" : "s"}.` : "No discovered servers were added.",
    added > 0 ? "info" : "warning",
  );
}

function validateBaseUrl(value: string): string | undefined {
  try {
    normalizeServer("setup", {
      baseUrl: value,
      credentialProvider: "env",
      tokenEnv: "FORGEJO_SETUP_TOKEN",
    });
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function validateTokenEnv(value: string): string | undefined {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    ? undefined
    : "Environment variable must begin with a letter or underscore and contain only letters, numbers, or underscores.";
}

async function acceptMissingTokenVariable(ui: SetupUI, variable: string): Promise<"keep" | "change" | "back"> {
  const keep = `Keep '${variable}' — I will export it before restarting Pi`;
  const change = "Choose a different environment variable";
  const choice = await ui.select(
    `Forgejo setup · Token variable is not set\n${variable} is not available in this Pi process. The token itself will never be saved in JSON.`,
    [keep, change, "Back"],
  );
  if (choice === keep) return "keep";
  if (choice === change) return "change";
  return "back";
}

async function promptTokenEnv(
  ui: SetupUI,
  alias: string,
  environment: NodeJS.ProcessEnv,
  current?: string,
): Promise<string | undefined> {
  const fallback = current ?? `FORGEJO_${alias.toUpperCase().replace(/-/g, "_")}_TOKEN`;
  for (;;) {
    const variable = await promptValue(
      ui,
      `Forgejo setup · API token environment variable\nPress Enter to use '${fallback}'. Only this variable name is written to JSON.`,
      fallback,
      fallback,
      validateTokenEnv,
    );
    if (!variable) return undefined;
    if (environment[variable]?.trim()) return variable;
    const decision = await acceptMissingTokenVariable(ui, variable);
    if (decision === "keep") return variable;
    if (decision === "back") return undefined;
  }
}

async function addEnvironmentServer(
  ui: SetupUI,
  environment: NodeJS.ProcessEnv,
  servers: Record<string, ForgejoServerConfig>,
): Promise<void> {
  const baseUrl = await promptValue(
    ui,
    "Forgejo setup · Server URL\nEnter the Forgejo web URL, including any installation subpath.",
    "https://forgejo.example.com",
    undefined,
    validateBaseUrl,
  );
  if (!baseUrl) return;
  const normalizedUrl = new URL(baseUrl);
  const alias = await promptAlias(ui, normalizedUrl.host, servers);
  if (!alias) return;
  const tokenEnv = await promptTokenEnv(ui, alias, environment);
  if (!tokenEnv) return;
  const initialRaw = { baseUrl, credentialProvider: "env", tokenEnv } as const;
  const initial = normalizeServer(alias, initialRaw);
  const remoteHosts = await promptRemoteHosts(ui, initial);
  if (remoteHosts === undefined) return;
  servers[alias] = normalizeServer(alias, { ...initialRaw, remoteHosts });
  ui.notify(`Added '${alias}' using token variable ${tokenEnv}.`, "info");
}

async function editEnvironmentServer(
  ui: SetupUI,
  environment: NodeJS.ProcessEnv,
  alias: string,
  current: ForgejoServerConfig,
): Promise<ForgejoServerConfig | undefined> {
  const baseUrl = await promptValue(
    ui,
    `Forgejo setup · ${alias} · Server URL\nPress Enter to keep '${current.baseUrl}'.`,
    current.baseUrl,
    current.baseUrl,
    validateBaseUrl,
  );
  if (!baseUrl) return undefined;
  const tokenEnv = await promptTokenEnv(ui, alias, environment, current.tokenEnv);
  if (!tokenEnv) return undefined;
  const raw = { baseUrl, credentialProvider: "env", tokenEnv } as const;
  const initial = normalizeServer(alias, { ...raw, remoteHosts: extraRemoteHosts(current) });
  const remoteHosts = await promptRemoteHosts(ui, initial);
  return remoteHosts === undefined ? undefined : normalizeServer(alias, { ...raw, remoteHosts });
}

async function editFgjServer(
  ui: SetupUI,
  alias: string,
  current: ForgejoServerConfig,
): Promise<ForgejoServerConfig | undefined> {
  const baseUrl = await promptValue(
    ui,
    `Forgejo setup · ${alias} · Server URL\nPress Enter to keep '${current.baseUrl}'.`,
    current.baseUrl,
    current.baseUrl,
    validateBaseUrl,
  );
  if (!baseUrl) return undefined;
  const hostname = await promptValue(
    ui,
    `Forgejo setup · ${alias} · fgj hostname\nPress Enter to keep '${current.hostname}'.`,
    current.hostname,
    current.hostname,
    (value) => {
      try {
        normalizeServer(alias, { baseUrl, hostname: value, credentialProvider: "fgj" });
        return undefined;
      } catch (error) {
        return errorMessage(error);
      }
    },
  );
  if (!hostname) return undefined;
  const fgjConfig = await chooseFgjConfig(ui, current.fgjConfig);
  if (fgjConfig === undefined) return undefined;
  const raw: Record<string, unknown> = { baseUrl, hostname, credentialProvider: "fgj" };
  if (fgjConfig) raw.fgjConfig = fgjConfig;
  const initial = normalizeServer(alias, { ...raw, remoteHosts: extraRemoteHosts(current) });
  const remoteHosts = await promptRemoteHosts(ui, initial);
  return remoteHosts === undefined ? undefined : normalizeServer(alias, { ...raw, remoteHosts });
}

function serverOption(alias: string, server: ForgejoServerConfig): string {
  const credentials = server.credentialProvider === "env" ? `token env ${server.tokenEnv}` : "fgj credential store";
  return `${alias} — ${server.baseUrl} — ${credentials}`;
}

async function selectServer(
  ui: SetupUI,
  title: string,
  servers: Record<string, ForgejoServerConfig>,
): Promise<string | undefined> {
  const entries = Object.entries(servers);
  const options = entries.map(([alias, server]) => serverOption(alias, server));
  const selected = await ui.select(title, options);
  const index = selected === undefined ? -1 : options.indexOf(selected);
  return index >= 0 ? entries[index]?.[0] : undefined;
}

async function editServer(
  ui: SetupUI,
  environment: NodeJS.ProcessEnv,
  servers: Record<string, ForgejoServerConfig>,
): Promise<void> {
  const alias = await selectServer(ui, "Forgejo setup · Choose a server to reconfigure", servers);
  if (!alias) return;
  const current = servers[alias];
  if (!current) return;
  const updated =
    current.credentialProvider === "env"
      ? await editEnvironmentServer(ui, environment, alias, current)
      : await editFgjServer(ui, alias, current);
  if (!updated) return;
  servers[alias] = updated;
  ui.notify(`Updated Forgejo server '${alias}'.`, "info");
}

async function removeServer(ui: SetupUI, servers: Record<string, ForgejoServerConfig>): Promise<void> {
  const alias = await selectServer(ui, "Forgejo setup · Choose a server to remove", servers);
  if (!alias) return;
  const confirmed = await ui.confirm("Remove Forgejo server?", `Remove '${alias}' from this configuration?\nNo remote data or token is deleted.`);
  if (!confirmed) return;
  delete servers[alias];
  ui.notify(`Removed Forgejo server '${alias}' from the draft.`, "info");
}

function serverMenuSummary(servers: Record<string, ForgejoServerConfig>): string {
  const entries = Object.entries(servers);
  if (entries.length === 0) return "No servers configured yet.";
  return entries.map(([alias, server]) => `• ${serverOption(alias, server)}`).join("\n");
}

async function configureServers(
  ui: SetupUI,
  exec: CommandExecutor,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  servers: Record<string, ForgejoServerConfig>,
): Promise<boolean> {
  for (;;) {
    const count = Object.keys(servers).length;
    const options = [
      ...(count > 0 ? [CONTINUE_SERVERS] : []),
      DISCOVER_FGJ,
      ADD_ENV,
      ...(count > 0 ? [EDIT_SERVER, REMOVE_SERVER] : []),
      CANCEL_SETUP,
    ];
    const choice = await ui.select(
      `Forgejo setup · 2/4 · Servers\n${serverMenuSummary(servers)}\n\nConfigure every Forgejo instance Pi should recognize.`,
      options,
    );
    if (choice === CONTINUE_SERVERS) return true;
    if (choice === DISCOVER_FGJ) await discoverServers(ui, exec, cwd, servers);
    else if (choice === ADD_ENV) await addEnvironmentServer(ui, environment, servers);
    else if (choice === EDIT_SERVER) await editServer(ui, environment, servers);
    else if (choice === REMOVE_SERVER) await removeServer(ui, servers);
    else return false;
  }
}

function recommendedDashboard(): DashboardConfig {
  return { enabled: true, scope: "all", refreshSeconds: 90, previewLimit: 3, notifications: "important", privacy: "full" };
}

function quietDashboard(): DashboardConfig {
  return { enabled: true, scope: "current", refreshSeconds: 300, previewLimit: 3, notifications: "off", privacy: "full" };
}

function privateDashboard(): DashboardConfig {
  return { enabled: true, scope: "all", refreshSeconds: 90, previewLimit: 3, notifications: "important", privacy: "counts-only" };
}

function onDemandDashboard(): DashboardConfig {
  return { enabled: false, scope: "all", refreshSeconds: 300, previewLimit: 3, notifications: "off", privacy: "full" };
}

async function promptInteger(
  ui: SetupUI,
  title: string,
  choices: Array<{ label: string; value: number }>,
  minimum: number,
  maximum: number,
): Promise<number | undefined> {
  const custom = "Custom value";
  const selected = await ui.select(title, [...choices.map((choice) => choice.label), custom, "Back"]);
  const known = choices.find((choice) => choice.label === selected);
  if (known) return known.value;
  if (selected !== custom) return undefined;
  for (;;) {
    const response = await ui.input(`${title}\nEnter a number from ${minimum} to ${maximum}.`, `${minimum}-${maximum}`);
    if (response === undefined) return undefined;
    const value = Number(response.trim());
    if (Number.isInteger(value) && value >= minimum && value <= maximum) return value;
    ui.notify(`Enter a whole number from ${minimum} to ${maximum}.`, "warning");
  }
}

async function customDashboard(ui: SetupUI, current: DashboardConfig): Promise<DashboardConfig | undefined> {
  const widgetOn = "Show the compact dashboard widget at startup";
  const widgetOff = "Keep the widget hidden; /fj still works on demand";
  const widget = await ui.select(
    `Forgejo setup · Dashboard widget\nCurrent: ${current.enabled ? "visible" : "hidden"}`,
    [widgetOn, widgetOff, "Back"],
  );
  if (widget !== widgetOn && widget !== widgetOff) return undefined;

  const allServers = "Aggregate all configured Forgejo servers";
  const currentRepo = "Show only the server for the current repository";
  const scope = await ui.select(
    `Forgejo setup · Dashboard scope\nCurrent: ${current.scope}`,
    [allServers, currentRepo, "Back"],
  );
  if (scope !== allServers && scope !== currentRepo) return undefined;

  const important = "Important only — review requests and failed CI";
  const notificationsOff = "Off — no popup notifications";
  const notificationsAll = "All attention updates";
  const notifications = await ui.select(
    `Forgejo setup · Popup notifications\nCurrent: ${current.notifications}`,
    [important, notificationsOff, notificationsAll, "Back"],
  );
  if (![important, notificationsOff, notificationsAll].includes(notifications ?? "")) return undefined;

  const full = "Full — show repository identity and item previews";
  const counts = "Counts only — hide repository identity and preview titles";
  const privacy = await ui.select(
    `Forgejo setup · Dashboard privacy\nCurrent: ${current.privacy}`,
    [full, counts, "Back"],
  );
  if (privacy !== full && privacy !== counts) return undefined;

  const refreshSeconds = await promptInteger(
    ui,
    `Forgejo setup · Refresh interval\nCurrent: ${current.refreshSeconds} seconds. Polling pauses when neither widget nor popups need it.`,
    [
      { label: "90 seconds — recommended", value: 90 },
      { label: "5 minutes — quieter", value: 300 },
      { label: "30 seconds — fastest supported", value: 30 },
    ],
    30,
    3600,
  );
  if (refreshSeconds === undefined) return undefined;

  const previewLimit = await promptInteger(
    ui,
    `Forgejo setup · Preview rows per server\nCurrent: ${current.previewLimit}. Totals remain complete even when previews are bounded.`,
    [
      { label: "3 rows — compact", value: 3 },
      { label: "5 rows", value: 5 },
      { label: "10 rows", value: 10 },
    ],
    1,
    20,
  );
  if (previewLimit === undefined) return undefined;

  return {
    enabled: widget === widgetOn,
    scope: scope === allServers ? "all" : "current",
    refreshSeconds,
    previewLimit,
    notifications:
      notifications === important ? "important" : notifications === notificationsAll ? "all" : "off",
    privacy: privacy === full ? "full" : "counts-only",
  };
}

function dashboardSummary(dashboard: DashboardConfig): string {
  return [
    dashboard.enabled ? "widget on" : "widget off",
    dashboard.scope === "all" ? "all servers" : "current repository",
    `${dashboard.notifications} popups`,
    dashboard.privacy === "full" ? "full details" : "counts only",
    `${dashboard.refreshSeconds}s refresh`,
    `${dashboard.previewLimit} preview rows/server`,
  ].join(" · ");
}

async function configureDashboard(
  ui: SetupUI,
  current: DashboardConfig,
  allowKeep: boolean,
): Promise<DashboardConfig | undefined> {
  const keep = `Keep current settings — ${dashboardSummary(current)}`;
  const recommended = "Recommended — widget, all servers, important popups, full details";
  const quiet = "Quiet — current repository, no popups, 5-minute refresh";
  const privateMode = "Private — all-server counts with hidden repository details";
  const onDemand = "On demand — no widget or popups; use /fj when needed";
  const custom = "Custom — choose every dashboard setting";
  for (;;) {
    const choice = await ui.select(
      "Forgejo setup · 3/4 · Dashboard preferences\nChoose a profile or configure each setting. Nothing here changes Forgejo itself.",
      [...(allowKeep ? [keep] : []), recommended, quiet, privateMode, onDemand, custom, "Back to servers"],
    );
    if (allowKeep && choice === keep) return { ...current };
    if (choice === recommended) return recommendedDashboard();
    if (choice === quiet) return quietDashboard();
    if (choice === privateMode) return privateDashboard();
    if (choice === onDemand) return onDemandDashboard();
    if (choice === custom) {
      const configured = await customDashboard(ui, current);
      if (configured) return configured;
      continue;
    }
    return undefined;
  }
}

function setupSummary(target: string, draft: SetupDraft, environment: NodeJS.ProcessEnv): string {
  const servers = Object.entries(draft.servers).map(([alias, server]) => {
    const credential =
      server.credentialProvider === "fgj"
        ? `fgj${server.fgjConfig ? ` (${server.fgjConfig})` : ""}`
        : `${server.tokenEnv} ${server.tokenEnv && environment[server.tokenEnv]?.trim() ? "is set" : "must be exported"}`;
    const extras = extraRemoteHosts(server);
    return `• ${alias}: ${server.baseUrl} · ${credential}${extras.length > 0 ? ` · SSH aliases ${extras.join(", ")}` : ""}`;
  });
  return [
    "Forgejo setup · 4/4 · Review",
    `Path: ${target}`,
    "",
    `Servers (${servers.length}):`,
    ...servers,
    "",
    `Dashboard: ${dashboardSummary(draft.dashboard)}`,
    "",
    "Security: token values are never written; only environment variable names are saved.",
  ].join("\n");
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function writeForgejoConfigAtomic(
  target: string,
  config: ForgejoConfig,
  expectedOriginal: string | undefined,
): Promise<void> {
  const current = await readTextIfPresent(target);
  if (current !== expectedOriginal) {
    throw new Error(`Forgejo config changed while setup was open: ${target}. Run /fj-setup again to avoid overwriting it.`);
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, target);
  } finally {
    await removeIfPresent(temporary);
  }
}

export async function runForgejoSetup(options: ForgejoSetupOptions): Promise<ForgejoSetupResult | undefined> {
  const { args, cwd, ui, exec } = options;
  const environment = options.environment ?? process.env;
  options.onStage?.("scope", 1, 4);
  const scope = await selectScope(args, ui);
  if (!scope) return undefined;
  const paths = configPaths(cwd, environment);
  const target = scope === "project" ? paths.project : paths.global;
  const originalText = await readTextIfPresent(target);
  const prepared = await prepareDraft(ui, target, originalText);
  if (!prepared) return undefined;
  const draft = prepared.draft;

  for (;;) {
    options.onStage?.("servers", 2, 4);
    const proceed = await configureServers(ui, exec, cwd, environment, draft.servers);
    if (!proceed) return undefined;

    options.onStage?.("dashboard", 3, 4);
    const dashboard = await configureDashboard(ui, draft.dashboard, prepared.keptExisting);
    if (!dashboard) continue;
    draft.dashboard = dashboard;

    for (;;) {
      options.onStage?.("review", 4, 4);
      const choice = await ui.select(setupSummary(target, draft, environment), [
        WRITE_CONFIG,
        CHANGE_DASHBOARD,
        CHANGE_SERVERS,
        CANCEL_SETUP,
      ]);
      if (choice === CHANGE_DASHBOARD) {
        options.onStage?.("dashboard", 3, 4);
        const changed = await configureDashboard(ui, draft.dashboard, true);
        if (changed) draft.dashboard = changed;
        continue;
      }
      if (choice === CHANGE_SERVERS) break;
      if (choice !== WRITE_CONFIG) return undefined;

      const validated = parseConfig({ servers: draft.servers, dashboard: draft.dashboard });
      await writeForgejoConfigAtomic(target, validated, originalText);
      return { scope, target, config: validated };
    }
  }
}
