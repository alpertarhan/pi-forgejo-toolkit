import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	cancelActionRun,
	dispatchActionWorkflow,
	downloadActionArtifact,
	getActionArtifact,
	getActionJobLog,
	getActionRun,
	listActionArtifacts,
	listActionRunJobs,
	listActionRuns,
	rerunActionRun,
} from "../actions.js";
import type { ActionArtifactFilters, ActionRunFilters } from "../actions.js";
import type {
	ForgejoActionArtifact,
	ForgejoActionStatus,
	ForgejoFeatureAvailability,
} from "../types.js";
import {
	confirmMutation,
	DEFAULT_LARGE_MODEL_OUTPUT_BYTES,
	modelOutputBytes,
	positiveLimit,
	repoTargetProperties,
	toolResult,
	type RuntimeProvider,
} from "./common.js";

const ACTION_STATUSES = [
	"unknown",
	"waiting",
	"running",
	"success",
	"failure",
	"cancelled",
	"skipped",
	"blocked",
] as const;
const FINISHED_ACTION_STATUSES = new Set<ForgejoActionStatus>([
	"success",
	"failure",
	"cancelled",
	"skipped",
]);
const DEFAULT_ARTIFACT_LIMIT = 100_000_000;

type ActionFeature =
	| "actionsRuns"
	| "actionsDispatch"
	| "actionsCancel"
	| "actionsRerun"
	| "actionsArtifacts";

