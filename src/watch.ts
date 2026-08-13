import { apiPath, ForgejoError, type ForgejoClient } from "./client.js";
import { formatResourceRef } from "./refs.js";
import {
	newTimelineEvents,
	nextTimelineCursor,
	normalizedTimestamp,
	overlapTimestamp,
	responseTimestamp,
	scanTimeline,
	type TimelineCursor,
} from "./timeline.js";
import type {
	ForgejoIssue,
	ForgejoPullRequest,
	ForgejoTimelineEvent,
	ForgejoUser,
	ResourceRef,
} from "./types.js";

export type WatchFilter =
	| "feedback"
	| "comment"
	| "review_comment"
	| "review"
	| "review_request"
	| "closed"
	| "reopened"
	| "merged"
	| "push"
	| "any";
export type WatchAttention = "turn" | "context";
export type EventWatchState =
	| "active"
	| "matched"
	| "stopped"
	| "timed-out"
	| "failed";

export interface WatchEventMetadata {
	source: "timeline" | "resource";
	eventId?: number;
	type: string;
	actor?: string;
	reviewId?: number;
	createdAt?: string;
	updatedAt?: string;
}

export interface WatchErrorMetadata {
	code:
		| "auth"
		| "forbidden"
		| "not-found"
		| "conflict"
		| "rate-limit"
		| "http"
		| "network"
		| "redirect"
		| "incomplete"
		| "internal";
	status?: number;
}

export interface EventWatch {
	id: string;
	reference: string;
	ref: ResourceRef;
	filters: WatchFilter[];
	includeSelf: boolean;
	attention: WatchAttention;
	note?: string;
	state: EventWatchState;
	createdAt: string;
	pollIntervalMs: number;
	timeoutMs?: number;
	nextPollAt?: string;
	expiresAt?: string;
	failures: number;
	lastError?: WatchErrorMetadata;
	deliveryFailed?: boolean;
	matchedAt?: string;
	matchedEvents?: WatchEventMetadata[];
	matchedTotal?: number;
}

export interface ArmWatchOptions {
	ref: ResourceRef;
	filters?: WatchFilter[];
	events?: WatchFilter[];
	includeSelf?: boolean;
	attention?: WatchAttention;
	note?: string;
	since?: string;
	pollIntervalMs?: number;
	timeoutMs?: number;
	pageLimit?: number;
	maxPages?: number;
	signal?: AbortSignal;
}

interface WatchEmissionBase {
	watchId: string;
	reference: string;
	filters: WatchFilter[];
	attention: WatchAttention;
	note?: string;
	fetchSince: string;
}

export type WatchEmission =
	| (WatchEmissionBase & {
			kind: "matched";
			events: WatchEventMetadata[];
			totalCount: number;
	  })
	| (WatchEmissionBase & { kind: "timed-out" })
	| (WatchEmissionBase & { kind: "failed"; error: WatchErrorMetadata });

type WatchEmitter = (emission: WatchEmission) => void;
type ClientProvider = (server: string) => ForgejoClient;

interface ActiveWatch extends EventWatch {
	key: string;
	client: ForgejoClient;
	currentPath: string;
	timelinePath: string;
	cursor: TimelineCursor;
	fetchSince: string;
	selfLogin?: string;
	lastState: string;
	lastMerged: boolean;
	pageLimit: number;
	maxPages: number;
	nextPollTime?: number;
	expiresTime?: number;
	inFlight: boolean;
	controller: AbortController;
}

const FILTER_ORDER: WatchFilter[] = [
	"feedback",
	"comment",
	"review_comment",
	"review",
	"review_request",
	"closed",
	"reopened",
	"merged",
	"push",
	"any",
];
const FILTERS = new Set(FILTER_ORDER);
const DEFAULT_POLL_MS = 60_000;
const MAX_POLL_MS = 60 * 60_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_ACTIVE = 20;
const MAX_HISTORY = 50;
const MAX_EMITTED_EVENTS = 20;

function positive(
	value: number | undefined,
	fallback: number,
	name: string,
	maximum: number,
): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
		throw new Error(`${name} must be an integer from 1 to ${maximum}`);
	return result;
}

function normalizeFilters(options: ArmWatchOptions): WatchFilter[] {
	if (options.filters !== undefined && options.events !== undefined)
		throw new Error("provide filters or events, not both");
	const input = options.filters ?? options.events;
	if (!input?.length) throw new Error("at least one watch filter is required");
	for (const filter of input)
		if (!FILTERS.has(filter))
			throw new Error(`unsupported watch filter '${filter}'`);
	const selected = new Set(input);
	return FILTER_ORDER.filter((filter) => selected.has(filter));
}

