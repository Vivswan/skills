// reaches: package.json
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../scripts/lib.mts";

// npm's git fetcher (pacote) runs a full devDependency install inside its clone, then the script itself, whenever
// package.json carries any of these six names, so `npx -y github:Vivswan/skills` would fetch biome and typescript
// and need bun before bin/install.mjs prints a line. Nothing else enforces their absence; the hook wiring is the
// plain `hooks` script instead.

const LIFECYCLE_NAMES = ["preinstall", "install", "postinstall", "prepare", "prepack", "build"];

test("package.json carries none of the six script names that make npm's git fetcher install devDependencies for npx github:", () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  expect(Object.keys(scripts).filter((name) => LIFECYCLE_NAMES.includes(name))).toEqual([]);
});
