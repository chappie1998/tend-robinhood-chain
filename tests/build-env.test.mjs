import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBuildChain } from "../web/scripts/build-env.mjs";

test("build selection validates mode-specific files and shell overrides", async () => {
  const original = { TEND_CHAIN: process.env.TEND_CHAIN, VITE_CHAIN: process.env.VITE_CHAIN };
  delete process.env.TEND_CHAIN;
  delete process.env.VITE_CHAIN;
  const root = await mkdtemp(join(tmpdir(), "tend-build-env-"));
  const web = join(root, "web");
  await mkdir(web);
  try {
    await writeFile(join(web, ".env.production"), "VITE_CHAIN=robinhood\n");
    assert.throws(() => resolveBuildChain("production", root, web, {}), /same chain/);
    await writeFile(join(root, ".env"), "TEND_CHAIN=robinhood\n");
    assert.equal(resolveBuildChain("production", root, web, {}), "robinhood");
    assert.throws(() => resolveBuildChain("development", root, web, {}), /same chain/);
    assert.equal(resolveBuildChain("production", root, web, { TEND_CHAIN: "monad", VITE_CHAIN: "monad" }), "monad");
    await writeFile(join(web, ".env.staging"), "TEND_CHAIN=monad\nVITE_CHAIN=monad\n");
    assert.equal(resolveBuildChain("staging", root, web, {}), "monad");
    process.env.TEND_CHAIN = "robinhood";
    process.env.VITE_CHAIN = "robinhood";
    assert.equal(resolveBuildChain("staging", root, web), "robinhood");
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
