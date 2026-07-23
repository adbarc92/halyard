import type { Surface } from "../../config/primitives.js";
import type { SentryClient, SentryStats } from "./types.js";
import { fetchWithTimeout } from "../../net.js";

/**
 * Live Sentry client — reads release health (crash-free %, event count) from the Sentry
 * sessions API. Credentials from the environment (secret store), never config/logs.
 *
 * Not exercised by the test suite (live network); triage logic is verified with a fake.
 * NOTE (§5): the latency-sensitive flag-kill path runs out of band from the reconcile
 * cron — a Sentry alert fires repository_dispatch(sentry-alert) → `.github/workflows/
 * sentry-alert.yml` → `halyard triage` immediately, so a spike pages you in seconds rather
 * than waiting up to the full reconcile interval.
 */
export class LiveSentryClient implements SentryClient {
  constructor(
    private readonly org: string,
    private readonly project: string,
  ) {}

  async getReleaseHealth(app: string, surface: Surface, version: string): Promise<SentryStats> {
    const token = process.env.SENTRY_AUTH_TOKEN;
    if (!token) throw new Error("SENTRY_AUTH_TOKEN not set");

    const release = `${app}-${surface}@${version}`;
    const url =
      `https://sentry.io/api/0/organizations/${this.org}/sessions/` +
      `?project=${encodeURIComponent(this.project)}&field=crash_free_rate(session)&field=sum(session)` +
      `&query=${encodeURIComponent(`release:${release}`)}&statsPeriod=24h`;

    const res = await fetchWithTimeout(fetch, url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Sentry API ${res.status}`);
    const body = (await res.json()) as {
      groups?: Array<{ totals?: Record<string, number> }>;
    };
    const totals = body.groups?.[0]?.totals ?? {};
    const crashFreeRate = totals["crash_free_rate(session)"] ?? 1;
    const sessions = totals["sum(session)"] ?? 0;
    return {
      crashFreePct: Math.round(crashFreeRate * 1000) / 10,
      eventCount: sessions,
      topIssueTitle: `release ${release}`,
    };
  }
}
