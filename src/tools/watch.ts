import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseResourceRef } from "../refs.js";
import type { WatchManager, WatchFilter } from "../watch.js";
import {
	boundModelText,
	DEFAULT_MODEL_OUTPUT_BYTES,
	toolResult,
	type RuntimeProvider,
} from "./common.js";

export type WatchManagerProvider = () => WatchManager;

const WATCH_EVENTS = [
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
] as const satisfies readonly WatchFilter[];

const START_FIELDS = [
	"ref",
	"events",
	"since",
	"interval_seconds",
	"timeout_minutes",
	"attention",
	"include_self",
	"note",
] as const;

function rejectFields(
	params: Record<string, unknown>,
	fields: readonly string[],
	action: string,
): void {
	const supplied = fields.filter((field) => params[field] !== undefined);
	if (supplied.length > 0)
		throw new Error(
			`${supplied.join(", ")} ${supplied.length === 1 ? "is" : "are"} not valid for ${action}`,
		);
}

function validateInteger(
	value: unknown,
	name: string,
	minimum: number,
	maximum: number,
): void {
	if (
		value !== undefined &&
		(!Number.isInteger(value) ||
			(value as number) < minimum ||
			(value as number) > maximum)
	) {
		throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	}
}

function validateStartParams(params: Record<string, unknown>): void {
	validateInteger(params.interval_seconds, "interval_seconds", 30, 3600);
	validateInteger(params.timeout_minutes, "timeout_minutes", 1, 1440);
	if (
		params.attention !== undefined &&
		params.attention !== "turn" &&
		params.attention !== "context"
	) {
		throw new Error("attention must be turn or context");
	}
	if (
		params.include_self !== undefined &&
		typeof params.include_self !== "boolean"
	) {
		throw new Error("include_self must be a boolean");
	}
	if (params.note !== undefined && typeof params.note !== "string")
		throw new Error("note must be a string");
	if (typeof params.note === "string" && params.note.length > 500)
		throw new Error("note must be at most 500 characters");
}

function validateEventsForKind(
	events: readonly WatchFilter[],
	kind: "issue" | "pull",
): void {
	if (kind === "pull") return;
	const pullOnly = events.filter((event) =>
		["review_comment", "review", "review_request", "merged", "push"].includes(
			event,
		),
	);
	if (pullOnly.length > 0) {
		throw new Error(
			`${pullOnly.join(", ")} ${pullOnly.length === 1 ? "is" : "are"} only valid for pull-request watches`,
		);
	}
}

export function registerWatchTool(
	pi: ExtensionAPI,
	runtimeProvider: RuntimeProvider,
	watchManagerProvider: WatchManagerProvider,
): void {
	pi.registerTool({
		name: "forgejo_watch",
		label: "Forgejo Watch",
		description:
			"Start, list, or stop session-scoped one-shot issue and pull-request timeline watches.",
		parameters: Type.Object({
			action: StringEnum(["start", "list", "stop"] as const),
			ref: Type.Optional(
				Type.String({
					description: "Qualified Forgejo issue or pull request reference",
				}),
			),
			events: Type.Optional(
				Type.Array(StringEnum(WATCH_EVENTS), {
					minItems: 1,
					uniqueItems: true,
				}),
			),
			since: Type.Optional(
				Type.String({
					format: "date-time",
					description: "Optional RFC 3339 history baseline",
				}),
			),
			interval_seconds: Type.Optional(
				Type.Integer({ minimum: 30, maximum: 3600, default: 60 }),
			),
			timeout_minutes: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 1440, default: 120 }),
			),
			attention: Type.Optional(
				StringEnum(["turn", "context"] as const, { default: "turn" }),
			),
			include_self: Type.Optional(Type.Boolean({ default: false })),
			note: Type.Optional(
				Type.String({
					maxLength: 500,
					description: "Optional agent-authored reminder",
				}),
			),
			id: Type.Optional(Type.String({ minLength: 1 })),
			all: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal) {
			const runtime = runtimeProvider();
			const manager = watchManagerProvider();
			if (params.action === "list") {
				rejectFields(params, [...START_FIELDS, "id", "all"], "list");
				const watches = manager.list();
				const summaryWatches = watches.map(
					({ matchedEvents: _events, ...watch }) => watch,
				);
				const summary = boundModelText(
					JSON.stringify({ watches: summaryWatches }),
					DEFAULT_MODEL_OUTPUT_BYTES,
				);
				return toolResult(summary.text, { watches });
			}

			if (params.action === "stop") {
				rejectFields(params, START_FIELDS, "stop");
				const stopAll = params.all === true;
				if ((params.id !== undefined) === stopAll || params.all === false) {
					throw new Error("stop requires exactly one of id or all=true");
				}
				if (stopAll) {
					const ids = manager
						.list()
						.filter(
							(watch) => watch.state === "active" && manager.stop(watch.id),
						)
						.map((watch) => watch.id);
					return toolResult(JSON.stringify({ stopped: ids.length, ids }), {
						stopped: ids.length,
						ids,
					});
				}
				const stopped = manager.stop(params.id as string);
				return toolResult(JSON.stringify({ id: params.id, stopped }), {
					id: params.id,
					stopped,
				});
			}

			rejectFields(params, ["id", "all"], "start");
			if (!params.ref) throw new Error("ref is required for start");
			validateStartParams(params);
			if (params.events !== undefined && params.events.length === 0)
				throw new Error("events must contain at least one event");
			const parsed = parseResourceRef(params.ref);
			if (!parsed) throw new Error(`invalid Forgejo reference '${params.ref}'`);
			const events = params.events ?? ["feedback"];
			validateEventsForKind(events, parsed.kind);
			const ref = runtime.resolveResource({ ref: params.ref }, parsed.kind);
			const existingIds = new Set(manager.list().map((watch) => watch.id));
			const watch = await manager.arm({
				ref,
				filters: events,
				pollIntervalMs: (params.interval_seconds ?? 60) * 1_000,
				timeoutMs: (params.timeout_minutes ?? 120) * 60_000,
				attention: params.attention ?? "turn",
				includeSelf: params.include_self ?? false,
				...(params.since === undefined ? {} : { since: params.since }),
				...(params.note === undefined ? {} : { note: params.note }),
				...(signal === undefined ? {} : { signal }),
			});
			const outcome =
				watch.state === "matched"
					? "already-matched"
					: existingIds.has(watch.id)
						? "deduplicated"
						: "created";
			const data = { outcome, watch };
			return toolResult(JSON.stringify(data), data);
		},
	});
}
