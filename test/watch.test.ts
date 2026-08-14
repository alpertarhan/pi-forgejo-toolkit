import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ForgejoError,
	type ForgejoClient,
	type RequestOptions,
} from "../src/client.js";
import type {
	ApiResult,
	ForgejoTimelineEvent,
	ResourceRef,
} from "../src/types.js";
import { WatchManager, type WatchEmission } from "../src/watch.js";

const ref: ResourceRef = {
	server: "work",
	owner: "acme",
	repo: "app",
	kind: "pull",
	index: 9,
};
const now = "2026-08-12T10:00:00.000Z";

function result<T>(
	data: T,
	options: { total?: number; date?: string; link?: string } = {},
): ApiResult<T> {
	const headers = new Headers();
	if (options.date) headers.set("date", options.date);
	if (options.link) headers.set("link", options.link);
	const value: ApiResult<T> = { data, status: 200, headers };
	if (options.total !== undefined) value.totalCount = options.total;
	return value;
}

function current(overrides: Record<string, unknown> = {}) {
	return {
		id: 9,
		number: 9,
		title: "REMOTE TITLE",
		state: "open",
		updated_at: now,
		merged: false,
		...overrides,
	};
}

function event(
	id: number,
	type = "comment",
	actor = "bob",
	body = "REMOTE SECRET",
): ForgejoTimelineEvent {
	return {
		id,
		type,
		body,
		user: { id, login: actor },
		created_at: now,
		updated_at: now,
	};
}

