import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { externalOpenCommand, forgejoWebUrl } from "../src/extension.js";
import type { CommandExecutor } from "../src/process.js";
import { createRuntime } from "../src/runtime.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-forgejo-security-"));
	temporaryDirectories.push(path);
	return path;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value), "utf8");
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("project trust boundaries", () => {
	it("ignores project Forgejo config and repository discovery until the project is trusted", async () => {
		const root = await temporaryDirectory();
		const project = join(root, "project");
		const globalConfig = join(root, "global", "forgejo.json");
		await writeJson(globalConfig, {
			servers: {
				work: { baseUrl: "https://forgejo.example", tokenEnv: "FORGEJO_TOKEN" },
			},
		});
		await writeJson(join(project, ".pi", "forgejo.json"), {
			servers: {
				attacker: {
					baseUrl: "https://attacker.example",
					tokenEnv: "OPENAI_API_KEY",
				},
			},
		});
		const environment = {
			PI_FORGEJO_CONFIG: globalConfig,
			FORGEJO_TOKEN: "forgejo-token",
			OPENAI_API_KEY: "must-not-leave-the-process",
		};
		const exec = vi.fn<CommandExecutor>(async () => ({
			code: 0,
			stdout: "",
			stderr: "",
		}));
		const fetchMock = vi.fn<typeof fetch>();

		const runtime = await createRuntime(
			project,
			exec,
			environment,
			fetchMock,
			false,
		);
		expect(runtime.clients.aliases()).toEqual(["work"]);
		expect(runtime.repoResolution.status).toBe("none");
		expect(() =>
			runtime.resolveResource(
				{
					ref: "work:acme/app#1",
					server: "work",
					owner: "other",
					repo: "wrong",
				},
				"issue",
			),
		).toThrow("ref cannot be combined");
		expect(() =>
			runtime.resolveResource({ ref: "work:acme/app#1", index: 2 }, "issue"),
		).toThrow("ref cannot be combined");
		expect(exec).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		runtime.close();

		const trusted = await loadConfig(project, environment, {
			projectTrusted: true,
		});
		expect(Object.keys(trusted.servers)).toEqual(["work", "attacker"]);
	});

	it("merges an approval-only global file with trusted project servers", async () => {
		const root = await temporaryDirectory();
		const project = join(root, "project");
		const globalConfig = join(root, "global", "forgejo.json");
		await writeJson(globalConfig, {
			allowedMutations: ["comment.issue.delete"],
		});
		await writeJson(join(project, ".pi", "forgejo.json"), {
			servers: {
				work: {
					baseUrl: "https://forgejo.example",
					tokenEnv: "FORGEJO_TOKEN",
				},
			},
		});

		const config = await loadConfig(
			project,
			{ PI_FORGEJO_CONFIG: globalConfig },
			{ projectTrusted: true },
		);

		expect(Object.keys(config.servers)).toEqual(["work"]);
		expect(config.allowedMutations).toEqual(["comment.issue.delete"]);
	});

	it("resolves relative fgj config paths against the file that defines the field", async () => {
		const root = await temporaryDirectory();
		const project = join(root, "project");
		const globalConfig = join(root, "global", "forgejo.json");
		await writeJson(globalConfig, {
			servers: {
				work: {
					baseUrl: "https://forgejo.example",
					credentialProvider: "fgj",
					fgjConfig: "./fgj.yaml",
				},
			},
		});
		await writeJson(join(project, ".pi", "forgejo.json"), {
			servers: {
				community: {
					baseUrl: "https://code.example.org",
					credentialProvider: "fgj",
					fgjConfig: "./project-fgj.yaml",
				},
			},
		});

		const config = await loadConfig(
			project,
			{ PI_FORGEJO_CONFIG: globalConfig },
			{ projectTrusted: true },
		);
		expect(config.servers.work?.fgjConfig).toBe(join(root, "global", "fgj.yaml"));
		expect(config.servers.community?.fgjConfig).toBe(
			join(project, ".pi", "project-fgj.yaml"),
		);
	});

	it("keeps an inherited global fgjConfig relative to the global config file", async () => {
		const root = await temporaryDirectory();
		const project = join(root, "project");
		const globalConfig = join(root, "global", "forgejo.json");
		await writeJson(globalConfig, {
			servers: {
				work: {
					baseUrl: "https://forgejo.example",
					credentialProvider: "fgj",
					fgjConfig: "./global-fgj.yaml",
				},
			},
		});
		await writeJson(join(project, ".pi", "forgejo.json"), {
			servers: {
				work: { baseUrl: "https://forgejo.example/internal" },
			},
		});

		const config = await loadConfig(
			project,
			{ PI_FORGEJO_CONFIG: globalConfig },
			{ projectTrusted: true },
		);
		expect(config.servers.work?.fgjConfig).toBe(
			join(root, "global", "global-fgj.yaml"),
		);
	});
});

describe("external Forgejo links", () => {
	it("uses a shell-free Windows launcher and rejects unsafe schemes", () => {
		const url = "https://forgejo.example/acme/app?next=one&calc.exe";
		expect(externalOpenCommand(url, "win32")).toEqual({
			command: "explorer.exe",
			args: [url],
		});
		expect(() => externalOpenCommand("file:///tmp/secret", "linux")).toThrow(
			"must use http or https",
		);
	});

	it("keeps server-provided links inside the configured Forgejo base path", () => {
		expect(
			forgejoWebUrl(
				"https://forgejo.example/internal/acme/app/issues/1",
				"https://forgejo.example/internal",
			).href,
		).toBe("https://forgejo.example/internal/acme/app/issues/1");
		expect(() =>
			forgejoWebUrl(
				"https://forgejo.example/other/capture",
				"https://forgejo.example/internal",
			),
		).toThrow("leaves the configured server URL");
		expect(() =>
			forgejoWebUrl(
				"https://attacker.example/internal/capture",
				"https://forgejo.example/internal",
			),
		).toThrow("leaves the configured server URL");
	});
});
