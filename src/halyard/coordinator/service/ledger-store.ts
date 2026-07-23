// src/halyard/coordinator/service/ledger-store.ts
import type { LedgerStore } from "../ports.js";
import type { ServiceHttpClient } from "./client.js";

/** Publicity ledger over the service. `markAnnounced` is the one accumulating endpoint (server set-union). */
export class ServiceLedgerStore implements LedgerStore {
  constructor(private readonly client: ServiceHttpClient) {}

  async readAnnounced(launchId: string): Promise<Set<string>> {
    const raw = (await this.client.getJson(`/ledgers/${encodeURIComponent(launchId)}`)) as string[] | null;
    return new Set(raw ?? []);
  }

  async markAnnounced(launchId: string, scopeKey: string): Promise<void> {
    await this.client.sendJson("POST", `/ledgers/${encodeURIComponent(launchId)}/announced`, { key: scopeKey });
  }
}
