import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { runForgejoSetup, type SetupStage } from "./setup.js";
import { createForgejoAutocompleteProvider } from "./dashboard/autocomplete.js";
import { DashboardNotifier } from "./dashboard/notifier.js";
import { DashboardOverlay } from "./dashboard/overlay.js";
import { markNotificationRead } from "./dashboard/query.js";
import { DashboardWidget, renderDashboardStatus } from "./dashboard/widget.js";
import {
	formatRepoRef,
	parseResourceRef,
	repoWebUrl,
	resourceWebUrl,
} from "./refs.js";
import { createRuntime, type ForgejoRuntime } from "./runtime.js";
import { registerForgejoTools } from "./tools/index.js";
import type { DashboardItem, DashboardScope, RepoResolution } from "./types.js";
import { WatchManager } from "./watch.js";
import { sendWatchNotification } from "./watch-notification.js";

export function dashboardStartsAutomatically(
	enabled: boolean,
	status: RepoResolution["status"],
): boolean {
	return enabled && status !== "none";
}

function parseHttpUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Forgejo link must be an absolute http(s) URL");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
		throw new Error("Forgejo link must use http or https");
	return parsed;
}

export function forgejoWebUrl(url: string, expectedBaseUrl?: string): URL {
	const target = parseHttpUrl(url);
	if (!expectedBaseUrl) return target;
	const base = parseHttpUrl(expectedBaseUrl);
	const basePath = base.pathname.replace(/\/+$/, "");
	if (
		target.origin !== base.origin ||
		(basePath &&
			target.pathname !== basePath &&
			!target.pathname.startsWith(`${basePath}/`))
	) {
		throw new Error("Forgejo link leaves the configured server URL");
	}
	return target;
}

export function externalOpenCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
	const normalizedUrl = forgejoWebUrl(url).href;
	return platform === "darwin"
		? { command: "open", args: [normalizedUrl] }
		: platform === "win32"
			? { command: "explorer.exe", args: [normalizedUrl] }
			: { command: "xdg-open", args: [normalizedUrl] };
}

async function openExternal(
	pi: ExtensionAPI,
	url: string,
	expectedBaseUrl?: string,
): Promise<void> {
	const target = forgejoWebUrl(url, expectedBaseUrl);
	const { command, args } = externalOpenCommand(target.href);
	const result = await pi.exec(command, args, { timeout: 5_000 });
	if (result.code !== 0)
		throw new Error(result.stderr.trim() || `failed to open ${url}`);
}

