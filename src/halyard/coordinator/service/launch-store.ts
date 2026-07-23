// src/halyard/coordinator/service/launch-store.ts
import { LaunchSchema, type Launch } from "../../contracts/launch.schema.js";
import type { LaunchStore } from "../ports.js";
import type { ServiceHttpClient } from "./client.js";

export class ServiceLaunchStore implements LaunchStore {
  constructor(private readonly client: ServiceHttpClient) {}

  async read(launchId: string): Promise<Launch | null> {
    const raw = await this.client.getJson(`/launches/${encodeURIComponent(launchId)}`);
    return raw === null ? null : LaunchSchema.parse(raw);
  }

  async write(launch: Launch): Promise<void> {
    await this.client.sendJson("PUT", `/launches/${encodeURIComponent(launch.launch_id)}`, launch);
  }

  async scanIds(): Promise<string[]> {
    const raw = (await this.client.getJson("/launches")) as string[] | null;
    return (raw ?? []).slice().sort(); // bare sort, matching scanLaunchIds
  }
}
