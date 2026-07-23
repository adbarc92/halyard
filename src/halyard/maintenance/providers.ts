import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { fetchWithTimeout } from "../net.js";
import type {
  CertExpiryProvider,
  CertKind,
  CertStatus,
  DependencyUpdate,
  DependencyUpdateProvider,
  MergeClient,
  PlatformDeadline,
  PlatformDeadlineProvider,
} from "./types.js";

// Env/secret-sourced JSON is untrusted input — validate it against a schema before it
// reaches a proposal body or (for dependency updates) the auto-merge path, rather than
// casting `JSON.parse(...) as T`.
const DeadlinesSchema = z.array(
  z.object({ id: z.string().min(1), title: z.string().min(1), date: z.string().min(1) }).strict(),
);
const DependencyUpdatesSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      updateType: z.enum(["patch", "minor", "major"]),
      from: z.string().min(1),
      to: z.string().min(1),
      pr: z.number().int().positive(),
    })
    .strict(),
);

/**
 * Default providers read from the environment / secret store — a humble but real source
 * you can populate from upstream (a cert manager, a synced calendar export, a Renovate
 * dashboard). Production swaps richer API clients behind the same ports (Apple cert API,
 * Google Calendar, GitHub) without touching the watchers.
 */

export class EnvCertProvider implements CertExpiryProvider {
  async getCertStatus(_app: string, kind: CertKind): Promise<CertStatus> {
    const notAfter = process.env[`HALYARD_CERT_${kind.toUpperCase()}`];
    if (!notAfter) throw new Error(`HALYARD_CERT_${kind.toUpperCase()} not set`);
    return { kind, notAfter };
  }
}

export class EnvDeadlineProvider implements PlatformDeadlineProvider {
  async getDeadlines(_app: string): Promise<PlatformDeadline[]> {
    const raw = process.env.HALYARD_DEADLINES;
    if (!raw) throw new Error("HALYARD_DEADLINES not set");
    return DeadlinesSchema.parse(JSON.parse(raw));
  }
}

export class EnvDependencyProvider implements DependencyUpdateProvider {
  async listUpdates(_app: string): Promise<DependencyUpdate[]> {
    const raw = process.env.HALYARD_DEP_UPDATES;
    if (!raw) throw new Error("HALYARD_DEP_UPDATES not set");
    return DependencyUpdatesSchema.parse(JSON.parse(raw));
  }
}

/**
 * Records an auto-merge decision to disk instead of merging — the safe default. The
 * actual merge is an outward-facing action, so it only happens with the live client.
 */
export class DryRunMergeClient implements MergeClient {
  constructor(private readonly stateDir: string, private readonly now: () => string) {}
  async merge(repo: string, pr: number): Promise<void> {
    const safeRepo = repo.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = join(this.stateDir, "maintenance", "merged", `${safeRepo}_${pr}.json`);
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ repo, pr, merged_at: this.now(), mode: "dry_run" }, null, 2) + "\n", "utf8");
  }
}

/**
 * Real GitHub merge (outward-facing). The repo is passed per call (resolved from the
 * app's config) — never a hardcoded default — and the `owner/name` shape is validated
 * before it reaches the URL. Token from the secret store; not run in tests.
 */
export class GitHubMergeClient implements MergeClient {
  async merge(repo: string, pr: number): Promise<void> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`refusing to merge into malformed repo "${repo}"`);
    }
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN not set");
    const res = await fetchWithTimeout(fetch, `https://api.github.com/repos/${repo}/pulls/${pr}/merge`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      body: JSON.stringify({ merge_method: "squash" }),
    });
    if (!res.ok) throw new Error(`GitHub merge ${res.status}`);
  }
}
