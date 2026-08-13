import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	formatWatchNotification,
	sendWatchNotification,
} from "../src/watch-notification.js";
import type { ForgejoRuntime } from "../src/runtime.js";
import { registerWatchTool } from "../src/tools/watch.js";
import type { EventWatch, WatchEmission, WatchManager } from "../src/watch.js";

interface CapturedTool {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: { data: unknown };
	}>;
}

const signal = new AbortController().signal;
const context = { hasUI: false } as ExtensionContext;
const ref = {
	server: "work",
	owner: "acme",
	repo: "app",
	kind: "pull",
	index: 9,
} as const;

function watch(overrides: Partial<EventWatch> = {}): EventWatch {
	return {
		id: "watch-1",
		reference: "work:acme/app!9",
		ref,
		filters: ["feedback"],
		includeSelf: false,
		attention: "turn",
		state: "active",
		createdAt: "2026-08-12T10:00:00.000Z",
		pollIntervalMs: 60_000,
		timeoutMs: 7_200_000,
		failures: 0,
		...overrides,
	};
}

function fixture(initial = [watch()]) {
	let watches = [...initial];
	const manager = {
		arm: vi.fn(async () => watch()),
		list: vi.fn(() => [...watches]),
		stop: vi.fn((id: string) => {
			const item = watches.find(
				(candidate) => candidate.id === id && candidate.state === "active",
			);
			if (!item) return false;
			watches = watches.map((candidate) =>
				candidate.id === id ? { ...candidate, state: "stopped" } : candidate,
			);
			return true;
		}),
	} as unknown as WatchManager;
	const runtime = {
		resolveResource: vi.fn(() => ref),
	} as unknown as ForgejoRuntime;
	let tool: CapturedTool | undefined;
	const pi = {
		registerTool(definition: CapturedTool) {
			tool = definition;
		},
	} as unknown as ExtensionAPI;
	registerWatchTool(
		pi,
		() => runtime,
		() => manager,
	);
	if (!tool) throw new Error("watch tool was not registered");
	return { tool, manager, runtime };
}

function data(
	result: Awaited<ReturnType<CapturedTool["execute"]>>,
): Record<string, unknown> {
	return result.details.data as Record<string, unknown>;
}

