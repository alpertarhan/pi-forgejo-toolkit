import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatCanonicalRef, parseResourceRef } from "./refs.js";
import type { WatchEmission, WatchEventMetadata } from "./watch.js";

const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;

function safeToken(value: string | undefined, fallback: string): string {
	return value !== undefined && SAFE_TOKEN.test(value) ? value : fallback;
}

function safeTimestamp(value: string | undefined): string | undefined {
	return value !== undefined && Number.isFinite(Date.parse(value))
		? new Date(value).toISOString()
		: undefined;
}

function safeWatchEvent(event: WatchEventMetadata): WatchEventMetadata {
	const safe: WatchEventMetadata = {
		source: event.source === "resource" ? "resource" : "timeline",
		type: safeToken(event.type, "unknown"),
	};
	if (
		event.eventId !== undefined &&
		Number.isSafeInteger(event.eventId) &&
		event.eventId > 0
	)
		safe.eventId = event.eventId;
	if (event.actor !== undefined) safe.actor = safeToken(event.actor, "unknown");
	if (
		event.reviewId !== undefined &&
		Number.isSafeInteger(event.reviewId) &&
		event.reviewId > 0
	)
		safe.reviewId = event.reviewId;
	const createdAt = safeTimestamp(event.createdAt);
	const updatedAt = safeTimestamp(event.updatedAt);
	if (createdAt !== undefined) safe.createdAt = createdAt;
	if (updatedAt !== undefined) safe.updatedAt = updatedAt;
	return safe;
}

export function formatWatchNotification(emission: WatchEmission): {
	content: string;
	details: Record<string, unknown>;
} {
	const parsed = parseResourceRef(emission.reference);
	if (!parsed) throw new Error("watch notification has an invalid reference");
	const reference = formatCanonicalRef(parsed);
	const watchId = safeToken(emission.watchId, "unknown");
	const fetchSince =
		safeTimestamp(emission.fetchSince) ?? new Date(0).toISOString();
	const note = emission.note
		?.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
	const details: Record<string, unknown> = {
		kind: emission.kind,
		watchId,
		reference,
		fetchSince,
	};
	const lines = [
		`Forgejo watch ${emission.kind}: ${watchId}`,
		`Ref: ${reference}`,
	];

	if (emission.kind === "matched") {
		const events = emission.events.slice(0, 20).map(safeWatchEvent);
		const totalCount =
			Number.isSafeInteger(emission.totalCount) && emission.totalCount >= 0
				? emission.totalCount
				: events.length;
		details.totalCount = totalCount;
		details.events = events;
		lines.push(`Events: ${totalCount}`);
		for (const event of events) {
			lines.push(
				`- eventId=${event.eventId ?? "none"} type=${event.type} actor=${event.actor ?? "unknown"} reviewId=${event.reviewId ?? "none"} createdAt=${event.createdAt ?? "unknown"} updatedAt=${event.updatedAt ?? "unknown"}`,
			);
		}
	} else if (emission.kind === "failed") {
		const code = safeToken(emission.error.code, "internal");
		const status =
			Number.isInteger(emission.error.status) &&
			(emission.error.status ?? 0) >= 100 &&
			(emission.error.status ?? 0) <= 599
				? emission.error.status
				: undefined;
		details.error = { code, ...(status === undefined ? {} : { status }) };
		lines.push(
			`Error: code=${code}${status === undefined ? "" : ` status=${status}`}`,
		);
	}

	if (note) {
		details.note = note;
		lines.push(`Note: ${note}`);
	}
	const tool = parsed.kind === "issue" ? "forgejo_issue" : "forgejo_pull";
	lines.push(
		`Fetch updates: ${tool} action=updates ref=${reference} since=${fetchSince}`,
	);
	return { content: lines.join("\n"), details };
}

export function sendWatchNotification(
	pi: ExtensionAPI,
	emission: WatchEmission,
): void {
	const message = formatWatchNotification(emission);
	const options =
		emission.attention === "turn"
			? { triggerTurn: true, deliverAs: "steer" as const }
			: { triggerTurn: false };
	pi.sendMessage(
		{ customType: "forgejo-watch", ...message, display: true },
		options,
	);
}
