<script lang="ts">
  import type { PageData } from "./$types";
  import { base } from "$app/paths";
  let { data }: { data: PageData } = $props();

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
    <h1>{data.release.release_id}</h1>
    <div class="page-actions">
      <a href="{base}/releases" class="btn btn-ghost btn-sm">← Releases</a>
    </div>
  </div>

  <div class="detail-meta">
    <span class="detail-meta-item"><strong>{data.release.app}</strong></span>
    <span class="text-mute">·</span>
    <span class="detail-meta-item">{data.release.surface}</span>
    <span class="text-mute">·</span>
    <span class="detail-meta-item">v{data.release.version}</span>
    <span class="text-mute">·</span>
    <span class={stateBadge(data.release.state)}>{data.release.state}</span>
    {#if data.release.flag}
      <span class="text-mute">·</span>
      <span class="detail-meta-item">flag: <code>{data.release.flag}</code></span>
    {/if}
  </div>

  <div class="section-label">Transition history</div>
  {#if data.release.transitions.length === 0}
    <p class="text-dim" style="font-size:0.8rem;">No transitions recorded.</p>
  {:else}
    <ol class="timeline">
      {#each data.release.transitions as t}
        <li>
          <span class="tl-state">{t.to}</span>
          <span class="text-mute">by</span>
          <span class="tl-by">{t.by}</span>
          <span class="tl-at">@ {t.at}</span>
        </li>
      {/each}
    </ol>
  {/if}
</div>
