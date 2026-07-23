<script lang="ts">
  import "../app.css";
  import type { LayoutData } from "./$types";
  import type { Snippet } from "svelte";
  import { page } from "$app/stores";
  import { base } from "$app/paths";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  // hrefs are app-relative ("/queue"); `base` ("" by default, or e.g. "/halyard" when the
  // console is built for sub-path embedding) makes them survive a sub-path mount.
  const navLinks = [
    { href: "/",         label: "Board"    },
    { href: "/queue",    label: "Queue"    },
    { href: "/flags",    label: "Flags"    },
    { href: "/releases", label: "Releases" },
    { href: "/launches", label: "Launches" },
  ];

  // `page.url.pathname` already includes `base`, so compare against the base-prefixed href.
  function isCurrent(href: string, pathname: string): boolean {
    const full = base + href;
    if (href === "/") return pathname === base + "/" || pathname === base || pathname === "/";
    return pathname.startsWith(full);
  }

  const showChrome = $derived($page.route.id !== "/login" && $page.route.id !== "/logout");
</script>

{#if showChrome}
<nav class="site-nav">
  <a href="{base}/" class="nav-brand">Halyard</a>
  <div class="nav-links">
    {#each navLinks as link}
      <a
        href="{base}{link.href}"
        aria-current={isCurrent(link.href, $page.url.pathname) ? "page" : undefined}
      >{link.label}</a>
    {/each}
  </div>
  <div class="nav-health {data.health.status === 'ok' ? 'ok' : ''}">
    <span class="health-dot" aria-hidden="true"></span>
    <span class="health-root">
      {data.health.status === "ok" ? data.health.root : "no project"}
    </span>
    {#if data.authEnabled}
      <form method="POST" action="{base}/logout" class="nav-logout">
        <button type="submit" class="btn btn-secondary btn-sm">Sign out</button>
      </form>
    {/if}
  </div>
</nav>

{#if data.health.status !== "ok"}
  <div class="page">
    <div class="degraded-banner" role="alert">
      No Halyard project at <code>{data.health.root || "unknown"}</code>: {data.health.error}
    </div>
  </div>
{/if}
{/if}

{@render children()}
