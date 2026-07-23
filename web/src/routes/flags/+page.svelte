<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { base } from "$app/paths";
  import type { PageData } from "./$types";
  import { errorMessage } from "$lib/errors.js";

  let { data }: { data: PageData } = $props();
  let pending = $state<Record<string, boolean>>({});

  async function flip(flagKey: string, on: boolean) {
    if (pending[flagKey]) return;
    if (!confirm(`Flip ${flagKey} ${on ? "ON" : "OFF"}? This is the launch/rollback gate.`)) return;
    pending[flagKey] = true;
    try {
      const res = await fetch(`${base}/api/flip`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flagKey, on }),
      });
      if (!res.ok) {
        alert(await errorMessage(res, "flip failed"));
        return;
      }
      await invalidateAll();
    } finally {
      pending[flagKey] = false;
    }
  }
</script>

<div class="page">
  <div class="page-header">
    <h1>Flags</h1>
  </div>

  <p class="text-dim" style="margin-bottom:1rem; font-size:0.8rem;">
    Local git-backed flags. After a flip, run <strong>Reconcile now</strong> on the board to project the change.
  </p>

  {#if data.flags.length === 0}
    <div class="empty-state">No launch flags found on any release.</div>
  {:else}
    {#each data.flags as f (f.key)}
      <div class="flag-row">
        <span class="flag-key">{f.key}</span>
        <span class="flag-state">
          <span class="badge {f.state === 'on' ? 'badge-live' : 'badge-dead'}">{f.state}</span>
        </span>
        <div class="flag-actions">
          <button
            class="btn btn-success btn-sm"
            onclick={() => flip(f.key, true)}
            disabled={f.state === "on" || pending[f.key]}
          >On</button>
          <button
            class="btn btn-danger btn-sm"
            onclick={() => flip(f.key, false)}
            disabled={f.state === "off" || pending[f.key]}
          >Off</button>
        </div>
      </div>
    {/each}
  {/if}
</div>
