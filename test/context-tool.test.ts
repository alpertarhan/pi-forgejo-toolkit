import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ForgejoRuntime } from "../src/runtime.js";
import { registerContextTools } from "../src/tools/context.js";
import type { DashboardSnapshot, ForgejoCapabilities } from "../src/types.js";

interface CapturedTool {
	name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<unknown>;
}

function collection(total: number) {
	return { total, items: [] };
}

function snapshot(): DashboardSnapshot {
	return {
		servers: {
			work: {
				alias: "work",
				health: "ready",
				assignedIssues: collection(2),
				authoredPulls: collection(3),
				reviewRequests: collection(4),
				notifications: collection(5),
				failedRuns: collection(6),
			},
			community: {
				alias: "community",
				health: "ready",
				assignedIssues: collection(20),
				authoredPulls: collection(30),
				reviewRequests: collection(40),
				notifications: collection(50),
				failedRuns: collection(60),
			},
		},
		totals: {
			assignedIssues: 22,
			authoredPulls: 33,
			reviewRequests: 44,
			notifications: 55,
			failedRuns: 66,
		},
		attention: [],
		refreshing: false,
		fetchedAt: "2026-08-12T10:00:00Z",
	};
}

describe("forgejo dashboard tool", () => {
	it("filters get totals and payload to the requested server", async () => {
		const tools: CapturedTool[] = [];
		const api = {
			registerTool(tool: CapturedTool) {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI;
		const value = snapshot();
		const runtime = {
			dashboard: {
				ensureFresh: vi.fn(async () => value),
				refresh: vi.fn(async () => value),
				snapshot: () => value,
			},
		} as unknown as ForgejoRuntime;
		registerContextTools(api, () => runtime);
		const dashboard = tools.find((tool) => tool.name === "forgejo_dashboard");
		if (!dashboard) throw new Error("dashboard tool was not registered");

		const result = (await dashboard.execute(
			"filtered",
			{ action: "get", server: "work" },
			new AbortController().signal,
			undefined,
			{ hasUI: false } as ExtensionContext,
		)) as {
			content: Array<{ text: string }>;
			details: { data: DashboardSnapshot };
		};

		expect(result.content[0]?.text).toContain(
			"Issues 2 | My Open PRs 3 | Reviews 4 | CI failed 6 | Inbox 5",
		);
		expect(Object.keys(result.details.data.servers)).toEqual(["work"]);
		expect(result.details.data.totals).toEqual({
			assignedIssues: 2,
			authoredPulls: 3,
			reviewRequests: 4,
			notifications: 5,
			failedRuns: 6,
		});
	});

	it("reuses cached identity but forces explicit capability rediscovery", async () => {
		const tools: CapturedTool[] = [];
		const api = {
			registerTool(tool: CapturedTool) {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI;
		const capability: ForgejoCapabilities = {
			server: "work",
			version: "16.0.2",
			user: { id: 1, login: "alice" },
			paging: {},
			features: {
				dashboardSearch: true,
				notifications: true,
				reviews: true,
				actionsRuns: "available",
				actionsDispatch: "available",
				actionsCancel: "available",
				actionsRerun: "available",
				actionsArtifacts: "available",
			},
		};
		const refreshAlias = vi.fn(async () => capability);
		const runtime = {
			capabilities: {
				refreshAlias,
				snapshot: () => ({ values: { work: capability }, errors: {} }),
			},
		} as unknown as ForgejoRuntime;
		registerContextTools(api, () => runtime);
		const context = tools.find((tool) => tool.name === "forgejo_context");
		if (!context) throw new Error("context tool was not registered");
		const signal = new AbortController().signal;

		await context.execute(
			"whoami",
			{ action: "whoami", server: "work" },
			signal,
			undefined,
			{ hasUI: false } as ExtensionContext,
		);
		expect(refreshAlias).toHaveBeenLastCalledWith("work", signal, false);

		await context.execute(
			"capabilities",
			{ action: "capabilities", server: "work" },
			signal,
			undefined,
			{ hasUI: false } as ExtensionContext,
		);
		expect(refreshAlias).toHaveBeenLastCalledWith("work", signal, true);
	});
});
