import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { saveAllowedMutation } from "../src/config-storage.js";
import {
	MUTATION_APPROVAL_KEYS,
	type MutationApprovalKey,
} from "../src/mutation-approvals.js";
import type { ForgejoRuntime } from "../src/runtime.js";
import { confirmMutation } from "../src/tools/common.js";

const ALLOW_ONCE = "Allow once";
const ALWAYS_SESSION =
	"Always allow on all servers and repositories this session";
const ALWAYS_SAVED =
	"Always allow on all servers and repositories (save globally)";
const CANCEL = "Cancel";
const APPROVAL = "pull.merge";
const NO_CONFIG = join(tmpdir(), `pi-forgejo-no-config-${process.pid}.json`);
const execFileAsync = promisify(execFile);

function context(choice: string | undefined, notify = vi.fn()) {
	const select = vi.fn(async () => choice);
	return {
		notify,
		select,
		ctx: { hasUI: true, ui: { select, notify } } as unknown as ExtensionContext,
	};
}

function runtime(globalConfigPath = NO_CONFIG) {
	return {
		config: {},
		globalConfigPath,
		sessionMutationApprovals: new Set<MutationApprovalKey>(),
	} as unknown as ForgejoRuntime;
}

function confirm(
	runtime: ForgejoRuntime,
	ctx: ExtensionContext,
	approval: MutationApprovalKey,
	title: string,
	message: string,
): Promise<void> {
	return confirmMutation(runtime, ctx, { approval, title, message });
}

const noUi = { hasUI: false } as ExtensionContext;
let counter = 0;
const nextTitle = () => `Test mutation ${++counter}`;

