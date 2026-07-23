import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("start command binds loopback", () => {
  it("root web:start sets HOST=127.0.0.1", () => {
    const pkg = JSON.parse(readFileSync(resolve(HERE, "..", "..", "package.json"), "utf8"));
    expect(pkg.scripts["web:start"]).toContain("HOST=127.0.0.1");
  });
});
