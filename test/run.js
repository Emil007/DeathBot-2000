#!/usr/bin/env node
/**
 * Minimal test runner.
 *
 * Runs each test/*.test.js in its own child process (sequentially).
 * `node --test` is NOT used: its worker/child teardown crashes better-sqlite3's
 * native addon on some Node versions (RemoveEnvironmentCleanupHook assertion in
 * Node 24). Each file in its own process is the same isolation without the
 * teardown hazard, and works on Node 20 (CI) and Node 22/24 (dev) alike.
 *
 * Exit code: 0 = all pass, 1 = any failure.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join(dir, f))
  .sort();

if (!files.length) {
  console.error("No test/*.test.js files found.");
  process.exit(1);
}

let ok = true;
for (const f of files) {
  console.log(`\n== ${path.relative(dir, f)} ==`);
  const r = spawnSync(process.execPath, [f], { stdio: "inherit" });
  if (r.status !== 0) {
    ok = false;
    console.error(`FAILED: ${f} (exit ${r.status})`);
  }
}

console.log(ok ? "\nAll tests passed." : "\nSome tests FAILED.");
process.exit(ok ? 0 : 1);
