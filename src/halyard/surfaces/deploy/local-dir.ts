import { cpSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { DeployProvider } from "./provider.js";
import type { BuildResult, DeployResult, ReleaseContext } from "../types.js";

/**
 * `local_dir` — copies the build output to an inspectable preview directory. The
 * surface-agnostic target used for local end-to-end verification (no external service,
 * no credentials). Shared by both web and desktop.
 *
 * The preview URL differs by surface to preserve the pre-registry behavior exactly: web
 * points at the entry `index.html` (a servable page); every other surface points at the
 * copied directory (a bundle to inspect).
 */
export const localDirProvider: DeployProvider = {
  target: "local_dir",
  configSchema: z
    .object({
      target: z.literal("local_dir"),
      dir: z.string().min(1),
    })
    .strict(),

  async deploy(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<DeployResult> {
    const { dir } = cfg as { dir: string };
    const base = isAbsolute(dir) ? dir : resolve(ctx.workdir, dir);
    const dest = join(base, ctx.releaseId);
    mkdirSync(dest, { recursive: true });
    cpSync(build.outputDir, dest, { recursive: true });
    const previewUrl =
      ctx.surface === "web"
        ? pathToFileURL(join(dest, "index.html")).href
        : pathToFileURL(dest).href;
    ctx.log(`[${ctx.surface}] deployed preview → ${previewUrl}`);
    return { ok: true, previewUrl, details: { target: "local_dir", dir: dest } };
  },
};
