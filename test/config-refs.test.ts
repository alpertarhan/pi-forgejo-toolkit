import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import {
	formatCanonicalRef,
	formatResourceRef,
	parseResourceRef,
} from "../src/refs.js";

const BASE_CONFIG = {
	servers: {
		work: {
			baseUrl: "https://forgejo.work.example/",
			tokenEnv: "FORGEJO_WORK_TOKEN",
			remoteHosts: ["forgejo-work"],
		},
	},
};

describe("Forgejo configuration", () => {
	it("normalizes servers and applies safe dashboard defaults", () => {
		const config = parseConfig(BASE_CONFIG);
		expect(config.servers.work).toEqual({
			baseUrl: "https://forgejo.work.example",
			hostname: "forgejo.work.example",
			credentialProvider: "env",
			tokenEnv: "FORGEJO_WORK_TOKEN",
			remoteHosts: ["forgejo.work.example", "forgejo-work"],
		});
		expect(config.dashboard).toEqual({
			enabled: true,
			scope: "all",
			refreshSeconds: 90,
			previewLimit: 3,
			notifications: "important",
			privacy: "full",
		});
	});

	it("accepts explicit CLI-independent API tokens through the environment provider", () => {
		const config = parseConfig({
			servers: {
				work: {
					hostname: "forgejo.work.example",
					credentialProvider: "env",
					tokenEnv: "FORGEJO_WORK_TOKEN",
				},
			},
		});

		expect(config.servers.work).toMatchObject({
			baseUrl: "https://forgejo.work.example",
			credentialProvider: "env",
			tokenEnv: "FORGEJO_WORK_TOKEN",
		});
	});

	it("merges project overrides without dropping global servers", () => {
		const config = parseConfig(BASE_CONFIG, {
			servers: {
				community: {
					baseUrl: "https://code.example.org/forgejo",
					tokenEnv: "FORGEJO_COMMUNITY_TOKEN",
				},
			},
			dashboard: { refreshSeconds: 120, privacy: "counts-only" },
		});
		expect(Object.keys(config.servers)).toEqual(["work", "community"]);
		expect(config.dashboard.refreshSeconds).toBe(120);
		expect(config.dashboard.privacy).toBe("counts-only");
	});

	it("rejects inline secrets and unsafe URLs", () => {
		expect(() =>
			parseConfig({
				servers: {
					work: {
						baseUrl: "https://user:secret@forgejo.example",
						tokenEnv: "TOKEN",
						token: "leak",
					},
				},
			}),
		).toThrow(ConfigError);
	});

	it("rejects credential fields belonging to another provider", () => {
		expect(() =>
			parseConfig({
				servers: {
					work: {
						hostname: "forgejo.work.example",
						credentialProvider: "env",
						tokenEnv: "FORGEJO_WORK_TOKEN",
						fgjConfig: "/tmp/fgj.yaml",
					},
				},
			}),
		).toThrow("fgjConfig cannot be used with credentialProvider 'env'");
		expect(() =>
			parseConfig({
				servers: {
					work: {
						hostname: "forgejo.work.example",
						credentialProvider: "fgj",
						tokenEnv: "FORGEJO_WORK_TOKEN",
					},
				},
			}),
		).toThrow("tokenEnv cannot be used with credentialProvider 'fgj'");
	});
});

describe("Forgejo references", () => {
	it("round-trips qualified issue and pull references", () => {
		const issue = parseResourceRef("work:platform/api#184");
		const pull = parseResourceRef("community:forge/runner!77");
		expect(issue).toEqual({
			server: "work",
			owner: "platform",
			repo: "api",
			kind: "issue",
			index: 184,
		});
		expect(pull).toEqual({
			server: "community",
			owner: "forge",
			repo: "runner",
			kind: "pull",
			index: 77,
		});
		expect(formatResourceRef(issue!)).toBe("work:platform/api#184");
		expect(formatCanonicalRef(pull!)).toBe(
			"fj://community/forge/runner/pulls/77",
		);
	});

	it("parses canonical refs but rejects unqualified numbers", () => {
		expect(parseResourceRef("fj://work/platform/api/issues/12")).toEqual({
			server: "work",
			owner: "platform",
			repo: "api",
			kind: "issue",
			index: 12,
		});
		expect(parseResourceRef("#12")).toBeUndefined();
		expect(parseResourceRef("work:platform/api!0")).toBeUndefined();
		expect(
			parseResourceRef("work:platform/api!9007199254740993"),
		).toBeUndefined();
		expect(
			parseResourceRef("fj://work/platform/api/pulls/9007199254740993"),
		).toBeUndefined();
		expect(
			parseResourceRef("fj://work/%E0%A4%A/api/issues/12"),
		).toBeUndefined();
	});
});
