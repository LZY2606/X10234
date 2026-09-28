import { spawnSync } from "node:child_process";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("npx", ["vitest", "run"]);
run("npx", ["playwright", "test", "--config=playwright.config.mjs"]);