describe("forgejo_watch tool", () => {
	it("starts with safe defaults and reports created, deduplicated, and already matched outcomes", async () => {
		const f = fixture([]);
		const created = await f.tool.execute(
			"start",
			{ action: "start", ref: "work:acme/app!9" },
			signal,
			undefined,
			context,
		);

		expect(f.runtime.resolveResource).toHaveBeenCalledWith(
			{ ref: "work:acme/app!9" },
			"pull",
		);
		expect(f.manager.arm).toHaveBeenCalledWith(
			expect.objectContaining({
				ref,
				filters: ["feedback"],
				pollIntervalMs: 60_000,
				timeoutMs: 7_200_000,
				attention: "turn",
				includeSelf: false,
				signal,
			}),
		);
		expect(data(created).outcome).toBe("created");

		const duplicateFixture = fixture();
		expect(
			data(
				await duplicateFixture.tool.execute(
					"dedupe",
					{ action: "start", ref: "work:acme/app!9" },
					signal,
					undefined,
					context,
				),
			).outcome,
		).toBe("deduplicated");

		const matchedFixture = fixture([]);
		vi.mocked(matchedFixture.manager.arm).mockResolvedValue(
			watch({ state: "matched", matchedTotal: 1 }),
		);
		expect(
			data(
				await matchedFixture.tool.execute(
					"matched",
					{ action: "start", ref: "work:acme/app!9" },
					signal,
					undefined,
					context,
				),
			).outcome,
		).toBe("already-matched");
	});

	it("lists bounded summaries, stops one, stops all, and rejects invalid action fields", async () => {
		const matchedEvents = Array.from({ length: 20 }, (_, eventId) => ({
			source: "timeline" as const,
			eventId,
			type: "comment",
		}));
		const f = fixture([
			watch({ state: "matched", matchedEvents, matchedTotal: 20 }),
			...Array.from({ length: 49 }, (_, index) =>
				watch({
					id: `watch-${index + 2}`,
					state: "matched",
					matchedEvents,
					matchedTotal: 20,
				}),
			),
		]);
		const listed = await f.tool.execute(
			"list",
			{ action: "list" },
			signal,
			undefined,
			context,
		);
		const listedText = listed.content[0]?.text ?? "";
		expect(JSON.parse(listedText).watches).toHaveLength(50);
		expect(Buffer.byteLength(listedText, "utf8")).toBeLessThanOrEqual(32_000);
		expect(listedText).not.toContain("matchedEvents");
		expect(data(listed)).toMatchObject({ detailsTruncated: true });

		const active = fixture([watch(), watch({ id: "watch-2" })]);
		expect(
			data(
				await active.tool.execute(
					"stop",
					{ action: "stop", id: "watch-1" },
					signal,
					undefined,
					context,
				),
			),
		).toMatchObject({
			id: "watch-1",
			stopped: true,
		});
		expect(
			data(
				await active.tool.execute(
					"all",
					{ action: "stop", all: true },
					signal,
					undefined,
					context,
				),
			),
		).toMatchObject({
			stopped: 1,
			ids: ["watch-2"],
		});
		await expect(
			active.tool.execute(
				"xor",
				{ action: "stop", id: "watch-1", all: true },
				signal,
				undefined,
				context,
			),
		).rejects.toThrow("exactly one");
		await expect(
			active.tool.execute(
				"list-fields",
				{ action: "list", ref: "work:acme/app!9" },
				signal,
				undefined,
				context,
			),
		).rejects.toThrow("not valid for list");
	});

	it("requires a runtime and manager and validates start arguments", async () => {
		const f = fixture([]);
		await expect(
			f.tool.execute(
				"ref",
				{ action: "start", ref: "bad" },
				signal,
				undefined,
				context,
			),
		).rejects.toThrow("invalid Forgejo reference");
		await expect(
			f.tool.execute(
				"events",
				{ action: "start", ref: "work:acme/app!9", events: [] },
				signal,
				undefined,
				context,
			),
		).rejects.toThrow("at least one");
		await expect(
			f.tool.execute(
				"interval",
				{ action: "start", ref: "work:acme/app!9", interval_seconds: 1 },
				signal,
				undefined,
				context,
			),
		).rejects.toThrow("interval_seconds must be an integer from 30 to 3600");
		await expect(
			f.tool.execute(
				"issue-event",
				{ action: "start", ref: "work:acme/app#9", events: ["merged"] },
				signal,
				undefined,
				context,
			),
		).rejects.toThrow("only valid for pull-request watches");

		let captured: CapturedTool | undefined;
		registerWatchTool(
			{
				registerTool(definition: CapturedTool) {
					captured = definition;
				},
			} as unknown as ExtensionAPI,
			() => f.runtime,
			() => {
				throw new Error(
					"Forgejo watch manager is unavailable before session start",
				);
			},
		);
		if (!captured) throw new Error("watch tool was not registered");
		await expect(
			captured.execute("early", { action: "list" }, signal, undefined, context),
		).rejects.toThrow("unavailable before session start");
	});
});

describe("watch wake messages", () => {
	const adversarial: WatchEmission = {
		kind: "matched",
		watchId: "watch-1\nREMOTE ERROR",
		reference: "work:acme/app!9",
		filters: ["comment"],
		attention: "turn",
		note: "agent\n note\u0000 only",
		fetchSince: "2026-08-12T10:00:00Z",
		totalCount: 99,
		events: Array.from({ length: 25 }, (_, index) => ({
			source: "timeline" as const,
			eventId: index + 1,
			type: index === 0 ? "comment\nREMOTE BODY" : "comment",
			actor: index === 0 ? "attacker TITLE" : "bob",
			createdAt: "2026-08-12T10:01:00Z",
			updatedAt: "2026-08-12T10:01:30Z",
		})),
	};

	it("formats only bounded metadata and an exact updates call hint", () => {
		const message = formatWatchNotification(adversarial);
		expect(message.content).toContain("Forgejo watch matched: unknown");
		expect(message.content).toContain("Ref: fj://work/acme/app/pulls/9");
		expect(message.content).toContain("Events: 99");
		expect(message.content).toContain("Note: agent note only");
		expect(message.content).toContain(
			"Fetch updates: forgejo_pull action=updates ref=fj://work/acme/app/pulls/9 since=2026-08-12T10:00:00.000Z",
		);
		expect(message.content).not.toMatch(
			/REMOTE BODY|REMOTE ERROR|attacker TITLE/,
		);
		expect(message.details.events as unknown[]).toHaveLength(20);
	});

	it("uses steer/turn for attention and no trigger for context", () => {
		const sendMessage = vi.fn();
		const pi = { sendMessage } as unknown as ExtensionAPI;
		sendWatchNotification(pi, adversarial);
		expect(sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ customType: "forgejo-watch", display: true }),
			{ triggerTurn: true, deliverAs: "steer" },
		);

		sendWatchNotification(pi, {
			...adversarial,
			attention: "context",
			kind: "failed",
			error: { code: "auth", status: 401 },
		});
		expect(sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("Error: code=auth status=401"),
			}),
			{ triggerTurn: false },
		);
	});
});