function fixture(polls: ForgejoTimelineEvent[][] = []) {
	let timelineCall = 0;
	const request = vi.fn(async (path: string) => {
		if (path === "user") return result({ id: 1, login: "alice" });
		if (path.endsWith("/timeline"))
			return result(timelineCall++ === 0 ? [] : (polls.shift() ?? []));
		return result(current());
	});
	const emissions: WatchEmission[] = [];
	const manager = new WatchManager(
		() => ({ request }) as unknown as ForgejoClient,
		(value) => {
			emissions.push(value);
		},
	);
	return { manager, request, emissions };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("WatchManager", () => {
	it("seeds the overlap baseline and emits bounded one-shot metadata", async () => {
		const baseline = event(1);
		const matches = Array.from({ length: 25 }, (_, index) => event(index + 2));
		let timelineCall = 0;
		const request = vi.fn(async (path: string, options?: RequestOptions) => {
			if (path === "user") return result({ id: 1, login: "alice" });
			if (path.endsWith("/timeline")) {
				timelineCall += 1;
				if (timelineCall === 1) {
					expect(options?.query).toMatchObject({
						since: "2026-08-12T09:59:55.000Z",
						before: now,
					});
					return result([baseline]);
				}
				return result([baseline, ...matches]);
			}
			return result(current());
		});
		const emissions: WatchEmission[] = [];
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			(value) => {
				emissions.push(value);
			},
		);
		const armed = await manager.arm({
			ref,
			filters: ["comment"],
			pollIntervalMs: 100,
			note: "check feedback",
			attention: "context",
		});

		expect(armed.state).toBe("active");
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(100);

		expect(manager.list()[0]).toMatchObject({
			state: "matched",
			matchedTotal: 25,
		});
		expect(emissions).toHaveLength(1);
		expect(emissions[0]).toMatchObject({
			kind: "matched",
			filters: ["comment"],
			totalCount: 25,
			attention: "context",
			note: "check feedback",
			fetchSince: "2026-08-12T09:59:55.000Z",
		});
		if (emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(emissions[0].events).toHaveLength(20);
		expect(emissions[0].events[0]).toMatchObject({
			source: "timeline",
			eventId: 2,
			type: "comment",
			actor: "bob",
		});
		expect(JSON.stringify(emissions)).not.toMatch(/REMOTE SECRET|REMOTE TITLE/);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses the Forgejo response clock so local clock skew cannot hide events", async () => {
		const localNow = "2026-08-12T10:10:00.000Z";
		const serverNow = "2026-08-12T10:00:00.000Z";
		vi.setSystemTime(localNow);
		let timelineCall = 0;
		const request = vi.fn(async (path: string) => {
			if (path === "user") return result({ id: 1, login: "alice" });
			if (path.endsWith("/timeline")) {
				timelineCall += 1;
				return result(timelineCall === 1 ? [] : [event(2)], {
					date: serverNow,
				});
			}
			return result(current(), { date: serverNow });
		});
		const emissions: WatchEmission[] = [];
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			(value) => emissions.push(value),
		);
		await manager.arm({ ref, filters: ["comment"], pollIntervalMs: 100 });

		await vi.advanceTimersByTimeAsync(100);

		expect(emissions[0]).toMatchObject({ kind: "matched" });
		expect(manager.list()[0]).toMatchObject({ state: "matched" });
	});

	it("advances a complete timeline only through the queried upper bound", async () => {
		const { scanTimeline } = await import("../src/timeline.js");
		const before = "2026-08-12T10:00:00.000Z";
		const request = vi.fn(async () =>
			result([], { date: "2026-08-12T10:00:20.000Z" }),
		);
		const scan = await scanTimeline(
			{ request } as unknown as ForgejoClient,
			"repos/acme/app/issues/9/timeline",
			"2026-08-12T09:59:55.000Z",
			before,
			50,
			1,
		);
		expect(scan).toMatchObject({ complete: true, fetchedThrough: before });
	});

	it("follows pagination metadata even when Forgejo clamps the requested limit", async () => {
		const pageOne = Array.from({ length: 20 }, (_, index) => event(index + 1));
		const pageTwo = [event(21)];
		let timelineCall = 0;
		const request = vi.fn(async (path: string, options?: RequestOptions) => {
			if (path === "user") return result({ id: 1, login: "alice" });
			if (path.endsWith("/timeline")) {
				timelineCall += 1;
				if (timelineCall === 1) {
					return result(pageOne, {
						total: 21,
						link: '<https://work.example/api/v1/timeline?page=2>; rel="next"',
					});
				}
				expect(options?.query?.page).toBe(2);
				return result(pageTwo, { total: 21 });
			}
			return result(current());
		});
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			vi.fn(),
		);

		await manager.arm({ ref, filters: ["comment"], pageLimit: 50 });

		expect(timelineCall).toBe(2);
		manager.close();
	});

	it("does not let an unfiltered total count force an extra timeline page", async () => {
		const { scanTimeline } = await import("../src/timeline.js");
		const request = vi.fn(async () => result([event(1)], { total: 50_000 }));
		const scan = await scanTimeline(
			{ request } as unknown as ForgejoClient,
			"repos/acme/app/issues/9/timeline",
			"2026-08-12T09:59:55.000Z",
			"2026-08-12T10:00:00.000Z",
			50,
			3,
		);
		expect(scan).toMatchObject({ complete: true, pages: 1, total: 50_000 });
		expect(request).toHaveBeenCalledOnce();
	});

	it("normalizes agent notes and keeps only fixed-size timeline fingerprints", async () => {
		const f = fixture();
		const armed = await f.manager.arm({
			ref,
			filters: ["comment"],
			note: " agent\n authored\u0000 note ",
		});

		expect(armed.note).toBe("agent authored note");
		const internal = f.manager as unknown as {
			watches: Map<string, { cursor: { eventVersions: Map<number, string> } }>;
		};
		for (const version of internal.watches
			.get(armed.id)
			?.cursor.eventVersions.values() ?? []) {
			expect(version).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(version).not.toContain("REMOTE");
		}
		f.manager.close();
	});

	it("supports normalized multi-filter alternatives and self filtering", async () => {
		const f = fixture([
			[
				event(2, "comment", "ALICE"),
				{ ...event(3, "code"), review_id: 42 },
				event(4, "review_request"),
			],
		]);
		const watch = await f.manager.arm({
			ref,
			filters: ["review_request", "review_comment", "review_request"],
			pollIntervalMs: 100,
		});
		expect(watch.filters).toEqual(["review_comment", "review_request"]);

		await vi.advanceTimersByTimeAsync(100);

		if (f.emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(f.emissions[0].events).toEqual([
			{
				source: "timeline",
				eventId: 3,
				type: "code",
				actor: "bob",
				reviewId: 42,
				createdAt: now,
				updatedAt: now,
			},
			{
				source: "timeline",
				eventId: 4,
				type: "review_request",
				actor: "bob",
				createdAt: now,
				updatedAt: now,
			},
		]);
	});

	it("does not share abort-coupled login requests between concurrent arms", async () => {
		const loginSignals: AbortSignal[] = [];
		const request = vi.fn(async (path: string, options?: RequestOptions) => {
			if (path === "user") {
				if (options?.signal) loginSignals.push(options.signal);
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 10);
					options?.signal?.addEventListener("abort", () => {
						clearTimeout(timer);
						reject(options.signal?.reason);
					});
				});
				return result({ id: 1, login: "alice" });
			}
			if (path.endsWith("/timeline")) return result([]);
			return result(current());
		});
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			vi.fn(),
		);
		const firstController = new AbortController();
		const secondController = new AbortController();
		const first = manager.arm({
			ref,
			filters: ["comment"],
			signal: firstController.signal,
		});
		const firstResult = expect(first).rejects.toThrow("cancelled");
		const second = manager.arm({
			ref: { ...ref, index: 10 },
			filters: ["comment"],
			signal: secondController.signal,
		});
		await Promise.resolve();
		firstController.abort(new Error("cancelled"));
		await vi.advanceTimersByTimeAsync(10);

		await firstResult;
		await expect(second).resolves.toMatchObject({ state: "active" });
		expect(loginSignals).toHaveLength(2);
		expect(loginSignals[0]).not.toBe(loginSignals[1]);
		manager.close();
	});

	it("deduplicates concurrent identical arms after independent network setup", async () => {
		const request = vi.fn(async (path: string) => {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			if (path === "user") return result({ id: 1, login: "alice" });
			if (path.endsWith("/timeline")) return result([]);
			return result(current());
		});
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			vi.fn(),
		);
		const first = manager.arm({ ref, events: ["comment", "review_request"] });
		const second = manager.arm({ ref, filters: ["review_request", "comment"] });
		await vi.advanceTimersByTimeAsync(10);
		await vi.advanceTimersByTimeAsync(10);
		const [left, right] = await Promise.all([first, second]);

		expect(left.id).toBe(right.id);
		expect(
			manager.list().filter((watch) => watch.state === "active"),
		).toHaveLength(1);
		manager.close();
	});

	it("aborts a pending timeline request when the sibling resource request fails", async () => {
		let timelineCalls = 0;
		let currentCalls = 0;
		let pendingSignal: AbortSignal | undefined;
		const request = vi.fn(
			(path: string, options?: RequestOptions): Promise<ApiResult<unknown>> => {
				if (path === "user")
					return Promise.resolve(result({ id: 1, login: "alice" }));
				if (path.endsWith("/timeline")) {
					timelineCalls += 1;
					if (timelineCalls === 1) return Promise.resolve(result([]));
					pendingSignal = options?.signal;
					return new Promise((_resolve, reject) =>
						options?.signal?.addEventListener("abort", () =>
							reject(options.signal?.reason),
						),
					);
				}
				currentCalls += 1;
				if (currentCalls === 1) return Promise.resolve(result(current()));
				return Promise.reject(
					new ForgejoError("offline", { server: "work", code: "network" }),
				);
			},
		);
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			vi.fn(),
		);
		await manager.arm({ ref, filters: ["comment"], pollIntervalMs: 100 });

		await vi.advanceTimersByTimeAsync(100);

		expect(timelineCalls).toBe(1);
		expect(pendingSignal).toBeUndefined();
		expect(manager.list()[0]).toMatchObject({ state: "active", failures: 1 });
		manager.close();
	});

	it("deduplicates timeline and resource transition signals", async () => {
		let timelineCalls = 0;
		let currentCalls = 0;
		const merged = event(7, "merge_pull");
		const request = vi.fn(async (path: string) => {
			if (path === "user") return result({ id: 1, login: "alice" });
			if (path.endsWith("/timeline"))
				return result(timelineCalls++ === 0 ? [] : [merged]);
			currentCalls += 1;
			return result(
				currentCalls === 1
					? current()
					: current({
							state: "closed",
							merged: true,
							merged_by: { id: 2, login: "bob" },
						}),
			);
		});
		const emissions: WatchEmission[] = [];
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			(value) => emissions.push(value),
		);
		await manager.arm({ ref, filters: ["merged"], pollIntervalMs: 100 });

		await vi.advanceTimersByTimeAsync(100);

		if (emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(emissions[0].events).toHaveLength(1);
		expect(emissions[0].events[0]).toMatchObject({
			source: "timeline",
			type: "merge_pull",
		});
	});

	it("suppresses a self-authored merge transition when includeSelf is false", async () => {
		let currentCalls = 0;
		const request = vi.fn(async (path: string) => {
			if (path === "user") return result({ id: 1, login: "alice" });
			if (path.endsWith("/timeline")) return result([]);
			currentCalls += 1;
			return result(
				currentCalls === 1
					? current()
					: current({
							state: "closed",
							merged: true,
							merged_by: { id: 1, login: "ALICE" },
						}),
			);
		});
		const emit = vi.fn();
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			emit,
		);
		await manager.arm({ ref, filters: ["merged"], pollIntervalMs: 100 });

		await vi.advanceTimersByTimeAsync(100);

		expect(manager.list()[0]).toMatchObject({ state: "active" });
		expect(emit).not.toHaveBeenCalled();
		manager.close();
	});

	it("returns already-satisfied state without emitting and uses synthetic ID namespace", async () => {
		const request = vi.fn(async (path: string) => {
			if (path === "user") return result({ id: 1, login: "alice" });
			if (path.endsWith("/timeline")) return result([]);
			return result(current({ state: "closed", merged: true }));
		});
		const emissions: WatchEmission[] = [];
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			(value) => {
				emissions.push(value);
			},
		);

		const watch = await manager.arm({ ref, filters: ["merged"] });

		expect(watch).toMatchObject({ state: "matched", matchedTotal: 1 });
		expect(watch.matchedEvents?.[0]).toEqual({
			source: "resource",
			type: "merge_pull",
			createdAt: now,
			updatedAt: now,
		});
		expect(watch.matchedEvents?.[0]).not.toHaveProperty("eventId");
		expect(emissions).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not emit for an initial since history match", async () => {
		const historical = event(6, "review");
		const request = vi.fn(async (path: string) => {
			if (path === "user") return result({ id: 1, login: "alice" });
			if (path.endsWith("/timeline")) return result([historical]);
			return result(current());
		});
		const emit = vi.fn();
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			emit,
		);

		const watch = await manager.arm({
			ref,
			filters: ["review"],
			since: "2026-08-12T09:00:00Z",
		});

		expect(watch).toMatchObject({ state: "matched", matchedTotal: 1 });
		expect(emit).not.toHaveBeenCalled();
	});

	it("uses one manager timer and timeout aborts a genuinely pending poll", async () => {
		let timelineCalls = 0;
		let pendingSignal: AbortSignal | undefined;
		const request = vi.fn(
			(path: string, options?: RequestOptions): Promise<ApiResult<unknown>> => {
				if (path === "user")
					return Promise.resolve(result({ id: 1, login: "alice" }));
				if (!path.endsWith("/timeline"))
					return Promise.resolve(result(current()));
				timelineCalls += 1;
				if (timelineCalls === 1) return Promise.resolve(result([]));
				pendingSignal = options?.signal;
				return new Promise((_resolve, reject) =>
					options?.signal?.addEventListener("abort", () =>
						reject(options.signal?.reason),
					),
				);
			},
		);
		const emissions: WatchEmission[] = [];
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			(value) => {
				emissions.push(value);
			},
		);
		await manager.arm({
			ref,
			filters: ["comment"],
			pollIntervalMs: 50,
			timeoutMs: 100,
		});
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(50);
		expect(pendingSignal?.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(50);

		expect(pendingSignal?.aborted).toBe(true);
		expect(manager.list()[0]?.state).toBe("timed-out");
		expect(emissions[0]).toMatchObject({
			kind: "timed-out",
			fetchSince: "2026-08-12T09:59:55.000Z",
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("backs off transient failures and emits safe permanent failures", async () => {
		let timelines = 0;
		const request = vi.fn(async (path: string) => {
			if (path === "user") return result({ id: 1, login: "alice" });
			if (!path.endsWith("/timeline")) return result(current());
			timelines += 1;
			if (timelines === 2)
				throw new ForgejoError("REMOTE ERROR BODY", {
					server: "work",
					status: 503,
					code: "http",
				});
			if (timelines === 3)
				throw new ForgejoError("REMOTE AUTH BODY", {
					server: "work",
					status: 401,
					code: "auth",
				});
			return result([]);
		});
		const emissions: WatchEmission[] = [];
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			(value) => {
				emissions.push(value);
			},
		);
		await manager.arm({ ref, filters: ["comment"], pollIntervalMs: 100 });

		await vi.advanceTimersByTimeAsync(100);
		expect(manager.list()[0]).toMatchObject({
			state: "active",
			failures: 1,
			lastError: { code: "http", status: 503 },
		});
		await vi.advanceTimersByTimeAsync(199);
		expect(timelines).toBe(2);
		await vi.advanceTimersByTimeAsync(1);

		expect(manager.list()[0]).toMatchObject({
			state: "failed",
			lastError: { code: "auth", status: 401 },
		});
		expect(emissions[0]).toMatchObject({
			kind: "failed",
			error: { code: "auth", status: 401 },
		});
		expect(JSON.stringify(emissions)).not.toContain("REMOTE");
	});

	it("keeps matched state when the synchronous emitter throws", async () => {
		const f = fixture([[event(2)]]);
		const manager = new WatchManager(
			() => ({ request: f.request }) as unknown as ForgejoClient,
			() => {
				throw new Error("send failed");
			},
		);
		const watch = await manager.arm({
			ref,
			filters: ["comment"],
			pollIntervalMs: 100,
		});

		await vi.advanceTimersByTimeAsync(100);

		expect(manager.list().find((item) => item.id === watch.id)).toMatchObject({
			state: "matched",
			deliveryFailed: true,
		});
	});

	it("prunes terminal history to the latest 50 watches", async () => {
		const request = vi.fn(async (path: string) => {
			if (path === "user") return result({ id: 1, login: "alice" });
			if (path.endsWith("/timeline")) return result([]);
			return result(current({ state: "closed" }));
		});
		const manager = new WatchManager(
			() => ({ request }) as unknown as ForgejoClient,
			vi.fn(),
		);
		for (let index = 1; index <= 51; index += 1) {
			await manager.arm({ ref: { ...ref, index }, filters: ["closed"] });
		}

		expect(manager.list()).toHaveLength(50);
		expect(manager.list()[0]?.id).toBe("watch-2");
	});

	it("keeps conversation state independent, stops silently, and enforces the active bound", async () => {
		const f = fixture();
		const cursor = new Map([["existing", "unchanged"]]);
		const watches = [];
		for (let index = 1; index <= 20; index += 1) {
			watches.push(
				await f.manager.arm({ ref: { ...ref, index }, filters: ["comment"] }),
			);
		}
		await expect(
			f.manager.arm({ ref: { ...ref, index: 21 }, filters: ["comment"] }),
		).rejects.toThrow("at most 20");
		expect(f.manager.stop(watches[0]?.id ?? "")).toBe(true);
		expect(f.emissions).toEqual([]);
		expect(cursor).toEqual(new Map([["existing", "unchanged"]]));
		f.manager.close();
		expect(f.emissions).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
