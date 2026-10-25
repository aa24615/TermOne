import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function isVersionedBuild(args) {
  return args[0] === "build" && !args.some((a) => ["--help", "-h", "--version", "-V"].includes(a));
}

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function nextBuildVersion(current, requested) {
  const before = semver.exec(current);
  if (!before) throw new Error(`当前版本号无效：${current}`);
  if (!requested) return `${before[1]}.${before[2]}.${Number(before[3]) + 1}`;
  const version = requested.replace(/^v/, "");
  const after = semver.exec(version);
  if (!after) throw new Error(`发布版本号无效：${requested}`);
  for (let i = 1; i <= 3; i++) {
    if (Number(after[i]) > Number(before[i])) break;
    if (Number(after[i]) < Number(before[i])) throw new Error("发布版本不能低于当前版本");
  }
  return version;
}

// Run before the Tauri CLI reads configuration, so the binary and bundle use the same version.
export function prepareBuildVersion(root, requested) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const json = (path) => JSON.parse(read(path));
  const configPath = "apps/desktop/src-tauri/tauri.conf.json";
  const config = json(configPath);
  const current = config.version;
  const version = nextBuildVersion(current, requested);
  const rootPackage = json("package.json");
  const desktopPackage = json("apps/desktop/package.json");
  const npmLock = json("package-lock.json");
  const cargo = read("Cargo.toml");
  const cargoVersion = /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*")([^"]+)(")/;
  if ([rootPackage.version, desktopPackage.version, npmLock.version,
    npmLock.packages[""].version, npmLock.packages["apps/desktop"].version,
    cargo.match(cargoVersion)?.[2]].some((v) => v !== current)) {
    throw new Error("桌面版本配置不一致，请先统一 package、Tauri、Cargo 及锁文件版本");
  }
  const cargoLock = read("Cargo.lock");
  const localCrates = /(\[\[package\]\]\r?\nname = "(?:term-core|termone)"\r?\nversion = ")([^"]+)(")/g;
  const entries = [...cargoLock.matchAll(localCrates)];
  if (entries.length !== 2 || entries.some((entry) => entry[2] !== current)) {
    throw new Error("Cargo.lock 本地包版本不一致");
  }
  config.version = rootPackage.version = desktopPackage.version = version;
  npmLock.version = npmLock.packages[""].version = npmLock.packages["apps/desktop"].version = version;
  const updates = new Map([
    [configPath, JSON.stringify(config, null, 2) + "\n"],
    ["package.json", JSON.stringify(rootPackage, null, 2) + "\n"],
    ["apps/desktop/package.json", JSON.stringify(desktopPackage, null, 2) + "\n"],
    ["package-lock.json", JSON.stringify(npmLock, null, 2) + "\n"],
    ["Cargo.toml", cargo.replace(cargoVersion, (_, prefix, old, suffix) => prefix + version + suffix)],
    ["Cargo.lock", cargoLock.replace(localCrates, (_, prefix, old, suffix) => prefix + version + suffix)],
  ]);
  for (const [path, value] of updates) writeFileSync(join(root, path), value);
  return { previous: current, version };
}
