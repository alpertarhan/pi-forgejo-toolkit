import { apiPath, type ForgejoClient } from "./client.js";
import type {
  ForgejoActionArtifact,
  ForgejoActionRun,
  ForgejoActionRunJob,
  ForgejoActionRunList,
  ForgejoActionStatus,
  RepoRef,
  ForgejoWorkflowDispatchRun,
} from "./types.js";

export interface ActionRunFilters {
  page?: number;
  limit?: number;
  event?: string;
  status?: ForgejoActionStatus;
  runNumber?: number;
  headSha?: string;
  ref?: string;
  workflowId?: string;
}

export interface ActionRunPage {
  runs: ForgejoActionRun[];
  total: number;
  page: number;
  limit: number;
}

export interface ActionArtifactFilters {
  runId?: number;
  name?: string;
  page?: number;
  limit?: number;
}

export interface ActionArtifactPage {
  artifacts: ForgejoActionArtifact[];
  total: number;
  page: number;
  limit: number;
  runId?: number;
}

function requestOptions(signal: AbortSignal | undefined): {
	signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

export async function listActionRuns(
  client: ForgejoClient,
  repo: RepoRef,
  filters: ActionRunFilters = {},
  signal?: AbortSignal,
): Promise<ActionRunPage> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(50, Math.max(1, filters.limit ?? 20));
	const response = await client.request<ForgejoActionRunList>(
		apiPath("repos", repo.owner, repo.repo, "actions", "runs"),
		{
    ...requestOptions(signal),
    query: {
      page,
      limit,
      event: filters.event,
      status: filters.status,
      run_number: filters.runNumber,
      head_sha: filters.headSha,
      ref: filters.ref,
      workflow_id: filters.workflowId,
    },
		},
	);
	const runs = response.data.workflow_runs.filter(
		(run): run is ForgejoActionRun => run !== null,
	);
  return {
    runs,
		total: Number.isFinite(response.data.total_count)
			? response.data.total_count
			: runs.length,
    page,
    limit,
  };
}

export async function getActionRun(
  client: ForgejoClient,
  repo: RepoRef,
  runId: number,
  signal?: AbortSignal,
): Promise<ForgejoActionRun> {
  const response = await client.request<ForgejoActionRun>(
    apiPath("repos", repo.owner, repo.repo, "actions", "runs", runId),
    requestOptions(signal),
  );
  return response.data;
}

export async function listActionRunJobs(
  client: ForgejoClient,
  repo: RepoRef,
  runId: number,
  signal?: AbortSignal,
): Promise<ForgejoActionRunJob[]> {
  const response = await client.request<ForgejoActionRunJob[]>(
    apiPath("repos", repo.owner, repo.repo, "actions", "runs", runId, "jobs"),
    requestOptions(signal),
  );
  return response.data;
}

export async function getActionJobLog(
  client: ForgejoClient,
  repo: RepoRef,
  jobId: number,
  attempt: number | undefined,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ log: string; truncated: boolean }> {
	const response = await client.request<string>(
		apiPath("repos", repo.owner, repo.repo, "actions", "jobs", jobId, "logs"),
		{
    ...requestOptions(signal),
    accept: "text/plain",
    query: { attempt },
    byteRange: { start: 0, end: maxBytes - 1 },
			maxResponseBytes: maxBytes,
			truncateResponse: true,
		},
	);
	const bytes = Buffer.from(response.data, "utf8");
	const contentRange =
		response.headers
			.get("content-range")
			?.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i) ?? undefined;
	const rangeTruncated =
		contentRange && contentRange[3] !== "*"
			? Number(contentRange[2]) + 1 < Number(contentRange[3])
			: response.status === 206;
  return {
		log: bytes.subarray(0, maxBytes).toString("utf8"),
		truncated: Boolean(
			response.truncated || rangeTruncated || bytes.byteLength > maxBytes,
		),
  };
}

