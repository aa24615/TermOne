import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBuildVersion } from "./build-version.mjs";

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function parts(version) {
  if (!stable.test(version)) throw new Error("版本号须为 X.Y.Z，不含前导零或预发布后缀");
  const numbers = version.split(".").map(Number);
  if (!numbers.every(Number.isSafeInteger)) throw new Error("版本号超出范围");
  return numbers;
}
function compare(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
export function chooseReleaseVersion(current, tags, requested = "") {
  parts(current);
  let highest = current;
  for (const tag of tags) {
    const version = tag.startsWith("v") ? tag.slice(1) : "";
    if (stable.test(version) && compare(version, highest) > 0) highest = version;
  }
  const version = requested.trim().replace(/^v/, "") || (() => {
    const next = parts(highest); next[2]++;
    return next.join(".");
  })();
  parts(version);
  if (compare(version, highest) <= 0) throw new Error(`新版本必须高于源码及所有已预留版本（${highest}）`);
  return version;
}

function main() {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  if (git("status", "--porcelain")) throw new Error("预留版本前工作区必须干净");
  if (git("branch", "--show-current") !== "main") throw new Error("只允许从 main 发版");
  const current = JSON.parse(readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8")).version;
  const version = chooseReleaseVersion(current, git("tag", "--list", "v*").split("\n"), process.env.REQUESTED_VERSION);
  prepareBuildVersion(process.cwd(), version);
  const tag = `v${version}`;
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  git("add", "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json");
  git("commit", "-m", `build: 预留 GitHub Release ${tag}`);
  const sha = git("rev-parse", "HEAD");
  git("tag", "-a", tag, "-m", `TermOne ${tag}`);
  // One atomic push reserves both the source version and tag; never overwrite a reservation.
  git("push", "--atomic", "origin", "HEAD:refs/heads/main", `refs/tags/${tag}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\nsha=${sha}\n`);
  console.log(`Reserved ${tag} at ${sha}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
