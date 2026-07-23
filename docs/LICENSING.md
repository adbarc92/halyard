# Licensing (open-core)

Halyard is **open-core**: the core — release coordination, the state machine, reconcile,
publicity fan-out, the approval queue, maintenance, preflight — is **free**. A paid **Pro**
tier unlocks the features below. Licensing is **offline**: a signed key is verified locally
(Ed25519), so Pro works air-gapped and there is no licensing server in the request path.

## Pro features

| Feature | Free behavior | Pro behavior |
|---|---|---|
| `ai-agents` | deterministic templates / rule classifier | Anthropic-backed drafting + triage classification |
| `auto-merge` | Renovate updates are proposed (dry-run) | patch/minor PRs auto-merge (with `HALYARD_LIVE_MERGE`) |
| `multi-app` | one app | coordinate many apps in one shop |

Unlicensed, these **degrade safely** (templates, dry-run) — except `multi-app`, which fails
loud rather than silently dropping an app.

## Using a license (customer)

Set the license token in the environment; that's it:

```bash
export HALYARD_LICENSE_KEY="<token>"
halyard license          # inspect the resolved tier / features / expiry
```

Resolution is **fail-safe**: an absent, malformed, or expired token resolves to FREE — never
an error, never an accidental Pro. A library consumer can instead inject its own resolution
with `setEntitlement(...)` from the package.

## Issuing licenses (vendor)

Licenses are signed with an Ed25519 private key whose public half is the verifier embedded in
`src/halyard/licensing/license.ts` (override per-deployment with `HALYARD_LICENSE_PUBKEY`).

1. **Generate a keypair once** (keep the private key offline; publish the public key as the
   verifier):
   ```bash
   node -e "const{generateKeyPairSync}=require('crypto');const{publicKey,privateKey}=generateKeyPairSync('ed25519');console.log(publicKey.export({type:'spki',format:'pem'}).toString());console.log(privateKey.export({type:'pkcs8',format:'pem'}).toString())"
   ```
2. **Issue a license:**
   ```bash
   HALYARD_LICENSE_PRIVATE_KEY="$(cat halyard-license.key)" \
     npm run issue:license -- --licensee "Acme Inc" --features ai-agents,auto-merge,multi-app [--expires 2027-01-01]
   ```
   It prints the token (stdout) to hand to the customer. Omit `--features` for all Pro
   features; omit `--expires` for a perpetual license.

> The private key is **never** committed. The token is a signature over
> `{licensee, tier, features, issued, expires?}` — it grants exactly the features it lists.

## Self-hosting your own portfolio

If you are the operator running Halyard on your **own** instance — coordinating your own
portfolio of apps (multi-app acting) — you don't need to buy a license from yourself. There
are two supported paths, and the gate now accepts **either a valid signed key OR the
self-host flag**.

### Option A — the self-host flag (simplest)

Set one environment variable on the machine that runs Halyard:

```bash
export HALYARD_SELF_HOST=1          # also accepts true / yes / on
halyard license                     # shows tier "pro", licensee "self-host"
```

This unlocks **all Pro features** (`ai-agents`, `auto-merge`, `multi-app`) for your own
instance. It is **explicit and auditable**, never a silent bypass:

- `halyard license` reports `"licensee": "self-host"`, so the grant is visible at a glance.
- The entitlement carries a `grant: "self-host"` and a human-readable `reason`, and Halyard
  logs the reason once on first resolution (`halyard: self-host entitlement …`).
- It composes **additively** with the gate: it grants Pro only when *you* set the flag on the
  process environment — the same trust boundary as holding the license key. A random external
  consumer of the library/CLI has neither a valid key nor your flag, so they stay gated.

Crucially, this **does not weaken the paid key path.** The signed-key check runs first and is
unchanged — a forged, expired, or wrong-key token still resolves to FREE (fail-safe). The
self-host flag is only consulted *after* that check falls through.

### Option B — self-issue a Pro key (keep the signed-key path)

If you'd rather run through the real Ed25519 verification (e.g. to mirror production exactly,
or to hand a scoped key to a self-hosted teammate), issue yourself a key:

1. **Generate a keypair once** (see *Issuing licenses* above) and publish the public half as
   the verifier: `export HALYARD_LICENSE_PUBKEY="$(cat halyard-license.pub)"`.
2. **Issue a license** with your private key:
   ```bash
   HALYARD_LICENSE_PRIVATE_KEY="$(cat halyard-license.key)" \
     npm run issue:license -- --licensee "My Portfolio" --features ai-agents,auto-merge,multi-app
   ```
3. **Use it:** `export HALYARD_LICENSE_KEY="<token>"`.

This grants Pro with `grant: "license"` and your real licensee name. Use Option A for
convenience; Option B when you want the full signed-key flow.

## Not this

Monetizing-as-hosted-SaaS (subscriptions, seats, a billing backend) is a separate, larger
roadmap item. This is the lightweight open-core entitlement layer, nothing more.