function requireId(value: number | undefined, name: string): number {
	if (value === undefined || !Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function featureLabel(feature: ActionFeature): string {
	switch (feature) {
		case "actionsRuns":
			return "Actions runs";
		case "actionsDispatch":
			return "workflow dispatch";
		case "actionsCancel":
			return "run cancellation";
		case "actionsRerun":
			return "run rerun";
		case "actionsArtifacts":
			return "Actions artifacts";
	}
}

async function actionFeature(
	runtime: ReturnType<RuntimeProvider>,
	server: string,
	feature: ActionFeature,
	signal?: AbortSignal,
): Promise<ForgejoFeatureAvailability> {
	let capabilities = runtime.capabilities.get(server);
	if (!capabilities)
		capabilities = await runtime.capabilities.refreshAlias(server, signal);
	return capabilities?.features[feature] ?? "unknown";
}

async function requireActionFeature(
	runtime: ReturnType<RuntimeProvider>,
	server: string,
	feature: ActionFeature,
	mutate: boolean,
	signal?: AbortSignal,
): Promise<void> {
	const availability = await actionFeature(runtime, server, feature, signal);
	if (availability === "available" || (!mutate && availability === "unknown"))
		return;
	const version = runtime.capabilities.get(server)?.version ?? "unknown version";
	if (availability === "unavailable") {
		throw new Error(
			`Forgejo ${server} (${version}) does not advertise the ${featureLabel(feature)} API`,
		);
	}
	throw new Error(
		`Forgejo ${server} ${featureLabel(feature)} capability is unknown; refusing to mutate until capability discovery succeeds`,
	);
}

function formatArtifact(artifact: ForgejoActionArtifact): string {
	const state = artifact.expired ? "expired" : `expires ${artifact.expires_at}`;
	return `- artifact ${artifact.id} ${artifact.name} (${artifact.size_in_bytes} bytes) run ${artifact.run_id} [${state}]`;
}

function safeArtifactFilename(artifact: ForgejoActionArtifact): string {
	const stem = artifact.name
		.replace(/[^A-Za-z0-9._-]+/g, "_")
		.replace(/^\.+/, "")
		.slice(0, 120);
	return `${stem || `artifact-${artifact.id}`}.zip`;
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return (
		path === "" ||
		(path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
	);
}

async function artifactOutputPath(
	cwd: string,
	requested: string | undefined,
	artifact: ForgejoActionArtifact,
): Promise<string> {
	const workspace = resolve(cwd);
	const raw = requested?.trim() || safeArtifactFilename(artifact);
	const lexical = resolve(workspace, raw);
	if (!isWithin(workspace, lexical))
		throw new Error(
			"artifact output_path must stay inside the current workspace",
		);
	const [realWorkspace, realParent] = await Promise.all([
		realpath(workspace),
		realpath(dirname(lexical)),
	]);
	if (!isWithin(realWorkspace, realParent)) {
		throw new Error(
			"artifact output_path parent resolves outside the current workspace",
		);
	}
	return resolve(realParent, basename(lexical));
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const value = error as Record<string, unknown>;
	return typeof value.code === "string" ? value.code : undefined;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

async function removeIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

async function writeArchiveAtomic(
	destination: string,
	stream: ReadableStream<Uint8Array>,
	maximum: number,
	overwrite: boolean,
): Promise<number> {
	const temporary = resolve(
		dirname(destination),
		`.${basename(destination)}.${randomUUID()}.tmp`,
	);
	const file = await open(temporary, "wx", 0o600);
	const reader = stream.getReader();
	let downloaded = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			downloaded += chunk.value.byteLength;
			if (downloaded > maximum) {
				await reader.cancel();
				throw new Error(`artifact download exceeds the ${maximum} byte limit`);
			}
			let offset = 0;
			while (offset < chunk.value.byteLength) {
				const { bytesWritten } = await file.write(chunk.value, offset);
				if (bytesWritten < 1)
					throw new Error("artifact download stalled while writing");
				offset += bytesWritten;
			}
		}
		await file.sync();
		await file.close();
		if (overwrite) {
			await rename(temporary, destination);
		} else {
			try {
				await link(temporary, destination);
			} catch (error) {
				if (errorCode(error) === "EEXIST")
					throw new Error(`artifact output already exists: ${destination}`);
				throw error;
			}
			await unlink(temporary);
		}
		return downloaded;
	} finally {
		reader.releaseLock();
		await file.close().catch(() => undefined);
		await removeIfPresent(temporary);
	}
}

export function registerActionsTool(
	pi: ExtensionAPI,
	runtimeProvider: RuntimeProvider,
): void {
	pi.registerTool({
		name: "forgejo_actions",
		label: "Forgejo Actions",
		description:
			"Inspect Forgejo Actions runs, jobs, logs, and artifacts; safely dispatch workflows, cancel or rerun supported runs, and download bounded artifact archives.",
		parameters: Type.Object({
			action: StringEnum([
				"list",
				"get",
				"jobs",
				"job_log",
				"dispatch",
				"cancel",
				"rerun",
				"artifacts",
				"artifact",
				"download_artifact",
			] as const),
			...repoTargetProperties,
			run_id: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Workflow run database ID returned by list",
				}),
			),
			job_id: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Workflow job ID returned by jobs",
				}),
			),
			attempt: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Historical job attempt; omit for latest",
				}),
			),
			artifact_id: Type.Optional(
				Type.Integer({
					minimum: 1,
					description: "Artifact ID returned by artifacts",
				}),
			),
			artifact_name: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Exact artifact-name filter for artifacts",
				}),
			),
			status: Type.Optional(StringEnum(ACTION_STATUSES)),
			event: Type.Optional(
				Type.String({
					description: "Trigger event such as push or pull_request",
				}),
			),
			git_ref: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Git reference for filtering or workflow dispatch",
				}),
			),
			head_sha: Type.Optional(Type.String()),
			workflow_id: Type.Optional(
				Type.String({ minLength: 1, description: "Workflow filename" }),
			),
			inputs: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Workflow-dispatch input values",
				}),
			),
			output_path: Type.Optional(
				Type.String({
					minLength: 1,
					description: "Artifact ZIP destination relative to the current workspace",
				}),
			),
			overwrite: Type.Optional(
				Type.Boolean({
					description: "Allow replacing an existing artifact output file",
				}),
			),
			page: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
			max_bytes: modelOutputBytes(
				"Maximum model-visible job-log bytes; default 64 KB",
			),
			max_download_bytes: Type.Optional(
				Type.Integer({
					minimum: 1_000,
					maximum: 1_000_000_000,
					description: "Maximum artifact metadata size and downloaded ZIP bytes",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const runtime = runtimeProvider();
			const repo = runtime.resolveRepo(params);
			const client = runtime.client(repo.server);

			if (params.action === "dispatch") {
				await requireActionFeature(
					runtime,
					repo.server,
					"actionsDispatch",
					true,
					signal,
				);
				const workflow = params.workflow_id?.trim();
				const ref = params.git_ref?.trim();
				if (!workflow) throw new Error("workflow_id is required for dispatch");
				if (!ref) throw new Error("git_ref is required for dispatch");
				const inputs = params.inputs ?? {};
				await confirmMutation(runtime, ctx, {
					signal,
					approval: "actions.workflow.dispatch",
					title: "Dispatch Forgejo workflow",
					message: [
						`Server: ${repo.server}`,
						`Repository: ${repo.owner}/${repo.repo}`,
						`Workflow: ${workflow}`,
						`Ref: ${ref}`,
						`Inputs: ${JSON.stringify(inputs, null, 2)}`,
					].join("\n"),
				});
				const run = await dispatchActionWorkflow(
					client,
					repo,
					workflow,
					ref,
					inputs,
					signal,
				);
				await runtime.dashboard.refreshIfObserved(signal);
				const summary = run
					? `Dispatched ${workflow} on ${repo.server}:${repo.owner}/${repo.repo}@${ref} as run ${run.run_number} (id ${run.id})`
					: `Dispatched ${workflow} on ${repo.server}:${repo.owner}/${repo.repo}@${ref}`;
				return toolResult(summary, {
					workflow,
					ref,
					inputNames: Object.keys(inputs),
					run,
				});
			}

			if (params.action === "cancel" || params.action === "rerun") {
				const runId = requireId(params.run_id, "run_id");
				const feature =
					params.action === "cancel" ? "actionsCancel" : "actionsRerun";
				await requireActionFeature(runtime, repo.server, feature, true, signal);
				const current = await getActionRun(client, repo, runId, signal);
				if (
					params.action === "cancel" &&
					FINISHED_ACTION_STATUSES.has(current.status)
				) {
					return toolResult(
						`Actions run ${current.index_in_repo} (id ${runId}) is already finished [${current.status}]`,
						current,
					);
				}
				if (
					params.action === "rerun" &&
					!FINISHED_ACTION_STATUSES.has(current.status)
				) {
					throw new Error(
						`Actions run ${current.index_in_repo} (id ${runId}) is not finished [${current.status}]`,
					);
				}
				await confirmMutation(runtime, ctx, {
					signal,
					approval:
						params.action === "cancel" ? "actions.run.cancel" : "actions.run.rerun",
					title:
						params.action === "cancel"
							? "Cancel Forgejo Actions run"
							: "Rerun Forgejo Actions run",
					message: [
						`Server: ${repo.server}`,
						`Repository: ${repo.owner}/${repo.repo}`,
						`Run: ${current.index_in_repo} (id ${current.id})`,
						`Workflow: ${current.workflow_id}`,
						`Ref: ${current.prettyref}`,
						`Status: ${current.status}`,
					].join("\n"),
				});
				const confirmed = await getActionRun(client, repo, runId, signal);
				if (
					params.action === "cancel" &&
					FINISHED_ACTION_STATUSES.has(confirmed.status)
				) {
					return toolResult(
						`Actions run ${confirmed.index_in_repo} (id ${runId}) finished before cancellation [${confirmed.status}]`,
						confirmed,
					);
				}
				if (
					params.action === "rerun" &&
					!FINISHED_ACTION_STATUSES.has(confirmed.status)
				) {
					throw new Error(
						`Actions run ${confirmed.index_in_repo} (id ${runId}) is no longer finished [${confirmed.status}]`,
					);
				}
				if (params.action === "cancel")
					await cancelActionRun(client, repo, runId, signal);
				else await rerunActionRun(client, repo, runId, signal);
				const fresh = await getActionRun(client, repo, runId, signal);
				await runtime.dashboard.refreshIfObserved(signal);
				return toolResult(
					`${params.action === "cancel" ? "Cancellation" : "Rerun"} requested for Actions run ${fresh.index_in_repo} (id ${runId}) [${fresh.status}]`,
					fresh,
				);
			}

			if (
				params.action === "artifacts" ||
				params.action === "artifact" ||
				params.action === "download_artifact"
			) {
				await requireActionFeature(
					runtime,
					repo.server,
					"actionsArtifacts",
					false,
					signal,
				);
				if (params.action === "artifacts") {
					const filters: ActionArtifactFilters = {
						page: params.page ?? 1,
						limit: positiveLimit(params.limit, 20, 50),
					};
					if (params.run_id !== undefined)
						filters.runId = requireId(params.run_id, "run_id");
					if (params.artifact_name !== undefined)
						filters.name = params.artifact_name;
					const page = await listActionArtifacts(client, repo, filters, signal);
					return toolResult(
						[
							`Artifacts for ${repo.server}:${repo.owner}/${repo.repo}: ${page.total}`,
							...page.artifacts.map(formatArtifact),
						].join("\n"),
						page,
					);
				}

				const artifactId = requireId(params.artifact_id, "artifact_id");
				const artifact = await getActionArtifact(client, repo, artifactId, signal);
				if (params.action === "artifact")
					return toolResult(formatArtifact(artifact).slice(2), artifact);
				if (artifact.expired)
					throw new Error(`artifact ${artifact.id} '${artifact.name}' has expired`);
				const maximum = params.max_download_bytes ?? DEFAULT_ARTIFACT_LIMIT;
				if (artifact.size_in_bytes > maximum) {
					throw new Error(
						`artifact ${artifact.id} metadata size ${artifact.size_in_bytes} exceeds the ${maximum} byte limit`,
					);
				}
				const destination = await artifactOutputPath(
					runtime.cwd,
					params.output_path,
					artifact,
				);
				const exists = await pathExists(destination);
				if (exists && !params.overwrite)
					throw new Error(`artifact output already exists: ${destination}`);
				if (exists) {
					await confirmMutation(runtime, ctx, {
						signal,
						approval: "actions.artifact.overwrite",
						title: "Overwrite Forgejo artifact",
						message: [
							`Server: ${repo.server}`,
							`Repository: ${repo.owner}/${repo.repo}`,
							`Artifact: ${artifact.id} - ${artifact.name}`,
							`Destination: ${destination}`,
						].join("\n"),
					});
				}
				const stream = await downloadActionArtifact(
					client,
					repo,
					artifactId,
					maximum,
					signal,
				);
				const downloadedBytes = await writeArchiveAtomic(
					destination,
					stream,
					maximum,
					Boolean(params.overwrite),
				);
				return toolResult(
					`Downloaded artifact ${artifact.id} '${artifact.name}' to ${destination} (${downloadedBytes} bytes)`,
					{
						artifact,
						path: destination,
						downloadedBytes,
					},
				);
			}

			await requireActionFeature(
				runtime,
				repo.server,
				"actionsRuns",
				false,
				signal,
			);
			if (params.action === "list") {
				const filters: ActionRunFilters = {
					limit: positiveLimit(params.limit, 20, 50),
				};
				if (params.page !== undefined) filters.page = params.page;
				if (params.event !== undefined) filters.event = params.event;
				if (params.status !== undefined)
					filters.status = params.status as ForgejoActionStatus;
				if (params.head_sha !== undefined) filters.headSha = params.head_sha;
				if (params.git_ref !== undefined) filters.ref = params.git_ref;
				if (params.workflow_id !== undefined)
					filters.workflowId = params.workflow_id;
				const page = await listActionRuns(client, repo, filters, signal);
				const lines = page.runs.map(
					(run) =>
						`- run ${run.index_in_repo} (id ${run.id}) ${run.workflow_id} [${run.status}] ${run.prettyref || run.commit_sha.slice(0, 12)} - ${run.title}`,
				);
				return toolResult(
					[
						`Actions runs for ${repo.server}:${repo.owner}/${repo.repo}: ${page.total}`,
						...lines,
					].join("\n"),
					page,
				);
			}

			if (params.action === "job_log") {
				const jobId = requireId(params.job_id, "job_id");
				const maximum = params.max_bytes ?? DEFAULT_LARGE_MODEL_OUTPUT_BYTES;
				const result = await getActionJobLog(
					client,
					repo,
					jobId,
					params.attempt,
					maximum,
					signal,
				);
				const suffix = result.truncated
					? `\n\n[log truncated at ${maximum} bytes]`
					: "";
				return toolResult(
					`Job ${jobId} log${result.truncated ? " (truncated)" : ""}\n\n${result.log}${suffix}`,
					{
						jobId,
						attempt: params.attempt,
						...result,
					},
				);
			}

			const runId = requireId(params.run_id, "run_id");
			if (params.action === "jobs") {
				const jobs = await listActionRunJobs(client, repo, runId, signal);
				const lines = jobs.map(
					(job) =>
						`- job ${job.id} ${job.name} [${job.status}] attempt ${job.attempt}`,
				);
				return toolResult(
					[`Jobs for Actions run id ${runId}: ${jobs.length}`, ...lines].join("\n"),
					jobs,
				);
			}

			const run = await getActionRun(client, repo, runId, signal);
			return toolResult(
				`Actions run ${run.index_in_repo} (id ${run.id}) ${run.workflow_id} [${run.status}] ${run.prettyref} - ${run.title}`,
				run,
			);
		},
	});
}
