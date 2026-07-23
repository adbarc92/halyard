import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { DeployProvider } from "./provider.js";
import type { BuildResult, DeployResult, ReleaseContext } from "../types.js";

/**
 * `aws` (web) — `terraform apply -auto-approve` in a configured TF dir. Terraform reads
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from the environment automatically (injected by
 * the workflow from secrets); credentials are NEVER written to config, read, or logged.
 * All args go through `runner.runArgv` (NO shell) — the terraform dir is a runtime path and
 * must not be interpretable as shell metacharacters (invariant: runtime values use runArgv).
 */
export const awsProvider: DeployProvider = {
  target: "aws",
  surfaces: ["web"],
  configSchema: z
    .object({
      target: z.literal("aws"),
      terraform_dir: z.string().min(1),
      output_url_var: z.string().min(1).optional(),
    })
    .strict(),

  async deploy(ctx: ReleaseContext, _build: BuildResult, cfg: unknown): Promise<DeployResult> {
    const { terraform_dir, output_url_var } = cfg as {
      terraform_dir: string;
      output_url_var?: string;
    };
    const dir = isAbsolute(terraform_dir) ? terraform_dir : resolve(ctx.workdir, terraform_dir);

    ctx.log(`[${ctx.surface}] deploy: terraform -chdir ${dir} apply -auto-approve -input=false`);
    const apply = await ctx.runner.runArgv(
      "terraform",
      ["-chdir", dir, "apply", "-auto-approve", "-input=false"],
      { cwd: ctx.workdir },
    );
    const applyExit = apply.exitCode;

    let previewUrl = "";
    if (output_url_var && applyExit === 0) {
      ctx.log(`[${ctx.surface}] deploy: terraform -chdir ${dir} output -raw ${output_url_var}`);
      const output = await ctx.runner.runArgv(
        "terraform",
        ["-chdir", dir, "output", "-raw", output_url_var],
        { cwd: ctx.workdir },
      );
      previewUrl = output.stdout.trim();
    }

    return {
      ok: applyExit === 0,
      previewUrl,
      details: { target: "aws", exitCode: applyExit },
      externalRefs: applyExit === 0 ? { terraform_dir } : {},
    };
  },
};
