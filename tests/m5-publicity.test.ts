import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig, validateOrgConfig } from "../src/halyard/config/loader.js";
import { newLaunch, bindReleaseToLaunch, linkRelease, writeLaunch } from "../src/halyard/coordinator/launch-store.js";
import { appendTransition, newRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { listProposals } from "../src/halyard/coordinator/proposals.js";
import { firePublicity } from "../src/halyard/publicity/trigger.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { TemplateDrafter } from "../src/halyard/publicity/template-drafter.js";
import { FilePublisher, readPublished } from "../src/halyard/publicity/publishers.js";
import { FileNotifier } from "../src/halyard/publicity/notify.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2025-06-05T09:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-m5-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

/** A launch (per_surface, standard tier) with an iOS release driven to `live`. */
function setupLiveLaunch(): void {
  const launch = newLaunch({
    app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "Aurora works on the subway.",
    announcePolicy: "per_surface", tier: "standard", flag: "launch.aurora.offline_sync",
    createdBy: "alex", createdAt: now(),
  });
  let r = bindReleaseToLaunch(
    newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" }),
    launch,
  );
  for (const to of ["tagged", "built", "tested", "uploaded", "in_review", "shipped_dark", "live"] as const) {
    r = appendTransition(r, to, "ci", now);
  }
  writeRelease(stateDir, r);
  writeLaunch(stateDir, linkRelease(launch, r.release_id));
}

function deps() {
  return {
    org, apps: [app],
    drafter: new TemplateDrafter(),
    publisher: new FilePublisher(stateDir, now),
    notifier: new FileNotifier(stateDir, now),
    voiceCanon: [] as string[],
    backend, now,
  };
}

describe("M5 verify: going live drafts all variants; owned auto-publishes, third-party stages only", () => {
  it("owned channels auto-publish; third-party are staged + notified, never posted", async () => {
    setupLiveLaunch();
    const results = await firePublicity(deps());

    expect(results).toHaveLength(1);
    const outcomes = results[0]!.outcomes;
    const byChannel = Object.fromEntries(outcomes.map((o) => [o.channel, o.action]));

    // app aurora enables [blog, waitlist_email, x, linkedin].
    expect(byChannel.blog).toBe("published"); // owned → auto-publish
    expect(byChannel.waitlist_email).toBe("published"); // owned → auto-publish
    expect(byChannel.x).toBe("staged"); // third-party → stage only
    expect(byChannel.linkedin).toBe("staged");

    // Owned artifacts are on disk; both owned channels, nothing third-party.
    const published = readPublished(stateDir);
    expect(published.some((id) => id.startsWith("pub_blog_"))).toBe(true);
    expect(published.some((id) => id.startsWith("pub_waitlist_email_"))).toBe(true);
    expect(published.some((id) => id.includes("_x_") || id.includes("linkedin"))).toBe(false);

    // Third-party drafts are staged as open proposals...
    const proposals = listProposals(stateDir).filter((p) => p.kind === "social_post");
    expect(proposals.map((p) => p.channel).sort()).toEqual(["linkedin", "x"]);
    expect(proposals.every((p) => p.status === "open")).toBe(true);

    // ...and pushed to the mobile approval surface.
    const notifications = readdirSync(join(stateDir, "notifications"));
    expect(notifications).toHaveLength(2);
  });

  it("is idempotent: a second pass announces nothing new", async () => {
    setupLiveLaunch();
    await firePublicity(deps());
    const publishedAfterFirst = readPublished(stateDir).length;
    const proposalsAfterFirst = listProposals(stateDir).length;

    const second = await firePublicity(deps());
    expect(second).toHaveLength(0); // ledger says this surface is already announced
    expect(readPublished(stateDir).length).toBe(publishedAfterFirst);
    expect(listProposals(stateDir).length).toBe(proposalsAfterFirst);
  });

  it("does not fire before the release is live (only on the flag-flip)", async () => {
    const launch = newLaunch({
      app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "n",
      announcePolicy: "per_surface", tier: "standard", flag: "launch.aurora.offline_sync",
      createdBy: "alex", createdAt: now(),
    });
    let r = bindReleaseToLaunch(
      newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" }),
      launch,
    );
    // Parked at shipped_dark — approved but flag still OFF.
    for (const to of ["tagged", "built", "tested", "uploaded", "in_review", "shipped_dark"] as const) {
      r = appendTransition(r, to, "ci", now);
    }
    writeRelease(stateDir, r);
    writeLaunch(stateDir, linkRelease(launch, r.release_id));

    const results = await firePublicity(deps());
    expect(results).toHaveLength(0); // nothing live → no publicity
    expect(existsSync(join(stateDir, "notifications"))).toBe(false);
  });
});
