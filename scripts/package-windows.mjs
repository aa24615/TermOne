import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function verifyWindowsExecutable(bytes, machine = 0x8664) {
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Windows EXE 头无效");
  const offset = bytes.readUInt32LE(0x3c);
  if (offset < 64 || offset + 6 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550) throw new Error("Windows PE 头无效");
  if (machine !== null && bytes.readUInt16LE(offset + 4) !== machine) throw new Error("Windows 应用不是 x64 架构");
}

export function findWindowsInstaller(names, version, kind) {
  const suffix = kind === "nsis" ? "-setup.exe" : ".msi";
  const prefix = `TermOne_${version}_x64`;
  const matches = names.filter(name => name.startsWith(prefix) && name.endsWith(suffix) &&
    (name.slice(prefix.length, -suffix.length) === "" || /^_[A-Za-z-]+$/.test(name.slice(prefix.length, -suffix.length))));
  if (matches.length !== 1) throw new Error(`须有且仅有一个 ${version} x64 ${kind} 安装包，实际 ${matches.length} 个`);
  return matches[0];
}

function main() {
  if (process.platform !== "win32") throw new Error("Windows 安装包必须在 Windows 校验");
  const version = JSON.parse(readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8")).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("打包版本号无效");
  const target = process.env.RUST_TARGET || "x86_64-pc-windows-msvc";
  if (target !== "x86_64-pc-windows-msvc") throw new Error("Windows target 无效");
  const release = resolve("target", target, "release");
  const executable = join(release, "termone.exe");
  verifyWindowsExecutable(readFileSync(executable));
  const versions = JSON.parse(execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
    '$ErrorActionPreference = "Stop"; $v = (Get-Item -LiteralPath $env:TERMONE_WINDOWS_EXE).VersionInfo; @($v.FileVersion, $v.ProductVersion) | ConvertTo-Json -Compress'],
  { encoding: "utf8", env: { ...process.env, TERMONE_WINDOWS_EXE: executable } }));
  if (!versions.every(value => value === version || value === `${version}.0`)) throw new Error(`EXE 版本与源码不一致：${versions}`);
  const output = resolve(process.env.RELEASE_ASSETS_DIR || "release-assets");
  const stem = `TermOne_${version}_windows_x64`;
  const assets = [
    ["nsis", `${stem}-setup.exe`],
    ["msi", `${stem}.msi`],
  ].map(([kind, name]) => {
    const directory = join(release, "bundle", kind);
    return { source: join(directory, findWindowsInstaller(readdirSync(directory), version, kind)), destination: join(output, name), kind };
  });
  for (const asset of assets) {
    if (existsSync(asset.destination)) throw new Error("安装包已存在，请使用新的输出目录或版本");
    const bytes = readFileSync(asset.source);
    if (asset.kind === "nsis") verifyWindowsExecutable(bytes, null); // NSIS bootstrapper can be x86 for an x64 payload.
    else if (bytes.subarray(0, 8).toString("hex") !== "d0cf11e0a1b11ae1") throw new Error("MSI 文件头无效");
  }
  mkdirSync(output, { recursive: true });
  for (const asset of assets) copyFileSync(asset.source, asset.destination);
  writeFileSync(join(output, `${stem}.sha256`), assets.map(({ destination }) =>
    `${createHash("sha256").update(readFileSync(destination)).digest("hex")}  ${basename(destination)}`).join("\n") + "\n");
  console.log(`Verified Windows x64 assets in ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
