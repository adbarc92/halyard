<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import { base } from "$app/paths";
  import { errorMessage } from "$lib/errors.js";

  let { data }: { data: PageData } = $props();
  let busy = $state(false);
  // Last cycle's summary, surfaced to the operator (the endpoints return rich counts that were
  // previously discarded). Cleared on dismiss; replaced on each run.
  let summary = $state<string | null>(null);

  async function reconcile() {
    busy = true;
    summary = null;
    try {
      const res = await fetch(`${base}/api/reconcile`, { method: "POST" });
      if (!res.ok) {
        alert(await errorMessage(res, "reconcile failed"));
        return;
      }
      const { report } = await res.json();
      summary =
        `Reconcile: scanned ${report.scanned}, ${report.applied.length} transition(s)` +
        (report.errors.length ? `, ${report.errors.length} source error(s)` : "");
      await invalidateAll();
    } finally {
      busy = false;
    }
  }

  async function reconcileFull() {
    busy = true;
    summary = null;
    try {
      const res = await fetch(`${base}/api/reconcile-full`, { method: "POST" });
      if (!res.ok) {
        alert(await errorMessage(res, "full reconcile failed"));
        return;
      }
      const { report } = await res.json();
      summary =
        `Full reconcile: ${report.reconcile.applied.length} transition(s), ` +
        `${report.graduationProposals} graduation, ${report.publicityFanouts} publicity, ` +
        `${report.triageProposals} triage, ${report.rejectionProposals} rejection proposal(s)` +
        (report.reconcile.errors.length ? `, ${report.reconcile.errors.length} source error(s)` : "");
      await invalidateAll();
    } finally {
      busy = false;
    }
  }

  function stateBadge(state: string): string {
    const s = state.toLowerCase();
    if (s === "live")          return "badge badge-live";
    if (s === "dead" || s === "rejected" || s === "rolled_back") return "badge badge-dead";
    if (s === "stuck" || s === "waiting") return "badge badge-amber";
    if (s.includes("pending") || s.includes("approved") || s.includes("in_progress")) return "badge badge-blue";
    return "badge badge-neutral";
  }
</script>

<div class="page">
  <div class="page-header">
    <h1>Release status</h1>
    <div class="page-actions">
      <button class="btn btn-secondary btn-sm" onclick={() => invalidateAll()}>Refresh</button>
      <button class="btn btn-primary btn-sm" onclick={reconcile} disabled={busy}>
        {busy ? "Running…" : "Reconcile now"}
      </button>
      <button class="btn btn-primary btn-sm" onclick={reconcileFull} disabled={busy}>
        {busy ? "Running…" : "Full reconcile"}
      </button>
    </div>
  </div>

  {#if summary}
    <section class="alert" role="status" style="border-color:var(--ok,#2f855a);">
      {summary}
      <button class="btn btn-secondary btn-sm" style="margin-left:0.5rem;" onclick={() => (summary = null)}>Dismiss</button>
    </section>
  {/if}

  {#if data.errors.length}
    <section class="alert" role="alert">
      <h2>Coordinator errors</h2>
      <ul>
        {#each data.errors as e}
          <li>{e.title} — {e.body}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if data.releases.length === 0}
    <div class="empty-state">No releases in this project yet.</div>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Release</th>
          <th>App</th>
          <th>Surface</th>
          <th>Ver</th>
          <th>State</th>
          <th>Waiting on</th>
          <th>Age (h)</th>
          <th>Flag</th>
        </tr>
      </thead>
      <tbody>
        {#each data.releases as r}
          <tr>
            <td class="td-id">
              <a href={`${base}/releases/${r.release_id}`}>{r.release_id}</a>
            </td>
            <td class="td-dim">{r.app}</td>
            <td class="td-dim">{r.surface}</td>
            <td class="td-mute">{r.version}</td>
            <td>
              <span class={stateBadge(r.state)}>{r.state}</span>
              {#if r.stuck}<span class="badge badge-amber" style="margin-left:0.25rem;" title="Stuck">stuck</span>{/if}
            </td>
            <td class="td-dim">{r.waiting_on || "—"}</td>
            <td class="td-mute">{r.age_hours ?? "—"}</td>
            <td class="td-mute mono">
              {#if r.flag}
                {r.flag}
                {#if r.flag_state}
                  <span class="badge {r.flag_state === 'on' ? 'badge-live' : 'badge-neutral'}" style="margin-left:0.2rem;">{r.flag_state}</span>
                {/if}
              {:else}
                —
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
