# Launch campaign strategy — announcing Halyard

A social-media + community plan for introducing Halyard as a product. Halyard is itself a
publicity coordinator, so the campaign is also a proof point — and can be **run through
Halyard** (see "Dogfood" at the end).

---

## 1. Positioning

**One line:** *Halyard is the release coordinator for shops that ship many apps — where the
flag flip, not the store approval, is the launch.*

**The wedge (why it exists):** a CI pipeline is a single linear run, and that model breaks the
moment App Store review enters — no job sits open for the hours-to-days a review takes. Halyard
replaces the pipeline with an **event-driven, git-backed state machine** where CI is just one
event source, and publicity + maintenance ride the same bus.

**Why believe it (the trust story — unusually resonant right now):**
- **No model decides ship / promote / flip / post.** Agents draft and classify into a queue;
  humans approve; deterministic boolean gates execute. "AI in the loop, never on the trigger."
- **Owned vs third-party is a hard safety boundary.** Owned channels auto-publish; third-party
  social only drafts and stages — the post button stays human.
- **Secrets are references, never values; the coordinator is a projection, never authority.**

These four invariants are the differentiator versus "yet another AI release bot." Lead with
them; they convert skeptics in this exact moment of AI-tooling fatigue.

---

## 2. Audience & where they are

| Segment | Pain Halyard hits | Where to reach them |
|---|---|---|
| Indie / solo devs with several apps | release + announce overhead per app; no time for a release team | X (#iosdev #androiddev), Reddit r/iOSProgramming r/androiddev r/reactnative, indie newsletters |
| Small mobile studios (2–15) | review-gated launches, coordinating flag flips + marketing | LinkedIn, mobile/dev Slack & Discord communities |
| Platform / release / DevEx engineers | pipelines that can't model review; flaky launch coordination | Hacker News, Lobsters, r/devops, eng blogs |
| Eng leaders / founders | "launch" risk, repeatability across a portfolio | LinkedIn, founder communities, Show HN comments |

Primary beachhead: **HN + indie mobile dev (X/Reddit)** — they feel the review-vs-pipeline
pain most acutely and amplify well.

---

## 3. Narrative pillars (rotate across content)

1. **"The flag flip is the launch."** The core reframe; the name itself (a halyard raises a
   flag). Most memorable, lead with it.
2. **"Not a pipeline — a coordinator."** The architectural argument; for the platform-eng crowd.
3. **"AI in the loop, never on the trigger."** The trust/safety angle; gates are boolean.
4. **"Announce safely, across every app."** Owned auto-publish + third-party staged; the
   publicity model devs don't want to build themselves.

---

## 4. Channel strategy

Mirror Halyard's own owned-vs-third-party model:

- **Owned (you control, publish freely):** a launch blog post (the deep-dive), a waitlist /
  email list, the GitHub repo + README.
- **Earned (community, high-trust, one-shot — get them right):** **Show HN**, **Product Hunt**,
  **Lobsters**. These are the spikes; everything else feeds them.
- **Third-party social (amplify, human-posted):** an **X thread**, a **LinkedIn post**, follow-up
  replies. Staged and posted by a human — exactly the boundary Halyard enforces.

---

## 5. Launch-week calendar

**T-2 weeks — tease & seed**
- Waitlist landing page live (capture the flag-flip metaphor + a 20-sec demo GIF).
- 2–3 "build log" X/LinkedIn posts on a single sharp idea each (e.g. "why your release pipeline
  can't model App Store review").

**T-1 week — prime**
- Publish the technical deep-dive blog (link `design.md` / the five invariants).
- DM/email 10–20 friendly devs + a few newsletters for launch-day amplification.
- Final demo asset: 60–90s screen capture of `flip → live → owned auto-publish → third-party
  staged`, plus the architecture diagram.

**Launch day**
- **Show HN** in the morning (US) — title below; be present all day to answer.
- **Product Hunt** same day; rally the waitlist for early upvotes/comments.
- **X thread** (the reframe → demo → invariants → repo) + **LinkedIn** post.
- Cross-post to r/iOSProgramming, r/androiddev, r/devops with a genuine, non-salesy framing.

**T+1 → T+2 weeks — sustain**
- Reply/iterate from HN/PH feedback; ship a small visible improvement and post it ("you asked,
  here it is") — shows momentum and that humans run the loop.
- A follow-up post on one deep feature (re-entrant resubmit/rollback, or the agent queue).

---

## 6. Sample copy

**X thread (opener):**
> Your release pipeline can't model an App Store review. No CI job sits open for 3 days.
> So we stopped using a pipeline. Halyard makes the *flag flip* the launch — an event-driven,
> git-backed coordinator for shipping many apps. 🧵

**Show HN title:**
> Show HN: Halyard – a release coordinator where the flag flip, not store approval, is the launch

**Show HN blurb (first comment):**
> Built this after fighting CI pipelines for multi-app mobile releases. A pipeline is one linear
> run; App Store review breaks that. Halyard is a state machine with a durable git-backed
> coordinator — CI, review polling, flag flips, publicity, and maintenance are all event sources.
> Hard rule: no model decides ship/promote/flip/post — agents draft into a queue, humans approve,
> boolean gates execute. Owned channels auto-publish; third-party social only stages. Feedback welcome.

**Product Hunt tagline:**
> The release coordinator where flipping the flag is the launch.

**LinkedIn (leader angle):**
> Shipping a portfolio of apps shouldn't mean a release team per app. We built Halyard so a
> launch is one durable, auditable event — with AI in the loop for drafting, never on the
> trigger for shipping. Here's the thinking 👇

**Blog headline:**
> Halyard: why the flag flip — not the store approval — is the real launch

---

## 7. Metrics

- **Top of funnel:** waitlist signups, landing-page conversion, GitHub stars/watchers.
- **Spikes:** HN rank/points/comments, PH rank, referral traffic by source.
- **Activation (the real signal):** repos that install + run `verify:launch`, first real
  `halyard flip`, returning usage.
- Set a concrete launch-week target per metric in advance; review T+2 weeks.

---

## 8. Risks & guardrails

- **Don't overclaim.** It's a coordinator + conventions, not magic. The honesty *is* the pitch
  for this audience.
- **The "no AI on the trigger" line must stay true** — it's the trust hook; never soften it.
- **One-shot channels (HN/PH) get one shot** — land the demo + first comment; don't fire early.
- **Engage, don't broadcast.** This crowd rewards showing up in the comments over polished ads.

---

## 9. Dogfood it (the meta proof point)

Run the announcement *through Halyard*: model the launch as a `launch` record, let the **owned**
blog + waitlist email **auto-publish** on the `live` transition, and let the **X / LinkedIn**
posts **stage as proposals** you approve and post by hand. The campaign then demonstrates the
exact owned-vs-third-party boundary it's selling — and the approved posts seed the voice canon
for the next app's launch. The most credible demo is the product launching itself.
