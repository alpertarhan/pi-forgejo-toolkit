import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { parseAllowedMutationKeys } from "./config.js";
import type { MutationApprovalKey } from "./mutation-approvals.js";
import type { ForgejoConfig } from "./types.js";

export async function readConfigTextIfPresent(
	path: string,
): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function removeIfPresent(path: string): Promise<void> {
	try {
		await rm(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function withConfigLock<T>(
	target: string,
	action: () => Promise<T>,
): Promise<T> {
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	let compromised: Error | undefined;
	let actionFailed = false;
	const release = await lock(target, {
		realpath: false,
		stale: 10_000,
		update: 5_000,
		retries: {
			retries: 200,
			factor: 1.1,
			minTimeout: 10,
			maxTimeout: 100,
			randomize: true,
		},
		// The package default throws asynchronously and can terminate Pi.
		onCompromised: (error) => {
			compromised = error;
		},
	});
	try {
		const result = await action();
		if (compromised)
			throw new Error(
				`Forgejo config lock was compromised: ${compromised.message}`,
			);
		return result;
	} catch (error) {
		actionFailed = true;
		throw error;
	} finally {
		try {
			await release();
		} catch (error) {
			if (!compromised && !actionFailed) throw error;
		}
	}
}

async function writeJsonAtomicUnlocked(
	target: string,
	config: ForgejoConfig | Record<string, unknown>,
	expectedOriginal: string | undefined,
): Promise<void> {
	const current = await readConfigTextIfPresent(target);
	if (current !== expectedOriginal)
		throw new Error(
			`Forgejo config changed before it could be written: ${target}. Retry to avoid overwriting newer changes.`,
		);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const temporary = resolve(
		dirname(target),
		`.${basename(target)}.${randomUUID()}.tmp`,
	);
	await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	try {
		await rename(temporary, target);
	} finally {
		await removeIfPresent(temporary);
	}
}

export function writeForgejoConfigAtomic(
	target: string,
	config: ForgejoConfig,
	expectedOriginal: string | undefined,
): Promise<void> {
	return withConfigLock(target, () =>
		writeJsonAtomicUnlocked(target, config, expectedOriginal),
	);
}

function parseJsonObject(text: string, path: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError)
			throw new Error(`invalid JSON in Forgejo config ${path}: ${error.message}`);
		throw error;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error(`Forgejo config is not a JSON object: ${path}`);
	return parsed as Record<string, unknown>;
}

export function saveAllowedMutation(
	globalConfigPath: string,
	mutation: MutationApprovalKey,
): Promise<void> {
	return withConfigLock(globalConfigPath, async () => {
		const original = await readConfigTextIfPresent(globalConfigPath);
		const raw =
			original === undefined ? {} : parseJsonObject(original, globalConfigPath);
		const allowed = parseAllowedMutationKeys(raw.allowedMutations);
		if (!allowed.includes(mutation)) allowed.push(mutation);
		raw.allowedMutations = allowed;
		await writeJsonAtomicUnlocked(globalConfigPath, raw, original);
	});
}
