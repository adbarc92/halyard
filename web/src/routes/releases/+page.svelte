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
    <h1>Releases</h1>
  </div>

  {#if data.releases.length === 0}
    <div class="empty-state">No releases yet.</div>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Release ID</th>
          <th>App</th>
          <th>Surface</th>
          <th>Ver</th>
          <th>State</th>
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
            <td><span class={stateBadge(r.state)}>{r.state}</span></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
