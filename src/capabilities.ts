import type { ForgejoClientPool } from "./client.js";
import type { ForgejoCapabilities } from "./types.js";

export interface CapabilitySnapshot {
  values: Record<string, ForgejoCapabilities>;
  errors: Record<string, string>;
}

export class CapabilityRegistry {
  private snapshotValue: CapabilitySnapshot = { values: {}, errors: {} };
	private readonly pending = new Map<string, Promise<ForgejoCapabilities>>();

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
		const cached = this.snapshotValue.values[alias];
		if (!force && cached) return cached;
		const client = this.clients.get(alias);
		const existing = this.pending.get(alias);
		if (existing) return existing;
		const pending = client.discoverCapabilities(signal);
		this.pending.set(alias, pending);
        try {
			const value = await pending;
			const { [alias]: _removed, ...errors } = this.snapshotValue.errors;
			this.snapshotValue = {
				values: { ...this.snapshotValue.values, [alias]: value },
				errors,
			};
			return value;
        } catch (error) {
			const { [alias]: _removed, ...values } = this.snapshotValue.values;
			this.snapshotValue = {
				values,
				errors: {
					...this.snapshotValue.errors,
					[alias]: error instanceof Error ? error.message : String(error),
				},
			};
			throw error;
		} finally {
			if (this.pending.get(alias) === pending) this.pending.delete(alias);
        }
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
}