export default function forgejoExtension(pi: ExtensionAPI): void {
	let runtime: ForgejoRuntime | undefined;
	let watchManager: WatchManager | undefined;
	let startupError: Error | undefined;
	let refreshTimer: NodeJS.Timeout | undefined;
	let notifier: DashboardNotifier | undefined;
	let statusUnsubscribe: (() => void) | undefined;
	let widgetScope: DashboardScope = "all";
	let widgetVisible = false;
	const widgets = new Set<DashboardWidget>();

	const requireRuntime = (): ForgejoRuntime => {
		if (runtime) return runtime;
		if (startupError) throw startupError;
		throw new Error("Forgejo extension is still initializing");
	};

	const stopRefreshTimer = (): void => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
	};

	const cleanup = (): void => {
		watchManager?.close();
		watchManager = undefined;
		stopRefreshTimer();
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
			const widget = new DashboardWidget(
				current.dashboard,
				theme,
				current.config.dashboard.privacy,
				widgetScope,
				() => tui.requestRender(),
			);
			widgets.add(widget);
			return widget;
		});
		const updateStatus = (): void => {
			ctx.ui.setStatus(
				"forgejo",
				renderDashboardStatus(
					current.dashboard.snapshot(),
					current.config.dashboard.privacy,
					widgetScope,
				),
			);
		};
		statusUnsubscribe = current.dashboard.subscribe(updateStatus);
		updateStatus();
		widgetVisible = true;
	};

	const refresh = async (signal?: AbortSignal) => {
		const current = requireRuntime();
		const [, snapshot] = await Promise.all([
			current.capabilities.refresh(signal, true),
			current.dashboard.refresh(signal),
		]);
		return snapshot;
	};

	const runInBackground = (
		ctx: ExtensionContext,
		operation: Promise<unknown>,
	): void => {
		void operation.catch((error: unknown) => {
			if (ctx.hasUI)
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
		});
	};

	const syncDashboardActivity = (
		ctx: ExtensionContext,
		refreshNow: boolean,
	): void => {
		const current = runtime;
		if (!current || ctx.mode !== "tui" || (!widgetVisible && !notifier)) {
			stopRefreshTimer();
			return;
		}
		if (!refreshTimer) {
			refreshTimer = setInterval(() => {
				const active = runtime;
				if (active) runInBackground(ctx, active.dashboard.refresh());
			}, current.config.dashboard.refreshSeconds * 1_000);
			refreshTimer.unref();
		}
		if (refreshNow) runInBackground(ctx, refresh());
	};

	pi.registerCommand("fj-setup", {
		description:
			"Run the guided Forgejo server, credential, and dashboard setup",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) throw new Error("/fj-setup requires an interactive UI");
			const labels: Record<SetupStage, string> = {
				scope: "Scope",
				servers: "Servers",
				dashboard: "Dashboard",
				review: "Review",
			};
			const updateProgress = (
				stage: SetupStage,
				step: number,
				total: number,
			): void => {
				ctx.ui.setStatus(
					"forgejo-setup",
					`setup ${step}/${total} · ${labels[stage]}`,
				);
				if (ctx.mode === "tui") {
					const stages: SetupStage[] = [
						"scope",
						"servers",
						"dashboard",
						"review",
					];
					ctx.ui.setWidget("forgejo-setup", [
						`Forgejo Setup  ${step}/${total}`,
						stages
							.map(
								(value, index) =>
									`${value === stage ? "[" : " "}${index + 1} ${labels[value]}${value === stage ? "]" : " "}`,
							)
							.join("  "),
						"Native guided setup; Esc cancels safely. API token values are never written.",
					]);
				}
			};
			try {
				const result = await runForgejoSetup({
					args,
					cwd: ctx.cwd,
					ui: ctx.ui,
					exec: async (command, commandArgs, options) =>
						pi.exec(command, commandArgs, options),
					onStage: updateProgress,
				});
				if (!result) {
					ctx.ui.notify(
						"Forgejo setup cancelled; no configuration was changed.",
						"info",
					);
					return;
				}
				ctx.ui.notify(`Forgejo config written: ${result.target}`, "info");
				await ctx.reload();
			} finally {
				ctx.ui.setStatus("forgejo-setup", undefined);
				if (ctx.mode === "tui") ctx.ui.setWidget("forgejo-setup", undefined);
			}
		},
	});
	const forgejoTools = registerForgejoTools(pi, requireRuntime, () => {
		if (!watchManager)
			throw new Error(
				"Forgejo watch manager is unavailable before session start",
			);
		return watchManager;
	});

	pi.registerCommand("fj-context", {
		description: "Show the active Forgejo server and repository",
		handler: async (_args, ctx) => {
			const current = requireRuntime();
			const repo = current.currentRepo();
			const reason =
				current.repoResolution.status === "resolved"
					? "repository context is not selected"
					: current.repoResolution.reason;
			ctx.ui.notify(
				repo ? `Forgejo: ${formatRepoRef(repo)}` : `Forgejo: ${reason}`,
				repo ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("fj-server", {
		description: "Select a Forgejo server for this session",
		handler: async (args, ctx) => {
			const current = requireRuntime();
			let alias = args.trim();
			if (!alias) {
				if (!ctx.hasUI)
					throw new Error("server alias is required without an interactive UI");
				alias =
					(await ctx.ui.select("Forgejo server", current.clients.aliases())) ??
					"";
			}
			if (!alias) return;
			const repo = current.selectServer(alias);
			ctx.ui.notify(
				repo
					? `Selected ${formatRepoRef(repo)}`
					: `Selected ${alias}; repository context remains explicit`,
				"info",
			);
			runInBackground(ctx, current.dashboard.refreshIfObserved());
		},
	});

	pi.registerCommand("fj-health", {
		description: "Check every configured Forgejo server and token",
		handler: async (_args, ctx) => {
			const current = requireRuntime();
			const snapshot = await current.capabilities.refresh(undefined, true);
			const lines = current.clients
				.aliases()
				.map((alias) =>
					snapshot.values[alias]
						? `${alias}: ok (Forgejo ${snapshot.values[alias]?.version})`
						: `${alias}: ${snapshot.errors[alias] ?? "error"}`,
				);
			ctx.ui.notify(
				lines.join("\n"),
				Object.keys(snapshot.errors).length > 0 ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("fj-refresh", {
		description: "Refresh the Forgejo dashboard immediately",
		handler: async (_args, ctx) => {
			const snapshot = await refresh();
			const degraded = Object.values(snapshot.servers)
				.filter((server) => server.health !== "ready")
				.map((server) => `${server.alias} (${server.health})`);
			ctx.ui.notify(
				degraded.length > 0
					? `Forgejo refreshed with degraded servers: ${degraded.join(", ")}`
					: `Forgejo refreshed: ${Object.keys(snapshot.servers).length} servers`,
				degraded.length > 0 ? "warning" : "info",
			);
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
				syncDashboardActivity(ctx, false);
				ctx.ui.notify("Forgejo widget hidden", "info");
				return;
			}
			if (action !== "on" && action !== "all" && action !== "current")
				throw new Error("usage: /fj-widget [on|off|all|current]");
			if (action === "all" || action === "current") widgetScope = action;
			installWidget(ctx);
			syncDashboardActivity(ctx, true);
			ctx.ui.notify(`Forgejo widget visible (${widgetScope})`, "info");
		},
	});

	pi.registerCommand("fj-open", {
		description:
			"Open the active Forgejo repository or a qualified issue/PR reference",
		handler: async (args) => {
			const current = requireRuntime();
			const value = args.trim();
			if (value) {
				const ref = parseResourceRef(value);
				if (!ref) throw new Error(`invalid Forgejo reference '${value}'`);
				const server = current.config.servers[ref.server];
				if (!server) throw new Error(`unknown server '${ref.server}'`);
				await openExternal(pi, resourceWebUrl(ref, server), server.baseUrl);
				return;
			}
			const repo = current.currentRepo();
			if (!repo) throw new Error("no active Forgejo repository");
			const server = current.config.servers[repo.server];
			if (!server) throw new Error(`unknown server '${repo.server}'`);
			await openExternal(pi, repoWebUrl(repo, server), server.baseUrl);
		},
	});

	pi.registerCommand("fj", {
		description: "Open the interactive Forgejo attention dashboard",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui")
				throw new Error("/fj dashboard requires TUI mode");
			const current = requireRuntime();
			runInBackground(ctx, current.dashboard.refresh());
			let overlay: DashboardOverlay | undefined;
			const selection = await ctx.ui.custom<string | null>(
				(tui, theme, _keybindings, done) => {
					overlay = new DashboardOverlay(
						current.dashboard,
						theme,
						() => tui.requestRender(),
						(reference) => done(reference),
						() => done(null),
						(item) => {
							const server = current.config.servers[item.server];
							if (!server) throw new Error(`unknown server '${item.server}'`);
							return openExternal(pi, item.webUrl, server.baseUrl);
						},
						() => current.dashboard.refresh().then(() => undefined),
						async (item: DashboardItem) => {
							if (item.sourceId === undefined)
								throw new Error("selected item is not a notification");
							await markNotificationRead(
								current.client(item.server),
								item.sourceId,
							);
							await current.dashboard.refresh();
						},
						args.trim() || undefined,
					);
					return overlay;
				},
				{
					overlay: true,
					overlayOptions: {
						width: "80%",
						minWidth: 54,
						maxHeight: "80%",
						anchor: "center",
					},
				},
			);
			overlay?.close();
			if (selection) ctx.ui.pasteToEditor(`${selection} `);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		forgejoTools.reset();
		cleanup();
		startupError = undefined;
		try {
			runtime = await createRuntime(
				ctx.cwd,
				async (command, args, options) => pi.exec(command, args, options),
				process.env,
				fetch,
				ctx.isProjectTrusted(),
			);
		} catch (error) {
			startupError = error instanceof Error ? error : new Error(String(error));
			if (ctx.hasUI) ctx.ui.notify(startupError.message, "warning");
			return;
		}
		const currentManager = new WatchManager(
			(server) => requireRuntime().client(server),
			(emission) => {
				if (watchManager === currentManager)
					sendWatchNotification(pi, emission);
			},
		);
		watchManager = currentManager;
		const forgejoProject = runtime.repoResolution.status !== "none";
		widgetScope = runtime.config.dashboard.scope;
		widgetVisible = dashboardStartsAutomatically(
			runtime.config.dashboard.enabled,
			runtime.repoResolution.status,
		);

		if (ctx.mode === "tui") {
			if (widgetVisible) installWidget(ctx);
			ctx.ui.addAutocompleteProvider((current: AutocompleteProvider) =>
				createForgejoAutocompleteProvider(current, requireRuntime().dashboard),
			);
			if (forgejoProject && runtime.config.dashboard.notifications !== "off") {
				notifier = new DashboardNotifier(
					runtime.dashboard,
					runtime.config.dashboard.notifications,
					(message, level) => ctx.ui.notify(message, level),
				);
			}
			syncDashboardActivity(ctx, true);
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