describe("mutation approval flow", () => {
	it("reads a global approval before every mutation", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forgejo-approvals-"));
		try {
			const configPath = join(dir, "forgejo.json");
			const title = nextTitle();
			await writeFile(
				configPath,
				JSON.stringify({ servers: {}, allowedMutations: [APPROVAL] }),
				"utf8",
			);
			const ui = context(ALLOW_ONCE);

			await confirm(runtime(configPath), ui.ctx, APPROVAL, title, "details");
			expect(ui.select).not.toHaveBeenCalled();
			await confirm(runtime(configPath), noUi, APPROVAL, title, "details");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("sees an approval saved by another active runtime", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forgejo-approvals-"));
		try {
			const configPath = join(dir, "forgejo.json");
			await writeFile(configPath, JSON.stringify({ servers: {} }), "utf8");
			const title = nextTitle();
			const firstRuntime = runtime(configPath);
			const secondRuntime = runtime(configPath);

			await confirm(
				firstRuntime,
				context(ALWAYS_SAVED).ctx,
				APPROVAL,
				title,
				"details",
			);
			await confirm(secondRuntime, noUi, APPROVAL, title, "details");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("still requires interactive confirmation without a UI or approval", async () => {
		await expect(
			confirm(runtime(), noUi, APPROVAL, nextTitle(), "details"),
		).rejects.toThrow("requires interactive confirmation");
	});

	it("prompts again for the same mutation when allowed once", async () => {
		const title = nextTitle();
		const session = runtime();
		const first = context(ALLOW_ONCE);
		await confirm(session, first.ctx, APPROVAL, title, "details");
		expect(first.select).toHaveBeenCalledWith(expect.stringContaining(title), [
			ALLOW_ONCE,
			ALWAYS_SESSION,
			ALWAYS_SAVED,
			CANCEL,
		]);

		const second = context(ALLOW_ONCE);
		await confirm(session, second.ctx, APPROVAL, title, "details");
		expect(second.select).toHaveBeenCalledOnce();
	});

	it("remembers a session approval without prompting again", async () => {
		const title = nextTitle();
		const session = runtime();
		await confirm(
			session,
			context(ALWAYS_SESSION).ctx,
			APPROVAL,
			title,
			"details",
		);

		const second = context(ALLOW_ONCE);
		await confirm(session, second.ctx, APPROVAL, title, "details");
		expect(second.select).not.toHaveBeenCalled();
	});

	it("does not carry a session approval into a new runtime", async () => {
		const title = nextTitle();
		await confirm(
			runtime(),
			context(ALWAYS_SESSION).ctx,
			APPROVAL,
			title,
			"details",
		);
		await expect(
			confirm(runtime(), noUi, APPROVAL, title, "details"),
		).rejects.toThrow("requires interactive confirmation");
	});

	it("treats Escape like cancellation", async () => {
		await expect(
			confirm(runtime(), context(undefined).ctx, APPROVAL, nextTitle(), "details"),
		).rejects.toThrow("cancelled by user");
	});

	it("saves an always-allowed mutation to the global config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forgejo-approvals-"));
		try {
			const configPath = join(dir, "forgejo.json");
			await writeFile(
				configPath,
				JSON.stringify({ servers: {}, dashboard: {} }),
				"utf8",
			);
			const title = nextTitle();
			await confirm(
				runtime(configPath),
				context(ALWAYS_SAVED).ctx,
				APPROVAL,
				title,
				"details",
			);

			const saved = JSON.parse(await readFile(configPath, "utf8"));
			expect(saved.allowedMutations).toEqual([APPROVAL]);
			expect(saved.servers).toEqual({});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves concurrent saves to the same global config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forgejo-approvals-"));
		try {
			const configPath = join(dir, "forgejo.json");
			await writeFile(configPath, JSON.stringify({ servers: {} }), "utf8");
			const approvals = [...MUTATION_APPROVAL_KEYS];

			await Promise.all(
				approvals.map((approval) => saveAllowedMutation(configPath, approval)),
			);

			const saved = JSON.parse(await readFile(configPath, "utf8"));
			expect([...saved.allowedMutations].sort()).toEqual([...approvals].sort());
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves saves from concurrent Pi processes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forgejo-approvals-"));
		try {
			const configPath = join(dir, "forgejo.json");
			await writeFile(configPath, JSON.stringify({ servers: {} }), "utf8");
			const approvals = MUTATION_APPROVAL_KEYS.slice(0, 10);
			const storageModule = new URL("../src/config-storage.ts", import.meta.url)
				.href;
			const script =
				"const { saveAllowedMutation } = await import(process.argv[1]); " +
				"await saveAllowedMutation(process.argv[2], process.argv[3]);";

			await Promise.all(
				approvals.map((approval) =>
					execFileAsync("bun", ["-e", script, storageModule, configPath, approval]),
				),
			);

			const saved = JSON.parse(await readFile(configPath, "utf8"));
			expect([...saved.allowedMutations].sort()).toEqual([...approvals].sort());
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("recovers a lock left behind by a crashed process", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forgejo-approvals-"));
		try {
			const configPath = join(dir, "forgejo.json");
			await writeFile(configPath, JSON.stringify({ servers: {} }), "utf8");
			const lockPath = `${configPath}.lock`;
			await mkdir(lockPath);
			const stale = new Date(Date.now() - 20_000);
			await utimes(lockPath, stale, stale);

			await saveAllowedMutation(configPath, APPROVAL);

			const saved = JSON.parse(await readFile(configPath, "utf8"));
			expect(saved.allowedMutations).toEqual([APPROVAL]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("warns but keeps the session approval when saving fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "forgejo-approvals-"));
		try {
			const parent = join(dir, "config");
			const configPath = join(parent, "forgejo.json");
			await mkdir(parent);
			await writeFile(configPath, JSON.stringify({ servers: {} }), "utf8");
			const notify = vi.fn();
			const select = vi.fn(async () => {
				await rm(parent, { recursive: true, force: true });
				await writeFile(parent, "blocker", "utf8");
				return ALWAYS_SAVED;
			});
			const ctx = {
				hasUI: true,
				ui: { select, notify },
			} as unknown as ExtensionContext;
			const session = runtime(configPath);
			const title = nextTitle();

			await confirm(session, ctx, APPROVAL, title, "details");
			expect(notify).toHaveBeenCalledOnce();
			await confirm(session, noUi, APPROVAL, title, "details");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects the mutation when cancelled", async () => {
		await expect(
			confirm(runtime(), context(CANCEL).ctx, APPROVAL, nextTitle(), "details"),
		).rejects.toThrow("cancelled by user");
	});
});
