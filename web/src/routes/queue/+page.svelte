<script lang="ts">
  import type { PageData } from "./$types";
  import { invalidateAll } from "$app/navigation";
  import { base } from "$app/paths";
  import { errorMessage } from "$lib/errors.js";

  let { data }: { data: PageData } = $props();
  let edits   = $state<Record<string, string>>({});
  let pending = $state<Record<string, boolean>>({});

  async function approve(id: string) {
    if (pending[id]) return;
    pending[id] = true;
    try {
      const finalText = edits[id];
      const res = await fetch(`${base}/api/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ proposalId: id, finalText }),
      });
      if (!res.ok) {
        alert(await errorMessage(res, "approve failed"));
        return;
      }
      delete edits[id];
      await invalidateAll();
    } finally {
      pending[id] = false;
    }
  }

  function severityBadge(severity: string | undefined): string {
    if (!severity) return "";
    const s = severity.toLowerCase();
    if (s === "critical" || s === "high") return "badge badge-dead";
    if (s === "medium")  return "badge badge-amber";
    if (s === "low")     return "badge badge-neutral";
    return "badge badge-blue";
  }

  function kindBadge(kind: string): string {
    const k = kind.toLowerCase();
    if (k === "social_post") return "badge badge-blue";
    if (k === "coordinator_error") return "badge badge-dead";
    return "badge badge-neutral";
  }
</script>

<div class="page">
  <div class="page-header">
    <h1>Approval queue</h1>
    <div class="page-actions">
      <a href={data.all ? `${base}/queue` : `${base}/queue?all=1`} class="btn btn-ghost btn-sm">
        {data.all ? "Show open only" : "Show all"}
      </a>
    </div>
  </div>

  {#if data.open.length === 0}
    <div class="empty-state">Queue is empty.</div>
  {:else}
    {#each data.open as p (p.proposal_id)}
      <article class="card">
        <div class="card-header">
          <div class="card-title">{p.title}</div>
          <div class="card-meta">
            <span class={kindBadge(p.kind)}>{p.kind}</span>
            {#if p.severity}<span class={severityBadge(p.severity)}>{p.severity}</span>{/if}
            <span class="badge badge-neutral">{p.app}</span>
            {#if p.channel}<span class="badge badge-neutral">{p.channel}</span>{/if}
          </div>
        </div>

        <div class="card-body">{p.body}</div>

        {#if p.status === "open"}
          {#if p.kind === "social_post"}
            <textarea
              class="field-textarea"
              bind:value={edits[p.proposal_id]}
              placeholder="Edit final text before approving (optional)"
              rows={3}
            ></textarea>
          {/if}
          <div class="card-footer">
            <button
              class="btn btn-success btn-sm"
              onclick={() => approve(p.proposal_id)}
              disabled={pending[p.proposal_id]}
            >
              {pending[p.proposal_id] ? "Approving…" : "Approve"}
            </button>
          </div>
        {:else}
          <div class="card-footer">
            <span class="badge badge-neutral">{p.status}</span>
          </div>
        {/if}
      </article>
    {/each}
  {/if}
</div>
