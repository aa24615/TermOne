import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isVersionedBuild, prepareBuildVersion } from "./build-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
try {
  const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js");
  if (args[0] === "bundle") throw new Error("请使用 tauri build 打包，以便递增版本并重新编译应用");
  if (isVersionedBuild(args)) {
    const { previous, version } = prepareBuildVersion(root, process.env.TERMONE_RELEASE_VERSION);
    console.log(`TermOne 打包版本：${previous} → ${version}`);
  }
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: resolve(root, "apps/desktop"),
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
