import { formatResourceRef } from "../refs.js";
import type { ConversationCursor, ForgejoRuntime } from "../runtime.js";
import {
	newTimelineEvents,
	nextTimelineCursor,
	normalizedTimestamp,
	overlapTimestamp,
	responseTimestamp,
	scanTimeline,
} from "../timeline.js";
import type {
	ForgejoIssue,
	ForgejoTimelineEvent,
	ResourceRef,
} from "../types.js";
import {
	boundModelTextWithSuffix,
	formatTimelineEvent,
	toolResult,
} from "./common.js";

export interface ConversationUpdateOptions<T extends ForgejoIssue> {
	currentPath: string;
	timelinePath: string;
	since?: string;
	pageLimit: number;
	maxPages: number;
	maximumBytes: number;
	signal?: AbortSignal;
	headSha?: (current: T) => string | undefined;
}

function requestOptions(signal: AbortSignal | undefined): {
	signal?: AbortSignal;
} {
	return signal === undefined ? {} : { signal };
}

function metadataChanges<T extends ForgejoIssue>(
	current: T,
	cursor: ConversationCursor | undefined,
	headSha: string | undefined,
): string[] {
	if (!cursor) return [];
	const changes: string[] = [];
	if (current.title !== cursor.lastTitle)
		changes.push(`Title: ${cursor.lastTitle} -> ${current.title}`);
	if (current.state !== cursor.lastState)
		changes.push(`State: ${cursor.lastState} -> ${current.state}`);
	if (
		headSha !== undefined &&
		cursor.lastHeadSha !== undefined &&
		headSha !== cursor.lastHeadSha
	) {
		changes.push(`Head SHA: ${cursor.lastHeadSha} -> ${headSha}`);
	}
	if (current.updated_at !== cursor.lastUpdatedAt)
		changes.push(`Updated: ${cursor.lastUpdatedAt} -> ${current.updated_at}`);
	return changes;
}

function nextCursor<T extends ForgejoIssue>(
	reference: string,
	fetchedThrough: string,
	current: T,
	previous: ConversationCursor | undefined,
	events: ForgejoTimelineEvent[],
	headSha: string | undefined,
): ConversationCursor {
	const timeline = nextTimelineCursor(fetchedThrough, previous, events);
	const cursor: ConversationCursor = {
		reference,
		...timeline,
		lastUpdatedAt: current.updated_at,
		lastState: current.state,
		lastTitle: current.title,
	};
	if (headSha !== undefined) cursor.lastHeadSha = headSha;
	return cursor;
}

export async function incrementalConversationUpdates<T extends ForgejoIssue>(
	runtime: ForgejoRuntime,
	ref: ResourceRef,
	options: ConversationUpdateOptions<T>,
): Promise<ReturnType<typeof toolResult>> {
	const reference = formatResourceRef(ref);
	const previous = runtime.conversationCursor(ref);
	const startedAt = new Date().toISOString();
	const client = runtime.client(ref.server);
	const currentResponse = await client.request<T>(
		options.currentPath,
		requestOptions(options.signal),
	);
	const current = currentResponse.data;
	const fetchedThrough =
		responseTimestamp(currentResponse.headers) ?? startedAt;

	if (!previous && options.since === undefined) {
		const headSha = options.headSha?.(current);
		const cursor = nextCursor(
			reference,
			fetchedThrough,
			current,
			undefined,
			[],
			headSha,
		);
		runtime.saveConversationCursor(ref, cursor);
		const lines = [
			`Initialized updates cursor for ${reference}`,
			`State: ${current.state}`,
			`Updated: ${current.updated_at}`,
			...(headSha ? [`Head SHA: ${headSha}`] : []),
			"No historical timeline events were fetched. Pass since on the first updates call to include history.",
		];
		return toolResult(lines.join("\n"), {
			reference,
			initialized: true,
			cursorAdvanced: true,
			cursor: {
				fetchedThrough: cursor.fetchedThrough,
				lastEventIds: [],
				lastUpdatedAt: cursor.lastUpdatedAt,
				lastHeadSha: cursor.lastHeadSha,
			},
			current,
			items: [],
		});
	}

	const since =
		options.since === undefined
			? overlapTimestamp(previous?.fetchedThrough ?? fetchedThrough)
			: normalizedTimestamp(options.since, "since");
	const scan = await scanTimeline(
		client,
		options.timelinePath,
		since,
		fetchedThrough,
		options.pageLimit,
		options.maxPages,
		options.signal,
	);
	const headSha = options.headSha?.(current);
	const changes = metadataChanges(current, previous, headSha);
	const newEvents = newTimelineEvents(scan.events, previous);
	const body = [
		`Updates for ${reference}`,
		...(changes.length > 0
			? ["", "Metadata changes:", ...changes.map((change) => `- ${change}`)]
			: []),
		...(newEvents.length > 0
			? ["", ...newEvents.map(formatTimelineEvent)]
			: ["", "No new timeline events"]),
	].join("\n");
	const footer = (truncated: boolean, cursorAdvanced: boolean): string =>
		[
			"",
			`Query since: ${since}`,
			`Fetched through: ${scan.fetchedThrough}`,
			`Pages scanned: ${scan.pages}`,
			`Events scanned: ${scan.events.length}`,
			`New events: ${newEvents.length}`,
			`Complete: ${scan.complete ? "yes" : "no"}`,
			`Truncated: ${truncated ? "yes" : "no"}`,
			`Cursor advanced: ${cursorAdvanced ? "yes" : "no"}`,
			...(!scan.complete
				? [
						`Recovery: narrow since or increase max_pages above ${options.maxPages}`,
					]
				: []),
			...(truncated
				? [
						"Recovery: repeat with a smaller limit, narrower since, or larger max_bytes",
					]
				: []),
		].join("\n");

	let cursorAdvanced = scan.complete;
	let bounded = boundModelTextWithSuffix(
		body,
		`\n${footer(false, cursorAdvanced)}`,
		options.maximumBytes,
	);
	if (bounded.truncated) {
		cursorAdvanced = false;
		bounded = boundModelTextWithSuffix(
			body,
			`\n${footer(true, false)}`,
			options.maximumBytes,
		);
	}

	let cursor = previous;
	if (cursorAdvanced) {
		cursor = nextCursor(
			reference,
			scan.fetchedThrough,
			current,
			previous,
			scan.events,
			headSha,
		);
		runtime.saveConversationCursor(ref, cursor);
	}
	return toolResult(bounded.text, {
		reference,
		initialized: false,
		querySince: since,
		fetchedThrough: scan.fetchedThrough,
		complete: scan.complete,
		pages: scan.pages,
		total: scan.total,
		scanned: scan.events.length,
		items: newEvents,
		metadataChanges: changes,
		truncated: bounded.truncated,
		originalBytes: bounded.originalBytes,
		renderedBytes: bounded.renderedBytes,
		cursorAdvanced,
		cursor: cursor
			? {
					fetchedThrough: cursor.fetchedThrough,
					lastEventIds: [...cursor.eventVersions.keys()].slice(-100),
					lastUpdatedAt: cursor.lastUpdatedAt,
					lastHeadSha: cursor.lastHeadSha,
				}
			: undefined,
	});
}
