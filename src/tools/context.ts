import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	formatCanonicalRef,
	formatRepoRef,
	formatResourceRef,
	parseResourceRef,
} from "../refs.js";
import type { DashboardItem, ResourceRef } from "../types.js";
import { positiveLimit, toolResult, type RuntimeProvider } from "./common.js";

function itemRef(item: DashboardItem): string {
	if (item.index === undefined || item.resourceKind === "repository")
		return `${item.server}:${item.owner}/${item.repo}`;
  const ref: ResourceRef = {
    server: item.server,
    owner: item.owner,
    repo: item.repo,
    kind: item.resourceKind,
    index: item.index,
  };
  return formatResourceRef(ref);
}

function summarizeItems(
	label: string,
	items: DashboardItem[],
	total: number,
): string {
  const lines = items.map((item) => `- ${itemRef(item)} ${item.title}`);
  return [`${label}: ${total}`, ...lines].join("\n");
}

export function registerContextTools(
	pi: ExtensionAPI,
	runtimeProvider: RuntimeProvider,
): void {
  pi.registerTool({
    name: "forgejo_context",
    label: "Forgejo Context",
		description:
			"Resolve Forgejo server, repository, identity, health, capabilities, or qualified refs.",
    promptSnippet: "Resolve Forgejo context and references",
    parameters: Type.Object({
			action: StringEnum([
				"current",
				"servers",
				"select",
				"whoami",
				"health",
				"capabilities",
				"resolve_ref",
			] as const),
			server: Type.Optional(
				Type.String({
					description: "Configured server alias; required for select",
				}),
			),
			ref: Type.Optional(
				Type.String({ description: "Forgejo reference to resolve" }),
			),
    }),
    async execute(_toolCallId, params, signal) {
      const runtime = runtimeProvider();
      if (params.action === "current") {
        const repo = runtime.currentRepo();
				const reason =
					runtime.repoResolution.status === "resolved"
						? "repository context is not selected"
						: runtime.repoResolution.reason;
				const summary = repo
					? `Active Forgejo repository: ${formatRepoRef(repo)}`
					: `No active Forgejo repository: ${reason}`;
				return toolResult(summary, {
					repo,
					resolution: runtime.repoResolution,
					server: runtime.currentServer(),
				});
      }
      if (params.action === "servers") {
				const servers = Object.entries(runtime.config.servers).map(
					([alias, config]) => ({
          alias,
          baseUrl: config.baseUrl,
          hostname: config.hostname,
          credentialProvider: config.credentialProvider,
          tokenEnv: config.tokenEnv,
          selected: runtime.currentServer() === alias,
					}),
				);
				return toolResult(
					`Configured Forgejo servers: ${servers.map((server) => server.alias).join(", ")}`,
					servers,
				);
      }
      if (params.action === "select") {
        if (!params.server) throw new Error("server is required for select");
        const repo = runtime.selectServer(params.server);
        await runtime.dashboard.refreshIfObserved(signal);
        return toolResult(
					repo
						? `Selected ${formatRepoRef(repo)}`
						: `Selected Forgejo server ${params.server}; provide owner/repo for repository operations`,
          { server: params.server, repo },
        );
      }
      if (params.action === "resolve_ref") {
        if (!params.ref) throw new Error("ref is required for resolve_ref");
        const ref = parseResourceRef(params.ref);
        if (!ref) throw new Error(`invalid Forgejo reference '${params.ref}'`);
        runtime.client(ref.server);
				return toolResult(
					`${formatResourceRef(ref)} -> ${formatCanonicalRef(ref)}`,
					{ ref, canonical: formatCanonicalRef(ref) },
				);
      }

			if (params.server)
				await runtime.capabilities.refreshAlias(params.server, signal, true);
			else await runtime.capabilities.refresh(signal, true);
			const capabilities = runtime.capabilities.snapshot();
      if (params.action === "whoami") {
        const identities = Object.fromEntries(
          Object.entries(capabilities.values)
            .filter(([alias]) => !params.server || alias === params.server)
            .map(([alias, value]) => [alias, value.user]),
        );
        if (params.server && !identities[params.server]) {
					throw new Error(
						capabilities.errors[params.server] ??
							`unknown Forgejo server '${params.server}'`,
					);
        }
        const summary = Object.entries(identities)
          .map(([alias, user]) => `${alias}: ${user.login}`)
          .join(" | ");
				return toolResult(
					summary || "No Forgejo identities available",
					identities,
				);
      }
      if (params.action === "capabilities") {
        const values = params.server
          ? capabilities.values[params.server]
            ? { [params.server]: capabilities.values[params.server] }
            : {}
          : capabilities.values;
        return toolResult(
          Object.values(values)
						.filter(
							(value): value is NonNullable<typeof value> =>
								value !== undefined,
						)
            .map((value) => `${value.server}: Forgejo ${value.version}`)
            .join(" | ") || "No capability data available",
          { values, errors: capabilities.errors },
        );
      }
      const health = Object.fromEntries(
				runtime.clients
					.aliases()
					.map((alias) => [
          alias,
						capabilities.values[alias]
							? { status: "ok", version: capabilities.values[alias]?.version }
							: { status: "error", error: capabilities.errors[alias] },
        ]),
      );
      return toolResult(
        Object.entries(health)
          .map(([alias, value]) => `${alias}: ${value?.status ?? "error"}`)
          .join(" | "),
        health,
      );
    },
  });

  pi.registerTool({
    name: "forgejo_dashboard",
    label: "Forgejo Dashboard",
		description:
			"Read the multi-server attention dashboard: issues, PRs, reviews, failed CI, and notifications.",
    parameters: Type.Object({
			action: StringEnum([
				"get",
				"refresh",
				"get_attention_items",
				"get_assigned_issues",
				"get_authored_pulls",
				"get_review_requests",
				"get_failed_runs",
			] as const),
			server: Type.Optional(
				Type.String({ description: "Limit results to one server alias" }),
			),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, params, signal) {
      const runtime = runtimeProvider();
      if (params.action === "refresh") await runtime.dashboard.refresh(signal);
      else await runtime.dashboard.ensureFresh(signal);
      const snapshot = runtime.dashboard.snapshot();
			const serverValues = Object.values(snapshot.servers).filter(
				(server) => !params.server || server.alias === params.server,
			);
			if (params.server && serverValues.length === 0)
				throw new Error(`unknown Forgejo server '${params.server}'`);
      const limit = positiveLimit(params.limit);
      if (params.action === "get" || params.action === "refresh") {
				const totals = {
					assignedIssues: serverValues.reduce(
						(sum, server) => sum + server.assignedIssues.total,
						0,
					),
					authoredPulls: serverValues.reduce(
						(sum, server) => sum + server.authoredPulls.total,
						0,
					),
					reviewRequests: serverValues.reduce(
						(sum, server) => sum + server.reviewRequests.total,
						0,
					),
					notifications: serverValues.reduce(
						(sum, server) => sum + server.notifications.total,
						0,
					),
					failedRuns: serverValues.reduce(
						(sum, server) => sum + server.failedRuns.total,
						0,
					),
				};
				const filtered = params.server
					? {
							...snapshot,
							servers: Object.fromEntries(
								serverValues.map((server) => [server.alias, server]),
							),
							totals,
							attention: snapshot.attention.filter(
								(item) => item.server === params.server,
							),
						}
					: snapshot;
        return toolResult(
					`Issues ${totals.assignedIssues} | My Open PRs ${totals.authoredPulls} | Reviews ${totals.reviewRequests} | CI failed ${totals.failedRuns} | Inbox ${totals.notifications}`,
					filtered,
        );
      }
      if (params.action === "get_attention_items") {
				const items = snapshot.attention
					.filter((item) => !params.server || item.server === params.server)
					.slice(0, limit);
				return toolResult(
					summarizeItems("Attention", items, items.length),
					items,
				);
      }
      const collectionKey =
        params.action === "get_assigned_issues"
          ? "assignedIssues"
          : params.action === "get_authored_pulls"
            ? "authoredPulls"
            : params.action === "get_failed_runs"
              ? "failedRuns"
              : "reviewRequests";
			const total = serverValues.reduce(
				(sum, server) => sum + server[collectionKey].total,
				0,
			);
			const items = serverValues
				.flatMap((server) => server[collectionKey].items)
				.slice(0, limit);
      const label =
        collectionKey === "assignedIssues"
          ? "Assigned issues"
          : collectionKey === "authoredPulls"
            ? "My open pull requests"
            : collectionKey === "failedRuns"
              ? "Failed CI runs"
              : "Review requests";
      return toolResult(summarizeItems(label, items, total), { total, items });
    },
  });
}
