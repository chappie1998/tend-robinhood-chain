#!/usr/bin/env node
// Copies ../deployments/<chain>-testnet.json (written by the deploy script at
// the worktree root) into web/public/deployments/ so the running SPA can
// fetch it at runtime. VITE_CHAIN picks which chain's manifest is copied.
//
// The source manifest does not exist until a real deploy has been run. When
// it's absent, this script removes any stale copy under public/ so the app
// reliably observes a 404 and renders the "contracts not deployed" state
// instead of serving out-of-date addresses. Vite config invokes this with the
// resolved mode-specific chain during both dev and build.
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildChain } from "./build-env.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WEB_ROOT, "..");

// Which chain this build is for. Matches VITE_CHAIN in web/src/chain.ts —
// the SPA fetches /deployments/<file> at runtime, so the copied file and the
// chain the app talks to must be chosen by the same variable.

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function syncDeployment(chain) {
  const manifest = `${chain}-testnet.json`;
  const SOURCE = path.join(REPO_ROOT, "deployments", manifest);
  const DEST_DIR = path.join(WEB_ROOT, "public", "deployments");
  const DEST = path.join(DEST_DIR, manifest);
  if (await exists(SOURCE)) {
    await mkdir(DEST_DIR, { recursive: true });
    await copyFile(SOURCE, DEST);
    console.log(`Synced deployment manifest: ${path.relative(REPO_ROOT, SOURCE)} -> ${path.relative(REPO_ROOT, DEST)}`);
  } else if (await exists(DEST)) {
    await rm(DEST);
    console.log(`No deployment manifest at ${path.relative(REPO_ROOT, SOURCE)}; removed stale copy at ${path.relative(REPO_ROOT, DEST)}.`);
  } else {
    console.log(`No deployment manifest at ${path.relative(REPO_ROOT, SOURCE)} yet. App will render the "not deployed" state.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "production";
  syncDeployment(resolveBuildChain(mode, REPO_ROOT, WEB_ROOT)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
}
