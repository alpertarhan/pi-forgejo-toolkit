import type { ForgejoClient } from "../client.js";
import { formatResourceRef } from "../refs.js";
import type { ConversationCursor, ForgejoRuntime } from "../runtime.js";
import type { ForgejoIssue, ForgejoTimelineEvent, ResourceRef } from "../types.js";
import { boundModelTextWithSuffix, formatTimelineEvent, toolResult } from "./common.js";

const CURSOR_OVERLAP_MS = 5_000;
const MAX_REMEMBERED_EVENTS = 2_000;

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

interface TimelineScan {
  events: ForgejoTimelineEvent[];
  pages: number;
  total?: number;
  complete: boolean;
}

function requestOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function normalizedTimestamp(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${name} must be an RFC 3339 timestamp`);
  return new Date(timestamp).toISOString();
}

function overlapTimestamp(value: string): string {
  return new Date(Date.parse(value) - CURSOR_OVERLAP_MS).toISOString();
}

function eventVersion(event: ForgejoTimelineEvent): string {
  return [
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
}

async function scanTimeline(
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
    for (const event of response.data) byId.set(event.id, event);
    const hasMore = response.totalCount === undefined ? response.data.length === pageLimit : page * pageLimit < response.totalCount;
    if (!hasMore) {
      complete = true;
      break;
    }
  }
  const events = [...byId.values()].sort((left, right) => {
    const timestampOrder = Date.parse(left.created_at) - Date.parse(right.created_at);
    return timestampOrder || left.id - right.id;
  });
  const result: TimelineScan = { events, pages, complete };
  if (total !== undefined) result.total = total;
  return result;
}

function metadataChanges<T extends ForgejoIssue>(current: T, cursor: ConversationCursor | undefined, headSha: string | undefined): string[] {
  if (!cursor) return [];
  const changes: string[] = [];
  if (current.title !== cursor.lastTitle) changes.push(`Title: ${cursor.lastTitle} -> ${current.title}`);
  if (current.state !== cursor.lastState) changes.push(`State: ${cursor.lastState} -> ${current.state}`);
  if (headSha !== undefined && cursor.lastHeadSha !== undefined && headSha !== cursor.lastHeadSha) {
    changes.push(`Head SHA: ${cursor.lastHeadSha} -> ${headSha}`);
  }
  if (current.updated_at !== cursor.lastUpdatedAt) changes.push(`Updated: ${cursor.lastUpdatedAt} -> ${current.updated_at}`);
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
  const eventVersions = new Map(previous?.eventVersions ?? []);
  for (const event of events) {
    eventVersions.delete(event.id);
    eventVersions.set(event.id, eventVersion(event));
  }
  while (eventVersions.size > MAX_REMEMBERED_EVENTS) {
    const oldest = eventVersions.keys().next().value;
    if (oldest === undefined) break;
    eventVersions.delete(oldest);
  }
  const cursor: ConversationCursor = {
    reference,
    fetchedThrough,
    eventVersions,
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
  const currentRequest = client.request<T>(options.currentPath, requestOptions(options.signal));

  if (!previous && options.since === undefined) {
    const current = (await currentRequest).data;
    const headSha = options.headSha?.(current);
    const cursor = nextCursor(reference, startedAt, current, undefined, [], headSha);
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

  const since = options.since === undefined
    ? overlapTimestamp(previous?.fetchedThrough ?? startedAt)
    : normalizedTimestamp(options.since, "since");
  const [currentResponse, scan] = await Promise.all([
    currentRequest,
    scanTimeline(client, options.timelinePath, since, startedAt, options.pageLimit, options.maxPages, options.signal),
  ]);
  const current = currentResponse.data;
  const headSha = options.headSha?.(current);
  const changes = metadataChanges(current, previous, headSha);
  const newEvents = scan.events.filter((event) => previous?.eventVersions.get(event.id) !== eventVersion(event));
  const body = [
    `Updates for ${reference}`,
    ...(changes.length > 0 ? ["", "Metadata changes:", ...changes.map((change) => `- ${change}`)] : []),
    ...(newEvents.length > 0 ? ["", ...newEvents.map(formatTimelineEvent)] : ["", "No new timeline events"]),
  ].join("\n");
  const footer = (truncated: boolean, cursorAdvanced: boolean): string => [
    "",
    `Query since: ${since}`,
    `Fetched through: ${startedAt}`,
    `Pages scanned: ${scan.pages}`,
    `Events scanned: ${scan.events.length}`,
    `New events: ${newEvents.length}`,
    `Complete: ${scan.complete ? "yes" : "no"}`,
    `Truncated: ${truncated ? "yes" : "no"}`,
    `Cursor advanced: ${cursorAdvanced ? "yes" : "no"}`,
    ...(!scan.complete ? [`Recovery: narrow since or increase max_pages above ${options.maxPages}`] : []),
    ...(truncated ? ["Recovery: repeat with a smaller limit, narrower since, or larger max_bytes"] : []),
  ].join("\n");

  let cursorAdvanced = scan.complete;
  let bounded = boundModelTextWithSuffix(body, `\n${footer(false, cursorAdvanced)}`, options.maximumBytes);
  if (bounded.truncated) {
    cursorAdvanced = false;
    bounded = boundModelTextWithSuffix(body, `\n${footer(true, false)}`, options.maximumBytes);
  }

  let cursor = previous;
  if (cursorAdvanced) {
    cursor = nextCursor(reference, startedAt, current, previous, scan.events, headSha);
    runtime.saveConversationCursor(ref, cursor);
  }
  return toolResult(bounded.text, {
    reference,
    initialized: false,
    querySince: since,
    fetchedThrough: startedAt,
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
    cursor: cursor ? {
      fetchedThrough: cursor.fetchedThrough,
      lastEventIds: [...cursor.eventVersions.keys()].slice(-100),
      lastUpdatedAt: cursor.lastUpdatedAt,
      lastHeadSha: cursor.lastHeadSha,
    } : undefined,
  });
}
