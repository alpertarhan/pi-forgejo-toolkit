import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RuntimeProvider } from "./common.js";
import { toolResult } from "./common.js";
import { registerActionsTool } from "./actions.js";
import { registerContextTools } from "./context.js";
import { registerIssueTool } from "./issue.js";
import { registerNotificationTool } from "./notifications.js";
import { registerPullTool } from "./pull.js";
import { registerReviewTool } from "./review.js";
import { registerSearchTool } from "./search.js";
import { registerWatchTool, type WatchManagerProvider } from "./watch.js";

const FORGEJO_TOOL_DOMAINS = [
	"issue",
	"pull",
	"review",
	"actions",
	"notifications",
	"search",
	"dashboard",
	"watch",
] as const;
type ForgejoToolDomain = (typeof FORGEJO_TOOL_DOMAINS)[number];
const MAX_DOMAINS_PER_LOAD = 4;

const LAZY_FORGEJO_TOOL_NAMES = [
	"forgejo_actions",
	"forgejo_dashboard",
	"forgejo_issue",
	"forgejo_pull",
	"forgejo_review",
	"forgejo_notifications",
	"forgejo_search",
	"forgejo_watch",
] as const;

const LAZY_FORGEJO_TOOLS = new Set<string>(LAZY_FORGEJO_TOOL_NAMES);
const DOMAIN_TOOL_NAMES = {
	issue: ["forgejo_issue"],
	pull: ["forgejo_pull"],
	review: ["forgejo_pull", "forgejo_review"],
	actions: ["forgejo_actions"],
	notifications: ["forgejo_notifications"],
	search: ["forgejo_search"],
	dashboard: ["forgejo_dashboard"],
	watch: ["forgejo_watch"],
} as const satisfies Record<ForgejoToolDomain, readonly string[]>;

interface ForgejoToolController {
	reset(): void;
}

function toolsForDomains(domains: readonly ForgejoToolDomain[]): string[] {
	const selected = domains.flatMap((domain) => DOMAIN_TOOL_NAMES[domain]);
	return [...new Set(selected)];
}

export function registerForgejoTools(
	pi: ExtensionAPI,
	runtimeProvider: RuntimeProvider,
	watchManagerProvider: WatchManagerProvider = () => {
		throw new Error(
			"Forgejo watch manager is unavailable before session start",
		);
	},
): ForgejoToolController {
	registerActionsTool(pi, runtimeProvider);
	registerContextTools(pi, runtimeProvider);
	registerIssueTool(pi, runtimeProvider);
	registerPullTool(pi, runtimeProvider);
	registerReviewTool(pi, runtimeProvider);
	registerNotificationTool(pi, runtimeProvider);
	registerSearchTool(pi, runtimeProvider);
	registerWatchTool(pi, runtimeProvider, watchManagerProvider);

	pi.registerTool({
		name: "forgejo_tools",
		label: "Forgejo Tools",
		description: "Activate Forgejo tool domains needed by the current task.",
		promptSnippet: "Load additional Forgejo tools when needed",
		promptGuidelines: [
			"Use forgejo_tools before an unavailable Forgejo operation.",
		],
		parameters: Type.Object({
			domains: Type.Array(StringEnum(FORGEJO_TOOL_DOMAINS), {
				minItems: 1,
				maxItems: MAX_DOMAINS_PER_LOAD,
				uniqueItems: true,
				description:
					"Activate one to four domains; call again only if the task expands",
			}),
		}),
		async execute(_toolCallId, params) {
			if (params.domains.length > MAX_DOMAINS_PER_LOAD) {
				throw new Error(
					`forgejo_tools activates at most ${MAX_DOMAINS_PER_LOAD} domains per call; load the next group only when needed`,
				);
			}
			if (
				typeof pi.getActiveTools !== "function" ||
				typeof pi.setActiveTools !== "function"
			) {
				return toolResult(
					"Dynamic Forgejo tool activation is unavailable in this Pi version; registered tools remain unchanged.",
					{
						requested: params.domains,
						selected: [],
						added: [],
					},
				);
			}
			const requested = [...new Set(params.domains)];
			const selected = toolsForDomains(requested);
			const active = pi.getActiveTools();
			const activeSet = new Set(active);
			const added = selected.filter((name) => !activeSet.has(name));
			if (added.length > 0) pi.setActiveTools([...active, ...added]);
			return toolResult(
				added.length > 0
					? `Enabled Forgejo tools: ${added.join(", ")}`
					: `Requested Forgejo tools already active: ${selected.join(", ")}`,
				{ requested, selected, added },
			);
		},
	});

	return {
		reset() {
			if (
				typeof pi.getActiveTools !== "function" ||
				typeof pi.setActiveTools !== "function"
			)
				return;
			const active = pi.getActiveTools();
			if (!active.includes("forgejo_tools")) return;
			pi.setActiveTools(active.filter((name) => !LAZY_FORGEJO_TOOLS.has(name)));
		},
	};
}
