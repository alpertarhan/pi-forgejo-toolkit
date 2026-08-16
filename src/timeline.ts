import { createHash } from "node:crypto";
import type { ForgejoClient } from "./client.js";
import type { ForgejoTimelineEvent } from "./types.js";

const CURSOR_OVERLAP_MS = 5_000;
const MAX_REMEMBERED_EVENTS = 2_000;

export interface TimelineCursor {
	fetchedThrough: string;
	eventVersions: Map<number, string>;
}

export interface TimelineScan {
	events: ForgejoTimelineEvent[];
	pages: number;
	total?: number;
	complete: boolean;
	fetchedThrough: string;
}

function requestOptions(signal: AbortSignal | undefined): {
	signal?: AbortSignal;
} {
	return signal === undefined ? {} : { signal };
}

export function responseTimestamp(headers: Headers): string | undefined {
	const date = headers.get("date");
	if (date === null || !Number.isFinite(Date.parse(date))) return undefined;
	return new Date(date).toISOString();
}

function hasNextPage(headers: Headers): boolean {
	const link = headers.get("link");
	return (
		link !== null &&
		/(?:^|,)\s*<[^>]+>\s*;\s*rel="?next"?(?:\s*;|\s*(?:,|$))/i.test(link)
	);
}

export function normalizedTimestamp(value: string, name: string): string {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp))
		throw new Error(`${name} must be an RFC 3339 timestamp`);
	return new Date(timestamp).toISOString();
}

export function overlapTimestamp(value: string): string {
	return new Date(Date.parse(value) - CURSOR_OVERLAP_MS).toISOString();
}

export function timelineEventVersion(event: ForgejoTimelineEvent): string {
	const value = [
		event.updated_at,
		event.created_at,
		event.type,
		event.body ?? "",
		event.old_title ?? "",
		event.new_title ?? "",
		event.old_ref ?? "",
		event.new_ref ?? "",
		event.ref_commit_sha ?? "",
		event.label?.id ?? "",
		event.assignee?.id ?? "",
		event.removed_assignee ?? "",
		event.review_id ?? "",
	].join("\u0000");
	return createHash("sha256").update(value).digest("base64url");
}

export async function scanTimeline(
	client: ForgejoClient,
	path: string,
	since: string,
	before: string,
	pageLimit: number,
	maxPages: number,
	signal?: AbortSignal,
): Promise<TimelineScan> {
	const byId = new Map<number, ForgejoTimelineEvent>();
	let total: number | undefined;
	let complete = false;
	let pages = 0;
	for (let page = 1; page <= maxPages; page += 1) {
		const response = await client.request<ForgejoTimelineEvent[]>(path, {
			...requestOptions(signal),
			query: { page, limit: pageLimit, since, before },
		});
		pages = page;
		if (response.totalCount !== undefined) total = response.totalCount;
		// Forgejo marshals an empty timeline as JSON null (Go nil slice), not []
		const pageEvents = response.data ?? [];
		for (const event of pageEvents) byId.set(event.id, event);
		const hasMore =
			hasNextPage(response.headers) || pageEvents.length === pageLimit;
		if (hasMore) continue;
		complete = true;
		break;
	}
	const events = [...byId.values()].sort((left, right) => {
		const timestampOrder =
			Date.parse(left.created_at) - Date.parse(right.created_at);
		return timestampOrder || left.id - right.id;
	});
	const result: TimelineScan = {
		events,
		pages,
		complete,
		fetchedThrough: before,
	};
	if (total !== undefined) result.total = total;
	return result;
}

export function newTimelineEvents(
	events: ForgejoTimelineEvent[],
	cursor: TimelineCursor | undefined,
): ForgejoTimelineEvent[] {
	return events.filter(
		(event) =>
			cursor?.eventVersions.get(event.id) !== timelineEventVersion(event),
	);
}

export function nextTimelineCursor(
	fetchedThrough: string,
	previous: TimelineCursor | undefined,
	events: ForgejoTimelineEvent[],
): TimelineCursor {
	const eventVersions = new Map(previous?.eventVersions ?? []);
	for (const event of events) {
		eventVersions.delete(event.id);
		eventVersions.set(event.id, timelineEventVersion(event));
	}
	while (eventVersions.size > MAX_REMEMBERED_EVENTS) {
		const oldest = eventVersions.keys().next().value;
		if (oldest === undefined) break;
		eventVersions.delete(oldest);
	}
	return { fetchedThrough, eventVersions };
}
