import type { ForgejoServerConfig, RepoRef, ResourceRef } from "./types.js";

const SEGMENT_PATTERN = "[A-Za-z0-9._-]+";
const SHORT_REF = new RegExp(
	`^(${SEGMENT_PATTERN}):(${SEGMENT_PATTERN})/(${SEGMENT_PATTERN})([#!])(\\d+)$`,
);

function validateSegment(value: string, field: string): string {
	if (!new RegExp(`^${SEGMENT_PATTERN}$`).test(value)) {
		throw new Error(`invalid Forgejo ${field}: ${value}`);
	}
	return value;
}

export function parseResourceRef(value: string): ResourceRef | undefined {
	const input = value.trim();
	const shortMatch = SHORT_REF.exec(input);
	if (shortMatch) {
		const [, server, owner, repo, marker, rawIndex] = shortMatch;
		if (!server || !owner || !repo || !marker || !rawIndex) return undefined;
		const index = Number(rawIndex);
		if (!Number.isSafeInteger(index) || index < 1) return undefined;
		return {
			server,
			owner,
			repo,
			kind: marker === "#" ? "issue" : "pull",
			index,
		};
	}

	if (!input.startsWith("fj://")) return undefined;
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return undefined;
	}
	const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
	if (parts.length !== 4) return undefined;
	const [owner, repo, rawKind, rawIndex] = parts;
	if (!owner || !repo || !rawKind || !rawIndex || !/^\d+$/.test(rawIndex))
		return undefined;
	const index = Number(rawIndex);
	if (!Number.isSafeInteger(index) || index < 1) return undefined;
	if (rawKind !== "issues" && rawKind !== "pulls") return undefined;
	try {
		return {
			server: validateSegment(url.hostname, "server"),
			owner: validateSegment(owner, "owner"),
			repo: validateSegment(repo, "repository"),
			kind: rawKind === "issues" ? "issue" : "pull",
			index,
		};
	} catch {
		return undefined;
	}
}

export function formatResourceRef(ref: ResourceRef): string {
	return `${ref.server}:${ref.owner}/${ref.repo}${ref.kind === "issue" ? "#" : "!"}${ref.index}`;
}

export function formatCanonicalRef(ref: ResourceRef): string {
	const kind = ref.kind === "issue" ? "issues" : "pulls";
	return `fj://${ref.server}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${kind}/${ref.index}`;
}

export function formatRepoRef(ref: RepoRef): string {
	return `${ref.server}:${ref.owner}/${ref.repo}`;
}

export function resourceWebUrl(
	ref: ResourceRef,
	server: ForgejoServerConfig,
): string {
	const kind = ref.kind === "issue" ? "issues" : "pulls";
	return `${server.baseUrl}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${kind}/${ref.index}`;
}

export function repoWebUrl(ref: RepoRef, server: ForgejoServerConfig): string {
	return `${server.baseUrl}/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}
