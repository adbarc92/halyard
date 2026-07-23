<script lang="ts">
  import type { PageData } from "./$types";
  import { base } from "$app/paths";
  let { data }: { data: PageData } = $props();
</script>

<div class="page">
  <div class="page-header">
    <h1>Launches</h1>
  </div>

  {#if data.launches.length === 0}
    <div class="empty-state">No launches yet.</div>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Title</th>
          <th>App</th>
          <th>Tier</th>
          <th>Announce</th>
          <th>Flag</th>
        </tr>
      </thead>
      <tbody>
        {#each data.launches as l}
          <tr>
            <td class="td-id">
              <a href={`${base}/launches/${l.launch_id}`}>{l.title}</a>
            </td>
            <td class="td-dim">{l.app}</td>
            <td class="td-mute">{l.tier}</td>
            <td class="td-dim">{l.announce_policy}</td>
            <td class="td-mute mono">{l.flag ?? "—"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
