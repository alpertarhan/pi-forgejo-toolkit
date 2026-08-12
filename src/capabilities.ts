import { ForgejoClientPool } from "./client.js";
import type { ForgejoCapabilities } from "./types.js";

export interface CapabilitySnapshot {
  values: Record<string, ForgejoCapabilities>;
  errors: Record<string, string>;
}

export class CapabilityRegistry {
  private snapshotValue: CapabilitySnapshot = { values: {}, errors: {} };

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

  async refresh(signal?: AbortSignal): Promise<CapabilitySnapshot> {
    const values: Record<string, ForgejoCapabilities> = {};
    const errors: Record<string, string> = {};
    await Promise.all(
      this.clients.entries().map(async ([alias, client]) => {
        try {
          values[alias] = await client.discoverCapabilities(signal);
        } catch (error) {
          errors[alias] = error instanceof Error ? error.message : String(error);
        }
      }),
    );
    this.snapshotValue = { values, errors };
    return this.snapshot();
  }
}
