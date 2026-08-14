import { describe, expect, it, vi } from "vitest";
import type { ForgejoClient, RequestOptions } from "../src/client.js";
import { labelIds } from "../src/tools/metadata.js";
import type { ForgejoLabel } from "../src/types.js";

function labels(start: number, count: number): ForgejoLabel[] {
	return Array.from({ length: count }, (_, index) => ({
		id: start + index,
		name: `label-${start + index}`,
		color: "ffffff",
	}));
}

describe("label metadata pagination", () => {
	it("continues when Forgejo clamps the requested label page size", async () => {
		const request = vi.fn(async (_path: string, options?: RequestOptions) => ({
			data:
				options?.query?.page === 2
					? [{ id: 101, name: "security", color: "ff0000" }]
					: labels(1, 50),
			status: 200,
			headers: new Headers(),
		}));

		await expect(
			labelIds({ request } as unknown as ForgejoClient, "acme", "app", [
				"security",
				"label-2",
			]),
		).resolves.toEqual([101, 2]);
		expect(request.mock.calls.map((call) => call[1]?.query?.page)).toEqual([
			1, 2,
		]);
	});
});