function normalizedNote(note: string | undefined): string | undefined {
	if (note === undefined) return undefined;
	if (note.length > 500) throw new Error("note must be at most 500 characters");
	return safeNote(note);
}

function safeNote(note: string): string {
	return note
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function unref(timer: ReturnType<typeof setTimeout>): void {
	if (typeof timer === "object" && "unref" in timer) timer.unref();
}

function eventMatches(
	filter: WatchFilter,
	event: ForgejoTimelineEvent,
): boolean {
	if (filter === "any") return true;
	if (filter === "feedback")
		return (
			event.type === "comment" ||
			event.type === "code" ||
			event.type === "review"
		);
	if (filter === "comment") return event.type === "comment";
	if (filter === "review_comment")
		return event.type === "code" && event.review_id !== undefined;
	if (filter === "review") return event.type === "review";
	if (filter === "review_request") return event.type === "review_request";
	if (filter === "closed") return event.type === "close";
	if (filter === "reopened") return event.type === "reopen";
	if (filter === "merged") return event.type === "merge_pull";
	return event.type === "pull_push";
}

function safeToken(value: string | undefined): string | undefined {
	return value !== undefined && /^[A-Za-z0-9._:-]{1,64}$/.test(value)
		? value
		: undefined;
}

function safeTimestamp(value: string | undefined): string | undefined {
	if (value === undefined || !Number.isFinite(Date.parse(value)))
		return undefined;
	return new Date(value).toISOString();
}

function safeEvent(event: ForgejoTimelineEvent): WatchEventMetadata {
	const metadata: WatchEventMetadata = {
		source: "timeline",
		eventId: event.id,
		type: safeToken(event.type) ?? "unknown",
	};
	const actor = safeToken(event.user?.login);
	const createdAt = safeTimestamp(event.created_at);
	const updatedAt = safeTimestamp(event.updated_at);
	if (actor !== undefined) metadata.actor = actor;
	if (event.review_id !== undefined) metadata.reviewId = event.review_id;
	if (createdAt !== undefined) metadata.createdAt = createdAt;
	if (updatedAt !== undefined) metadata.updatedAt = updatedAt;
	return metadata;
}

function safeError(error: unknown, incomplete = false): WatchErrorMetadata {
	if (incomplete) return { code: "incomplete" };
	if (!(error instanceof ForgejoError)) return { code: "internal" };
	return {
		code: error.code,
		...(error.status === undefined ? {} : { status: error.status }),
	};
}

function isTransient(error: unknown): boolean {
	return (
		error instanceof ForgejoError &&
		(error.code === "network" ||
			error.code === "rate-limit" ||
			(error.status !== undefined && error.status >= 500))
	);
}

function resourcePaths(ref: ResourceRef): {
	currentPath: string;
	timelinePath: string;
} {
	const issue = apiPath("repos", ref.owner, ref.repo, "issues", ref.index);
	return {
		currentPath:
			ref.kind === "pull"
				? apiPath("repos", ref.owner, ref.repo, "pulls", ref.index)
				: issue,
		timelinePath: `${issue}/timeline`,
	};
}

export class WatchManager {
	private readonly watches = new Map<string, ActiveWatch>();
	private nextId = 1;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(
		private readonly clientFor: ClientProvider,
		private readonly emit: WatchEmitter,
	) {}

	async arm(options: ArmWatchOptions): Promise<EventWatch> {
		if (this.closed) throw new Error("watch manager is closed");
		const filters = normalizeFilters(options);
		const pollIntervalMs = positive(
			options.pollIntervalMs,
			DEFAULT_POLL_MS,
			"pollIntervalMs",
			MAX_POLL_MS,
		);
		const timeoutMs =
			options.timeoutMs === undefined
				? undefined
				: positive(options.timeoutMs, 0, "timeoutMs", MAX_TIMEOUT_MS);
		const pageLimit = positive(
			options.pageLimit,
			50,
			"pageLimit",
			MAX_PAGE_LIMIT,
		);
		const maxPages = positive(options.maxPages, 20, "maxPages", MAX_PAGES);
		const includeSelf = options.includeSelf ?? false;
		const attention = options.attention ?? "turn";
		if (attention !== "turn" && attention !== "context")
			throw new Error(`unsupported attention '${String(attention)}'`);
		const note = normalizedNote(options.note);
		const since =
			options.since === undefined
				? undefined
				: normalizedTimestamp(options.since, "since");
		const reference = formatResourceRef(options.ref);
		const key = JSON.stringify({
			reference,
			filters,
			includeSelf,
			attention,
			note,
			since,
			pollIntervalMs,
			timeoutMs,
			pageLimit,
			maxPages,
		});
		const duplicate = this.activeByKey(key);
		if (duplicate) return this.publicInfo(duplicate);
		if (this.activeCount() >= MAX_ACTIVE)
			throw new Error(`at most ${MAX_ACTIVE} active watches are allowed`);

		const client = this.clientFor(options.ref.server);
		const { currentPath, timelinePath } = resourcePaths(options.ref);
		const startedAt = new Date().toISOString();
		const requestOptions =
			options.signal === undefined ? {} : { signal: options.signal };
		const [currentResponse, selfLogin] = await Promise.all([
			client.request<ForgejoIssue | ForgejoPullRequest>(
				currentPath,
				requestOptions,
			),
			includeSelf
				? Promise.resolve(undefined)
				: client
						.request<ForgejoUser>("user", requestOptions)
						.then((result) => result.data.login),
		]);
		const scanBefore = responseTimestamp(currentResponse.headers) ?? startedAt;
		const scanSince = since ?? overlapTimestamp(scanBefore);
		const scan = await scanTimeline(
			client,
			timelinePath,
			scanSince,
			scanBefore,
			pageLimit,
			maxPages,
			options.signal,
		);
		if (!scan.complete)
			throw new Error(`timeline baseline incomplete after ${maxPages} pages`);
		if (this.closed) throw new Error("watch manager is closed");

		const racedDuplicate = this.activeByKey(key);
		if (racedDuplicate) return this.publicInfo(racedDuplicate);
		if (this.activeCount() >= MAX_ACTIVE)
			throw new Error(`at most ${MAX_ACTIVE} active watches are allowed`);

		const now = Date.now();
		const current = currentResponse.data;
		const fetchedThrough = scan.fetchedThrough;
		const watch: ActiveWatch = {
			id: `watch-${this.nextId++}`,
			key,
			reference,
			ref: options.ref,
			filters,
			includeSelf,
			attention,
			...(note === undefined ? {} : { note }),
			state: "active",
			createdAt: startedAt,
			pollIntervalMs,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			nextPollAt: new Date(now + pollIntervalMs).toISOString(),
			...(timeoutMs === undefined
				? {}
				: { expiresAt: new Date(now + timeoutMs).toISOString() }),
			failures: 0,
			client,
			currentPath,
			timelinePath,
			cursor: nextTimelineCursor(fetchedThrough, undefined, scan.events),
			fetchSince: scanSince,
			...(selfLogin === undefined ? {} : { selfLogin }),
			lastState: current.state,
			lastMerged: "merged" in current && current.merged === true,
			pageLimit,
			maxPages,
			nextPollTime: now + pollIntervalMs,
			...(timeoutMs === undefined ? {} : { expiresTime: now + timeoutMs }),
			inFlight: false,
			controller: new AbortController(),
		};
		this.watches.set(watch.id, watch);

		const initial =
			since === undefined
				? this.currentLevelMatches(watch.filters, current)
				: [
						...this.matchingEvents(watch, scan.events),
						...this.currentLevelMatches(watch.filters, current),
					];
		if (initial.length > 0) this.finishMatched(watch, initial, false);
		else this.schedule();
		return this.publicInfo(watch);
	}

	list(): EventWatch[] {
		return [...this.watches.values()].map((watch) => this.publicInfo(watch));
	}

	stop(id: string): boolean {
		const watch = this.watches.get(id);
		if (!watch || watch.state !== "active") return false;
		watch.state = "stopped";
		delete watch.nextPollTime;
		delete watch.nextPollAt;
		watch.controller.abort();
		this.prune();
		this.schedule();
		return true;
	}

	close(): void {
		this.closed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		for (const watch of this.watches.values()) {
			if (watch.state === "active") watch.state = "stopped";
			watch.controller.abort();
			delete watch.nextPollTime;
			delete watch.nextPollAt;
		}
		this.prune();
	}

	private activeByKey(key: string): ActiveWatch | undefined {
		return [...this.watches.values()].find(
			(watch) => watch.state === "active" && watch.key === key,
		);
	}

	private activeCount(): number {
		return [...this.watches.values()].filter(
			(watch) => watch.state === "active",
		).length;
	}

	private schedule(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.closed) return;
		let due: number | undefined;
		for (const watch of this.watches.values()) {
			if (watch.state !== "active") continue;
			if (watch.expiresTime !== undefined)
				due = Math.min(due ?? watch.expiresTime, watch.expiresTime);
			if (!watch.inFlight && watch.nextPollTime !== undefined)
				due = Math.min(due ?? watch.nextPollTime, watch.nextPollTime);
		}
		if (due === undefined) return;
		this.timer = setTimeout(() => this.tick(), Math.max(0, due - Date.now()));
		unref(this.timer);
	}

	private tick(): void {
		this.timer = undefined;
		const now = Date.now();
		for (const watch of this.watches.values()) {
			if (watch.state !== "active") continue;
			if (watch.expiresTime !== undefined && watch.expiresTime <= now) {
				this.finishTimeout(watch);
			} else if (
				!watch.inFlight &&
				watch.nextPollTime !== undefined &&
				watch.nextPollTime <= now
			) {
				watch.inFlight = true;
				delete watch.nextPollTime;
				delete watch.nextPollAt;
				void this.poll(watch);
			}
		}
		this.schedule();
	}

	private async poll(watch: ActiveWatch): Promise<void> {
		const localBefore = new Date().toISOString();
		const fetchSince = overlapTimestamp(watch.cursor.fetchedThrough);
		watch.fetchSince = fetchSince;
		const pollController = new AbortController();
		const abortPoll = (): void =>
			pollController.abort(watch.controller.signal.reason);
		if (watch.controller.signal.aborted) abortPoll();
		else
			watch.controller.signal.addEventListener("abort", abortPoll, {
				once: true,
			});
		try {
			const currentResponse = await watch.client.request<
				ForgejoIssue | ForgejoPullRequest
			>(watch.currentPath, { signal: pollController.signal });
			const before = responseTimestamp(currentResponse.headers) ?? localBefore;
			const scan = await scanTimeline(
				watch.client,
				watch.timelinePath,
				fetchSince,
				before,
				watch.pageLimit,
				watch.maxPages,
				pollController.signal,
			);
			if (watch.state !== "active") return;
			if (!scan.complete) {
				this.finishFailure(watch, safeError(undefined, true));
				return;
			}
			const events = newTimelineEvents(scan.events, watch.cursor);
			const timelineMatches = this.matchingEvents(watch, events);
			const timelineTransitionTypes = new Set(
				events
					.filter(
						(event) =>
							event.type === "close" ||
							event.type === "reopen" ||
							event.type === "merge_pull",
					)
					.map((event) => event.type),
			);
			const resourceMatches = this.transitionLevelMatches(
				watch,
				currentResponse.data,
			).filter((event) => !timelineTransitionTypes.has(event.type));
			const matches = [...timelineMatches, ...resourceMatches];
			watch.cursor = nextTimelineCursor(
				scan.fetchedThrough,
				watch.cursor,
				scan.events,
			);
			watch.lastState = currentResponse.data.state;
			watch.lastMerged =
				"merged" in currentResponse.data &&
				currentResponse.data.merged === true;
			watch.failures = 0;
			delete watch.lastError;
			if (matches.length > 0) this.finishMatched(watch, matches, true);
			else this.nextPoll(watch, watch.pollIntervalMs);
		} catch (error) {
			if (watch.state !== "active" || watch.controller.signal.aborted) return;
			const metadata = safeError(error);
			watch.lastError = metadata;
			if (!isTransient(error)) this.finishFailure(watch, metadata);
			else {
				watch.failures += 1;
				this.nextPoll(
					watch,
					Math.min(watch.pollIntervalMs * 2 ** watch.failures, MAX_BACKOFF_MS),
				);
			}
		} finally {
			watch.controller.signal.removeEventListener("abort", abortPoll);
			pollController.abort();
			watch.inFlight = false;
			this.schedule();
		}
	}

	private nextPoll(watch: ActiveWatch, delay: number): void {
		const next = Date.now() + delay;
		watch.nextPollTime = next;
		watch.nextPollAt = new Date(next).toISOString();
	}

	private matchingEvents(
		watch: ActiveWatch,
		events: ForgejoTimelineEvent[],
	): WatchEventMetadata[] {
		return events
			.filter(
				(event) =>
					watch.filters.some((filter) => eventMatches(filter, event)) &&
					(watch.includeSelf ||
						event.user?.login?.toLowerCase() !==
							watch.selfLogin?.toLowerCase()),
			)
			.map(safeEvent);
	}

	private transitionLevelMatches(
		watch: ActiveWatch,
		current: ForgejoIssue | ForgejoPullRequest,
	): WatchEventMetadata[] {
		const merged = "merged" in current && current.merged === true;
		if (watch.filters.includes("merged") && !watch.lastMerged && merged) {
			const mergedBy =
				"merged_by" in current ? current.merged_by?.login : undefined;
			if (
				watch.includeSelf ||
				mergedBy?.toLowerCase() !== watch.selfLogin?.toLowerCase()
			) {
				return [this.resourceEvent("merge_pull", current.updated_at, mergedBy)];
			}
			return [];
		}
		if (
			watch.filters.includes("closed") &&
			watch.lastState !== "closed" &&
			current.state === "closed"
		) {
			return [this.resourceEvent("close", current.updated_at)];
		}
		if (
			watch.filters.includes("reopened") &&
			watch.lastState === "closed" &&
			current.state === "open"
		) {
			return [this.resourceEvent("reopen", current.updated_at)];
		}
		return [];
	}

	private currentLevelMatches(
		filters: WatchFilter[],
		current: ForgejoIssue | ForgejoPullRequest,
	): WatchEventMetadata[] {
		const merged = "merged" in current && current.merged === true;
		if (filters.includes("merged") && merged)
			return [this.resourceEvent("merge_pull", current.updated_at)];
		if (filters.includes("closed") && current.state === "closed")
			return [this.resourceEvent("close", current.updated_at)];
		return [];
	}

	private resourceEvent(
		type: string,
		timestamp: string,
		actor?: string,
	): WatchEventMetadata {
		const event: WatchEventMetadata = { source: "resource", type };
		const safeActor = safeToken(actor);
		if (safeActor !== undefined) event.actor = safeActor;
		const safe = safeTimestamp(timestamp);
		if (safe !== undefined) {
			event.createdAt = safe;
			event.updatedAt = safe;
		}
		return event;
	}

	private finishMatched(
		watch: ActiveWatch,
		events: WatchEventMetadata[],
		emit: boolean,
	): void {
		watch.state = "matched";
		watch.matchedAt = new Date().toISOString();
		watch.matchedEvents = events.slice(0, MAX_EMITTED_EVENTS);
		watch.matchedTotal = events.length;
		this.finish(watch);
		if (emit)
			this.deliver(
				{
					...this.emissionBase(watch),
					kind: "matched",
					events: watch.matchedEvents,
					totalCount: events.length,
				},
				watch,
			);
	}

	private finishTimeout(watch: ActiveWatch): void {
		watch.state = "timed-out";
		this.finish(watch);
		this.deliver({ ...this.emissionBase(watch), kind: "timed-out" }, watch);
	}

	private finishFailure(watch: ActiveWatch, error: WatchErrorMetadata): void {
		watch.state = "failed";
		watch.lastError = error;
		this.finish(watch);
		this.deliver({ ...this.emissionBase(watch), kind: "failed", error }, watch);
	}

	private finish(watch: ActiveWatch): void {
		delete watch.nextPollTime;
		delete watch.nextPollAt;
		watch.controller.abort();
		this.prune();
	}

	private emissionBase(watch: ActiveWatch): WatchEmissionBase {
		return {
			watchId: watch.id,
			reference: watch.reference,
			filters: [...watch.filters],
			attention: watch.attention,
			...(watch.note === undefined ? {} : { note: watch.note }),
			fetchSince: watch.fetchSince,
		};
	}

	private deliver(emission: WatchEmission, watch: ActiveWatch): void {
		try {
			this.emit(emission);
		} catch {
			watch.deliveryFailed = true;
		}
	}

	private prune(): void {
		const terminal = [...this.watches.values()].filter(
			(watch) => watch.state !== "active",
		);
		for (const watch of terminal.slice(
			0,
			Math.max(0, terminal.length - MAX_HISTORY),
		))
			this.watches.delete(watch.id);
	}

	private publicInfo(watch: ActiveWatch): EventWatch {
		const {
			id,
			reference,
			ref,
			filters,
			includeSelf,
			attention,
			note,
			state,
			createdAt,
			pollIntervalMs,
			timeoutMs,
			nextPollAt,
			expiresAt,
			failures,
			lastError,
			deliveryFailed,
			matchedAt,
			matchedEvents,
			matchedTotal,
		} = watch;
		return {
			id,
			reference,
			ref,
			filters: [...filters],
			includeSelf,
			attention,
			state,
			createdAt,
			pollIntervalMs,
			failures,
			...(note === undefined ? {} : { note }),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			...(nextPollAt === undefined ? {} : { nextPollAt }),
			...(expiresAt === undefined ? {} : { expiresAt }),
			...(lastError === undefined ? {} : { lastError }),
			...(deliveryFailed === undefined ? {} : { deliveryFailed }),
			...(matchedAt === undefined ? {} : { matchedAt }),
			...(matchedEvents === undefined
				? {}
				: { matchedEvents: [...matchedEvents] }),
			...(matchedTotal === undefined ? {} : { matchedTotal }),
		};
	}
}
