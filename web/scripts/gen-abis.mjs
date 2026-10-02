#!/usr/bin/env node
// Vendors ABIs from the Hardhat compile artifacts (../artifacts) into typed
// TS modules under web/src/abis/. Run `npx hardhat compile` at the worktree
// root first. Never hand-edit the generated files — re-run this script
// after any contract change instead.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..");
const ABIS_OUT_DIR = path.join(WEB_ROOT, "src", "abis");

// name: [artifact relative path, exported const name]
const TARGETS = [
  {
    artifact: "artifacts/contracts/TendSeriesFactory.sol/TendSeriesFactory.json",
    exportName: "tendSeriesFactoryAbi",
    fileName: "TendSeriesFactory.ts",
  },
  {
    artifact: "artifacts/contracts/TendPoolVault.sol/TendPoolVault.json",
    exportName: "tendPoolVaultAbi",
    fileName: "TendPoolVault.ts",
  },
  {
    artifact: "artifacts/contracts/test/MockERC20.sol/MockERC20.json",
    exportName: "mockErc20Abi",
    fileName: "MockERC20.ts",
  },
];

async function main() {
  for (const target of TARGETS) {
    const artifactPath = path.join(REPO_ROOT, target.artifact);
    const raw = await readFile(artifactPath, "utf8");
    const artifact = JSON.parse(raw);
    if (!Array.isArray(artifact.abi)) {
      throw new Error(`No "abi" array found in ${artifactPath}`);
    }

    const banner =
      `// GENERATED FILE — do not hand-edit.\n` +
      `// Source: ${target.artifact} (Hardhat compile artifact).\n` +
      `// Regenerate with \`node web/scripts/gen-abis.mjs\` after \`npx hardhat compile\`.\n\n`;
    const body = `export const ${target.exportName} = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`;

    const outPath = path.join(ABIS_OUT_DIR, target.fileName);
    await writeFile(outPath, banner + body);
    console.log(`Wrote ${path.relative(REPO_ROOT, outPath)} (${artifact.abi.length} ABI entries)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
