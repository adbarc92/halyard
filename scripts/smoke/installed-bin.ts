/**
 * Installed-bin smoke (GAP-S12). The CLI tests call `dispatch` in-process, so they never evaluate
 * the entrypoint guard. This packs the package, installs it into a scratch global prefix (a real
 * copy, as a registry install makes), runs the installed `halyard` bin, then runs it again through
 * a linked directory (the `npm link` shape). Each run must print JSON on stdout: exit 0 with no
 * output is exactly the failure this guards.
 *
 *   npm run smoke:bin
 *
 * Needs network (or a warm npm cache) for the package's dependencies. Leaves nothing behind.
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WIN = process.platform === "win32";

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  // npm and the installed .cmd shim are batch files on Windows and need a shell to spawn.
  const shell = WIN && !cmd.endsWith(".exe") && cmd !== process.execPath;
  const quoted = shell ? args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)) : args;
  const res = spawnSync(shell ? `"${cmd}"` : cmd, quoted, { encoding: "utf8", shell, ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}\n${res.stderr ?? ""}`);
  }
  return String(res.stdout ?? "");
}

function assertJsonOutput(label: string, stdout: string): void {
  if (stdout.trim() === "") throw new Error(`${label}: exit 0 with no output (GAP-S12)`);
  try {
    JSON.parse(stdout);
  } catch {
    throw new Error(`${label}: output is not JSON:\n${stdout}`);
  }
  console.log(`ok  ${label}`);
}

function main(): number {
  const tmp = mkdtempSync(join(tmpdir(), "halyard-bin-"));
  try {
    const npm = WIN ? "npm.cmd" : "npm";
    const packed = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", tmp])) as { filename: string }[];
    const tgz = join(tmp, packed[0]!.filename);

    const prefix = join(tmp, "prefix");
    run(npm, ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tgz], { stdio: ["ignore", "pipe", "pipe"] });

    const stateDir = join(tmp, "state");
    const bin = WIN ? join(prefix, "halyard.cmd") : join(prefix, "bin", "halyard");
    assertJsonOutput("installed bin", run(bin, ["status", "--state-dir", stateDir]));

    const pkgDir = WIN ? join(prefix, "node_modules", "halyard") : join(prefix, "lib", "node_modules", "halyard");
    const linked = join(tmp, "linked");
    symlinkSync(pkgDir, linked, "junction");
    assertJsonOutput(
      "installed package through a link",
      run(process.execPath, [join(linked, "dist", "cli.js"), "status", "--state-dir", stateDir]),
    );
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exit(main());
