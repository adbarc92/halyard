// src/halyard/coordinator/service/canon-store.ts
import type { CanonEntry } from "../../publicity/canon-store.js";
import type { CanonStore } from "../ports.js";
import type { ServiceHttpClient } from "./client.js";

export class ServiceCanonStore implements CanonStore {
  constructor(private readonly client: ServiceHttpClient) {}

  async append(entry: CanonEntry): Promise<boolean> {
    const body = (await this.client.sendJson("PUT", `/canon/${encodeURIComponent(entry.id)}`, entry)) as { created: boolean };
    return body.created;
  }
}
