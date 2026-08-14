import { describe, expect, it, vi } from "vitest";
import { CapabilityRegistry } from "../src/capabilities.js";
import { ForgejoClientPool, type ForgejoClient } from "../src/client.js";
import type { ForgejoCapabilities } from "../src/types.js";

function capability(server: string): ForgejoCapabilities {
	return {
		server,
		version: "16.0.2",
		user: { id: 1, login: server },
		paging: {},
		features: {
			dashboardSearch: true,
			notifications: true,
			reviews: true,
			actionsRuns: "available",
			actionsDispatch: "available",
			actionsCancel: "available",
			actionsRerun: "available",
			actionsArtifacts: "available",
		},
	};
}

describe("CapabilityRegistry", () => {
	it("refreshes one alias, caches it, and coalesces concurrent discovery", async () => {
		const work = {
			discoverCapabilities: vi.fn(async () => capability("work")),
		} as unknown as ForgejoClient;
		const community = {
			discoverCapabilities: vi.fn(async () => capability("community")),
		} as unknown as ForgejoClient;
		const registry = new CapabilityRegistry(
			new ForgejoClientPool({ work, community }),
		);

		const [first, second] = await Promise.all([
			registry.refreshAlias("work"),
			registry.refreshAlias("work"),
		]);
		expect(first.server).toBe("work");
		expect(second.server).toBe("work");
		expect(work.discoverCapabilities).toHaveBeenCalledOnce();
		expect(community.discoverCapabilities).not.toHaveBeenCalled();

		await registry.refreshAlias("work");
		expect(work.discoverCapabilities).toHaveBeenCalledOnce();
		await registry.refreshAlias("work", undefined, true);
		expect(work.discoverCapabilities).toHaveBeenCalledTimes(2);

		await registry.refresh(undefined, true);
		expect(work.discoverCapabilities).toHaveBeenCalledTimes(3);
		expect(community.discoverCapabilities).toHaveBeenCalledOnce();
	});

	it("drops stale capability values when a forced refresh fails", async () => {
		const discoverCapabilities = vi
			.fn<() => Promise<ForgejoCapabilities>>()
			.mockResolvedValueOnce(capability("work"))
			.mockRejectedValueOnce(new Error("server unavailable"));
		const registry = new CapabilityRegistry(
			new ForgejoClientPool({
				work: { discoverCapabilities } as unknown as ForgejoClient,
			}),
		);
		await registry.refreshAlias("work");

		await expect(
			registry.refreshAlias("work", undefined, true),
		).rejects.toThrow("server unavailable");
		expect(registry.snapshot()).toEqual({
			values: {},
			errors: { work: "server unavailable" },
		});
	});
});
