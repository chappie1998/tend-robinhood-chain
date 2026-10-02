import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptUrl = new URL("../scripts/keeper-local.sh", import.meta.url);

test("local keeper uses an inherited kernel advisory lock", async () => {
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /fcntl\.flock\(lock_file\.fileno\(\), fcntl\.LOCK_EX \| fcntl\.LOCK_NB\)/);
  assert.match(source, /os\.set_inheritable\(lock_file\.fileno\(\), True\)/);
  assert.match(source, /os\.execve\(script/);
  assert.doesNotMatch(source, /rm -rf "\$LOCK_DIR"/);
});

test("simultaneous contenders cannot both enter the locked keeper", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "tend-keeper-lock-"));
  const run = () => spawn("bash", [new URL(scriptUrl).pathname], {
    env: { ...process.env, HOME: home, TEND_KEEPER_LOCK_TEST_HOLD_SECONDS: "1" },
    stdio: "ignore",
  });
  const exited = (child) => new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    const first = run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = run();
    assert.deepEqual(await exited(second), { code: 0, signal: null });
    assert.deepEqual(await exited(first), { code: 0, signal: null });

    const log = await readFile(path.join(home, "Library/Logs/tend-keeper/keeper.log"), "utf8");
    assert.match(log, /keeper already running; skipping overlap/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a surviving child keeps the advisory lock after the wrapper exits", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "tend-keeper-child-lock-"));
  const run = () => spawn("bash", [new URL(scriptUrl).pathname], {
    env: { ...process.env, HOME: home, TEND_KEEPER_LOCK_TEST_HOLD_SECONDS: "2" },
    stdio: "ignore",
  });
  const exited = (child) => new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    const first = run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    first.kill("SIGTERM");
    await exited(first);

    const contender = run();
    assert.deepEqual(await exited(contender), { code: 0, signal: null });
    const log = await readFile(path.join(home, "Library/Logs/tend-keeper/keeper.log"), "utf8");
    assert.match(log, /keeper already running; skipping overlap/);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const afterChild = spawn("bash", [new URL(scriptUrl).pathname], {
      env: { ...process.env, HOME: home, TEND_KEEPER_LOCK_TEST_HOLD_SECONDS: "0.01" },
      stdio: "ignore",
    });
    assert.deepEqual(await exited(afterChild), { code: 0, signal: null });
    const finalLog = await readFile(path.join(home, "Library/Logs/tend-keeper/keeper.log"), "utf8");
    assert.equal(finalLog.match(/keeper test lock acquired/g)?.length, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
