// src/halyard/coordinator/service/record-store.ts
import { ReleaseSchema, type Release } from "../../contracts/release.schema.js";
import type { RecordStore } from "../ports.js";
import type { ServiceHttpClient } from "./client.js";

/** Release records over the Halyard state service. Validates on read (invariant #1); sorts ids client-side (git parity). */
export class ServiceRecordStore implements RecordStore {
  constructor(private readonly client: ServiceHttpClient) {}

  async read(releaseId: string): Promise<Release | null> {
    const raw = await this.client.getJson(`/releases/${encodeURIComponent(releaseId)}`);
    return raw === null ? null : ReleaseSchema.parse(raw);
  }

  async write(release: Release): Promise<void> {
    await this.client.sendJson("PUT", `/releases/${encodeURIComponent(release.release_id)}`, release);
  }

  async scanIds(): Promise<string[]> {
    const raw = (await this.client.getJson("/releases")) as string[] | null;
    return (raw ?? []).slice().sort(); // bare sort, matching scanReleaseIds
  }
}
