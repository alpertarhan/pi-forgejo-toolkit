import { apiPath, type ForgejoClient } from "../client.js";
import type { ForgejoLabel, ForgejoMilestone } from "../types.js";

function requestOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

export function uniqueNames(values: string[], name: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) throw new Error(`${name} cannot contain an empty name`);
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

export async function labelIds(
  client: ForgejoClient,
  owner: string,
  repo: string,
  names: string[],
  signal?: AbortSignal,
): Promise<number[]> {
  const response = await client.request<ForgejoLabel[]>(apiPath("repos", owner, repo, "labels"), {
    ...requestOptions(signal),
    query: { limit: 100 },
  });
  const ids: number[] = [];
  const missing: string[] = [];
  for (const name of uniqueNames(names, "labels")) {
    const label = response.data.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (label) ids.push(label.id);
    else missing.push(name);
  }
  if (missing.length > 0) throw new Error(`unknown labels in ${owner}/${repo}: ${missing.join(", ")}`);
  return ids;
}

export async function milestoneId(
  client: ForgejoClient,
  owner: string,
  repo: string,
  title: string | undefined,
  id: number | undefined,
  signal?: AbortSignal,
): Promise<number> {
  if (id !== undefined && title !== undefined) throw new Error("provide milestone or milestone_id, not both");
  if (id !== undefined) return id;
  const expected = title?.trim();
  if (!expected) throw new Error("milestone or milestone_id is required to set a milestone");
  const matches: ForgejoMilestone[] = [];
  let fetched = 0;
  for (let page = 1; page <= 100; page += 1) {
    const response = await client.request<ForgejoMilestone[]>(apiPath("repos", owner, repo, "milestones"), {
      ...requestOptions(signal),
      query: { state: "all", page, limit: 100 },
    });
    fetched += response.data.length;
    matches.push(...response.data.filter((milestone) => milestone.title.toLowerCase() === expected.toLowerCase()));
    const complete = response.totalCount === undefined ? response.data.length < 100 : fetched >= response.totalCount;
    if (complete) break;
    if (page === 100) throw new Error(`too many milestones in ${owner}/${repo}; use milestone_id`);
  }
  if (matches.length === 0) throw new Error(`unknown milestone '${expected}' in ${owner}/${repo}`);
  if (matches.length > 1) throw new Error(`ambiguous milestone '${expected}' in ${owner}/${repo}; use milestone_id`);
  const match = matches[0];
  if (!match) throw new Error(`unknown milestone '${expected}' in ${owner}/${repo}`);
  return match.id;
}

export function normalizedDueDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error("due_date must be an RFC 3339 timestamp with a timezone");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("due_date must be a valid RFC 3339 timestamp");
  return new Date(timestamp).toISOString();
}
