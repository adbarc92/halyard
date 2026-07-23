<!-- web/src/routes/login/+page.svelte -->
<script lang="ts">
  import { page } from "$app/stores";
  import { base } from "$app/paths";
  let { form } = $props();
  const next = $derived($page.url.searchParams.get("next") ?? "/");
</script>

<main class="login">
  <h1>Halyard console</h1>
  <form method="POST" action="{base}/login">
    <input type="hidden" name="next" value={next} />
    <label>Access token
      <!-- svelte-ignore a11y_autofocus -->
      <input name="token" type="password" autocomplete="current-password" autofocus />
    </label>
    {#if form?.error}<p class="login-error" role="alert">{form.error}</p>{/if}
    <button type="submit">Sign in</button>
  </form>
</main>

<style>
  .login { max-width: 22rem; margin: 6rem auto; display: grid; gap: 1rem; font-family: system-ui, sans-serif; }
  .login form { display: grid; gap: 0.75rem; }
  .login input[type="password"] { width: 100%; padding: 0.5rem; }
  .login-error { color: #c0392b; margin: 0; }
</style>
