import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { configPaths, parseConfig } from "./config.js";
import { createForgejoAutocompleteProvider } from "./dashboard/autocomplete.js";
import { DashboardNotifier } from "./dashboard/notifier.js";
import { DashboardOverlay } from "./dashboard/overlay.js";
import { markNotificationRead } from "./dashboard/query.js";
import { DashboardWidget } from "./dashboard/widget.js";
import { buildFgjConfig, discoverFgjInstances } from "./fgj.js";
import { formatRepoRef, parseResourceRef, repoWebUrl, resourceWebUrl } from "./refs.js";
import { createRuntime, type ForgejoRuntime } from "./runtime.js";
import { registerForgejoTools } from "./tools/index.js";
import type { DashboardItem, DashboardScope } from "./types.js";

async function openExternal(pi: ExtensionAPI, url: string): Promise<void> {
  const application = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const result = await pi.exec(application, args, { timeout: 5_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `failed to open ${url}`);
}

async function readConfigObject(path: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must contain a JSON object`);
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export default function forgejoExtension(pi: ExtensionAPI): void {
  let runtime: ForgejoRuntime | undefined;
  let startupError: Error | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let notifier: DashboardNotifier | undefined;
  let statusUnsubscribe: (() => void) | undefined;
  let widgetScope: DashboardScope = "all";
  let widgetVisible = true;
  const widgets = new Set<DashboardWidget>();

  const requireRuntime = (): ForgejoRuntime => {
    if (runtime) return runtime;
    if (startupError) throw startupError;
    throw new Error("Forgejo extension is still initializing");
  };

  const cleanup = (): void => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    notifier?.close();
    notifier = undefined;
    statusUnsubscribe?.();
    statusUnsubscribe = undefined;
    for (const widget of widgets) widget.close();
    widgets.clear();
    runtime?.close();
    runtime = undefined;
  };

  const installWidget = (ctx: ExtensionContext): void => {
    const current = requireRuntime();
    if (ctx.mode !== "tui") return;
    for (const widget of widgets) widget.close();
    widgets.clear();
    statusUnsubscribe?.();
    ctx.ui.setWidget("forgejo-dashboard", (tui, theme) => {
      const widget = new DashboardWidget(current.dashboard, theme, current.config.dashboard.privacy, widgetScope, () => tui.requestRender());
      widgets.add(widget);
      return widget;
    });
    statusUnsubscribe = current.dashboard.subscribe(() => {
      const snapshot = current.dashboard.snapshot();
      const repo = snapshot.activeRepo ? formatRepoRef(snapshot.activeRepo) : "all";
      const scopedServer = widgetScope === "current" && snapshot.activeRepo ? snapshot.servers[snapshot.activeRepo.server] : undefined;
      const attention = scopedServer
        ? scopedServer.reviewRequests.total + scopedServer.failedRuns.total + scopedServer.notifications.total
        : snapshot.totals.reviewRequests + snapshot.totals.failedRuns + snapshot.totals.notifications;
      ctx.ui.setStatus("forgejo", `fj ${repo} · ${attention} attention`);
    });
    widgetVisible = true;
  };

  const refresh = async (signal?: AbortSignal): Promise<void> => {
    const current = requireRuntime();
    await Promise.all([current.capabilities.refresh(signal), current.dashboard.refresh(signal)]);
  };


  pi.registerCommand("fj-setup", {
    description: "Create global or project Forgejo config from authenticated fgj instances",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("/fj-setup requires an interactive UI");
      const scope = args.trim().toLowerCase() || "global";
      if (scope !== "global" && scope !== "project") throw new Error("usage: /fj-setup [global|project]");
      const instances = await discoverFgjInstances(
        async (command, commandArgs, options) => pi.exec(command, commandArgs, options),
        ctx.cwd,
      );
      const generated = buildFgjConfig(instances);
      const paths = configPaths(ctx.cwd);
      const target = scope === "project" ? paths.project : paths.global;
      const existing = await readConfigObject(target);
      const existingServers =
        typeof existing.servers === "object" && existing.servers !== null && !Array.isArray(existing.servers)
          ? (existing.servers as Record<string, unknown>)
          : {};
      const proposal = {
        ...existing,
        servers: { ...existingServers, ...generated.servers },
        dashboard: existing.dashboard ?? generated.dashboard,
      };
      const edited = await ctx.ui.editor(`Forgejo config: ${target}`, JSON.stringify(proposal, null, 2));
      if (edited === undefined) return;
      const parsed = JSON.parse(edited) as unknown;
      const validated = parseConfig(parsed);
      const accepted = await ctx.ui.confirm(
        "Write Forgejo config",
        `Path: ${target}\nInstances: ${Object.keys(validated.servers).join(", ")}\nCredentials: fgj auth store`,
      );
      if (!accepted) return;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      ctx.ui.notify(`Forgejo config written: ${target}`, "info");
      await ctx.reload();
    },
  });
  registerForgejoTools(pi, requireRuntime);

  pi.registerCommand("fj-context", {
    description: "Show the active Forgejo server and repository",
    handler: async (_args, ctx) => {
      const current = requireRuntime();
      const repo = current.currentRepo();
      const reason = current.repoResolution.status === "resolved" ? "repository context is not selected" : current.repoResolution.reason;
      ctx.ui.notify(repo ? `Forgejo: ${formatRepoRef(repo)}` : `Forgejo: ${reason}`, repo ? "info" : "warning");
    },
  });

  pi.registerCommand("fj-server", {
    description: "Select a Forgejo server for this session",
    handler: async (args, ctx) => {
      const current = requireRuntime();
      let alias = args.trim();
      if (!alias) {
        if (!ctx.hasUI) throw new Error("server alias is required without an interactive UI");
        alias = (await ctx.ui.select("Forgejo server", current.clients.aliases())) ?? "";
      }
      if (!alias) return;
      const repo = current.selectServer(alias);
      await current.dashboard.refresh();
      ctx.ui.notify(repo ? `Selected ${formatRepoRef(repo)}` : `Selected ${alias}; repository context remains explicit`, "info");
    },
  });

  pi.registerCommand("fj-health", {
    description: "Check every configured Forgejo server and token",
    handler: async (_args, ctx) => {
      const current = requireRuntime();
      const snapshot = await current.capabilities.refresh();
      const lines = current.clients.aliases().map((alias) =>
        snapshot.values[alias] ? `${alias}: ok (Forgejo ${snapshot.values[alias]?.version})` : `${alias}: ${snapshot.errors[alias] ?? "error"}`,
      );
      ctx.ui.notify(lines.join("\n"), Object.keys(snapshot.errors).length > 0 ? "warning" : "info");
    },
  });

  pi.registerCommand("fj-refresh", {
    description: "Refresh the Forgejo dashboard immediately",
    handler: async (_args, ctx) => {
      await refresh();
      ctx.ui.notify("Forgejo dashboard refreshed", "info");
    },
  });

  pi.registerCommand("fj-widget", {
    description: "Show, hide, or scope the compact Forgejo dashboard widget",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const command = args.trim().toLowerCase();
      const action = command || (widgetVisible ? "off" : "on");
      if (action === "off") {
        ctx.ui.setWidget("forgejo-dashboard", undefined);
        for (const widget of widgets) widget.close();
        widgets.clear();
        statusUnsubscribe?.();
        statusUnsubscribe = undefined;
        ctx.ui.setStatus("forgejo", undefined);
        widgetVisible = false;
        ctx.ui.notify("Forgejo widget hidden", "info");
        return;
      }
      if (action !== "on" && action !== "all" && action !== "current") throw new Error("usage: /fj-widget [on|off|all|current]");
      if (action === "all" || action === "current") widgetScope = action;
      installWidget(ctx);
      ctx.ui.notify(`Forgejo widget visible (${widgetScope})`, "info");
    },
  });

  pi.registerCommand("fj-open", {
    description: "Open the active Forgejo repository or a qualified issue/PR reference",
    handler: async (args) => {
      const current = requireRuntime();
      const value = args.trim();
      if (value) {
        const ref = parseResourceRef(value);
        if (!ref) throw new Error(`invalid Forgejo reference '${value}'`);
        const server = current.config.servers[ref.server];
        if (!server) throw new Error(`unknown server '${ref.server}'`);
        await openExternal(pi, resourceWebUrl(ref, server));
        return;
      }
      const repo = current.currentRepo();
      if (!repo) throw new Error("no active Forgejo repository");
      const server = current.config.servers[repo.server];
      if (!server) throw new Error(`unknown server '${repo.server}'`);
      await openExternal(pi, repoWebUrl(repo, server));
    },
  });

  pi.registerCommand("fj", {
    description: "Open the interactive Forgejo attention dashboard",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") throw new Error("/fj dashboard requires TUI mode");
      const current = requireRuntime();
      if (!current.dashboard.snapshot().fetchedAt) await current.dashboard.refresh();
      let overlay: DashboardOverlay | undefined;
      const selection = await ctx.ui.custom<string | null>(
        (tui, theme, _keybindings, done) => {
          overlay = new DashboardOverlay(
            current.dashboard,
            theme,
            () => tui.requestRender(),
            (reference) => done(reference),
            () => done(null),
            (url) => openExternal(pi, url),
            () => current.dashboard.refresh().then(() => undefined),
            async (item: DashboardItem) => {
              if (item.sourceId === undefined) throw new Error("selected item is not a notification");
              await markNotificationRead(current.client(item.server), item.sourceId);
              await current.dashboard.refresh();
            },
            args.trim() || undefined,
          );
          return overlay;
        },
        {
          overlay: true,
          overlayOptions: { width: "80%", minWidth: 54, maxHeight: "80%", anchor: "center" },
        },
      );
      overlay?.close();
      if (selection) ctx.ui.pasteToEditor(`${selection} `);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    cleanup();
    startupError = undefined;
    try {
      runtime = await createRuntime(
        ctx.cwd,
        async (command, args, options) => pi.exec(command, args, options),
        process.env,
        fetch,
      );
    } catch (error) {
      startupError = error instanceof Error ? error : new Error(String(error));
      if (ctx.hasUI) ctx.ui.notify(startupError.message, "warning");
      return;
    }
    widgetScope = runtime.config.dashboard.scope;
    widgetVisible = runtime.config.dashboard.enabled;

    if (ctx.mode === "tui") {
      if (widgetVisible) installWidget(ctx);
      ctx.ui.addAutocompleteProvider((current: AutocompleteProvider) => createForgejoAutocompleteProvider(current, requireRuntime().dashboard));
      if (runtime.config.dashboard.notifications !== "off") {
        notifier = new DashboardNotifier(runtime.dashboard, runtime.config.dashboard.notifications, (message, level) => ctx.ui.notify(message, level));
      }
      void refresh().catch((error: unknown) => {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      });
      refreshTimer = setInterval(() => {
        void runtime?.dashboard.refresh();
      }, runtime.config.dashboard.refreshSeconds * 1_000);
      refreshTimer.unref();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("forgejo", undefined);
      ctx.ui.setWidget("forgejo-dashboard", undefined);
    }
    cleanup();
  });
}
