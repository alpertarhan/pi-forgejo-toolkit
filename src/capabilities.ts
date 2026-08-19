import { waitWithSignal } from "./abort.js";
import type { ForgejoClientPool } from "./client.js";
import type { ForgejoCapabilities } from "./types.js";

export interface CapabilitySnapshot {
	values: Record<string, ForgejoCapabilities>;
	errors: Record<string, string>;
}

export class CapabilityRegistry {
	private snapshotValue: CapabilitySnapshot = { values: {}, errors: {} };
	private readonly pending = new Map<string, Promise<ForgejoCapabilities>>();
	private readonly controller = new AbortController();
	private closed = false;

	constructor(private readonly clients: ForgejoClientPool) {}

	snapshot(): CapabilitySnapshot {
		return {
			values: { ...this.snapshotValue.values },
			errors: { ...this.snapshotValue.errors },
		};
	}

	get(alias: string): ForgejoCapabilities | undefined {
		return this.snapshotValue.values[alias];
	}

	async refreshAlias(
		alias: string,
		signal?: AbortSignal,
		force = false,
	): Promise<ForgejoCapabilities> {
		if (this.closed) throw new Error("capability registry is closed");
		signal?.throwIfAborted();
		const cached = this.snapshotValue.values[alias];
		if (!force && cached) return cached;
		let pending = this.pending.get(alias);
		if (!pending) {
			const client = this.clients.get(alias);
			pending = client
				.discoverCapabilities(this.controller.signal)
				.then((value) => {
					const { [alias]: _removed, ...errors } = this.snapshotValue.errors;
					this.snapshotValue = {
						values: { ...this.snapshotValue.values, [alias]: value },
						errors,
					};
					return value;
				})
				.catch((error: unknown) => {
					const { [alias]: _removed, ...values } = this.snapshotValue.values;
					this.snapshotValue = {
						values,
						errors: {
							...this.snapshotValue.errors,
							[alias]: error instanceof Error ? error.message : String(error),
						},
					};
					throw error;
				})
				.finally(() => {
					if (this.pending.get(alias) === pending) this.pending.delete(alias);
				});
			this.pending.set(alias, pending);
		}
		return waitWithSignal(pending, signal);
	}

	async refresh(
		signal?: AbortSignal,
		force = false,
	): Promise<CapabilitySnapshot> {
		await Promise.allSettled(
			this.clients
				.aliases()
				.map((alias) => this.refreshAlias(alias, signal, force)),
		);
		return this.snapshot();
	}

	close(): void {
		this.closed = true;
		this.controller.abort();
	}
}
