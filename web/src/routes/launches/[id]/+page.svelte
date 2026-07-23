<script lang="ts">
  import type { PageData } from "./$types";
  import { base } from "$app/paths";
  let { data }: { data: PageData } = $props();
</script>

<div class="page">
  <div class="page-header">
    <h1>{data.launch.title}</h1>
    <div class="page-actions">
      <a href="{base}/launches" class="btn btn-ghost btn-sm">← Launches</a>
    </div>
  </div>

  <div class="detail-meta">
    <span class="detail-meta-item"><strong>{data.launch.app}</strong></span>
    <span class="text-mute">·</span>
    <span class="detail-meta-item">tier {data.launch.tier}</span>
    <span class="text-mute">·</span>
    <span class="detail-meta-item">{data.launch.announce_policy}</span>
    {#if data.launch.flag}
      <span class="text-mute">·</span>
      <span class="detail-meta-item">flag: <code>{data.launch.flag}</code></span>
    {/if}
  </div>

  {#if data.launch.narrative_seed}
    <p style="font-size:0.82rem; font-style:italic; margin-bottom:1.25rem;">{data.launch.narrative_seed}</p>
  {/if}

  <div class="section-label">Releases in this launch</div>
  {#if data.launch.releases.length === 0}
    <p class="text-dim" style="font-size:0.8rem;">No releases linked.</p>
  {:else}
    <ul style="list-style:none; padding:0;">
      {#each data.launch.releases as id}
        <li style="padding:0.35rem 0; border-bottom:1px solid var(--border-dim);">
          <a href={`${base}/releases/${id}`} class="mono" style="font-size:0.82rem;">{id}</a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
