import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("proper-lockfile", () => ({
	lock: vi.fn(
		async (_target: string, options: { onCompromised(error: Error): void }) => {
			queueMicrotask(() =>
				options.onCompromised(new Error("lock heartbeat lost")),
			);
			return async () => {
				throw new Error("lock is already released");
			};
		},
	),
}));

import { parseConfig } from "../src/config.js";
import { writeForgejoConfigAtomic } from "../src/config-storage.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("Forgejo config storage", () => {
	it("reports a compromised lock through the operation instead of crashing Pi", async () => {
		const root = await mkdtemp(join(tmpdir(), "forgejo-config-storage-"));
		temporaryRoots.push(root);
		const target = join(root, "forgejo.json");
		const config = parseConfig({
			servers: {
				work: { hostname: "git.example", credentialProvider: "fgj" },
			},
		});

		await expect(
			writeForgejoConfigAtomic(target, config, undefined),
		).rejects.toThrow("config lock was compromised: lock heartbeat lost");
		expect(JSON.parse(await readFile(target, "utf8"))).toEqual(config);
	});
});