export async function dispatchActionWorkflow(
  client: ForgejoClient,
  repo: RepoRef,
  workflow: string,
  ref: string,
  inputs: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<ForgejoWorkflowDispatchRun | undefined> {
  const response = await client.request<ForgejoWorkflowDispatchRun | undefined>(
		apiPath(
			"repos",
			repo.owner,
			repo.repo,
			"actions",
			"workflows",
			workflow,
			"dispatches",
		),
    {
      ...requestOptions(signal),
      method: "POST",
      body: { ref, inputs, return_run_info: true },
    },
  );
  return response.data;
}

export async function cancelActionRun(
  client: ForgejoClient,
  repo: RepoRef,
  runId: number,
  signal?: AbortSignal,
): Promise<void> {
	await client.request<void>(
		apiPath("repos", repo.owner, repo.repo, "actions", "runs", runId, "cancel"),
		{
    ...requestOptions(signal),
    method: "POST",
		},
	);
}

export async function rerunActionRun(
  client: ForgejoClient,
  repo: RepoRef,
  runId: number,
  signal?: AbortSignal,
): Promise<void> {
	await client.request<void>(
		apiPath("repos", repo.owner, repo.repo, "actions", "runs", runId, "rerun"),
		{
    ...requestOptions(signal),
    method: "POST",
		},
	);
}

export async function listActionArtifacts(
  client: ForgejoClient,
  repo: RepoRef,
  filters: ActionArtifactFilters = {},
  signal?: AbortSignal,
): Promise<ActionArtifactPage> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(50, Math.max(1, filters.limit ?? 20));
	const path =
		filters.runId === undefined
    ? apiPath("repos", repo.owner, repo.repo, "actions", "artifacts")
			: apiPath(
					"repos",
					repo.owner,
					repo.repo,
					"actions",
					"runs",
					filters.runId,
					"artifacts",
				);
  const response = await client.request<ForgejoActionArtifact[]>(path, {
    ...requestOptions(signal),
    query: { name: filters.name, page, limit },
  });
  return {
    artifacts: response.data,
    total: response.totalCount ?? response.data.length,
    page,
    limit,
    ...(filters.runId === undefined ? {} : { runId: filters.runId }),
  };
}

export async function getActionArtifact(
  client: ForgejoClient,
  repo: RepoRef,
  artifactId: number,
  signal?: AbortSignal,
): Promise<ForgejoActionArtifact> {
  const response = await client.request<ForgejoActionArtifact>(
    apiPath("repos", repo.owner, repo.repo, "actions", "artifacts", artifactId),
    requestOptions(signal),
  );
  return response.data;
}

export async function downloadActionArtifact(
  client: ForgejoClient,
  repo: RepoRef,
  artifactId: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
	const response = await client.request<ReadableStream<Uint8Array>>(
		apiPath(
			"repos",
			repo.owner,
			repo.repo,
			"actions",
			"artifacts",
			artifactId,
			"zip",
		),
    {
      ...requestOptions(signal),
      accept: "application/zip",
			responseType: "stream",
      maxResponseBytes: maxBytes,
			timeoutMs: 300_000,
    },
  );
  return response.data;
}

export function latestFailedActionRuns(
	runs: ForgejoActionRun[],
): ForgejoActionRun[] {
  const latest = new Map<string, ForgejoActionRun>();
  for (const run of runs) {
    const key = `${run.workflow_id}\u0000${run.prettyref}`;
    const current = latest.get(key);
    const updated = Date.parse(run.updated) || 0;
    const currentUpdated = current ? Date.parse(current.updated) || 0 : -1;
		if (
			!current ||
			updated > currentUpdated ||
			(updated === currentUpdated && run.id > current.id)
		)
			latest.set(key, run);
  }
  return [...latest.values()]
    .filter((run) => run.status === "failure")
		.sort(
			(left, right) => Date.parse(right.updated) - Date.parse(left.updated),
		);
}
