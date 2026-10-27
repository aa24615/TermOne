import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform !== "darwin") throw new Error("macOS 安装包必须在 macOS 生成");
const version = JSON.parse(readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("打包版本号无效");
const target = process.env.RUST_TARGET || "";
if (target && !["aarch64-apple-darwin", "x86_64-apple-darwin"].includes(target)) throw new Error("macOS target 无效");
const arch = target ? target.startsWith("aarch64") ? "aarch64" : "x64" : process.arch === "arm64" ? "aarch64" : "x64";
const app = resolve("target", ...(target ? [target] : []), "release/bundle/macos/TermOne.app");
const output = resolve(process.env.RELEASE_ASSETS_DIR || "release-assets");
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });
const info = join(app, "Contents/Info.plist");
for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
  const value = execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, info], { encoding: "utf8" }).trim();
  if (value !== version) throw new Error(`应用 ${key} 与源码版本不一致`);
}
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
const executable = join(app, "Contents/MacOS/termone");
const nativeArch = arch === "aarch64" ? "arm64" : "x86_64";
run("lipo", [executable, "-verify_arch", nativeArch]);
mkdirSync(output, { recursive: true });
const stem = `TermOne_${version}_${arch}`;
const dmg = join(output, `${stem}.dmg`), zip = join(output, `${stem}.app.zip`);
if (existsSync(dmg) || existsSync(zip)) throw new Error("安装包已存在，请使用新的输出目录或版本");
const stage = mkdtempSync(join(tmpdir(), "termone-release-dmg-"));
try {
  run("ditto", [app, join(stage, "TermOne.app")]);
  symlinkSync("/Applications", join(stage, "Applications"));
  // Direct DMG creation avoids Finder/AppleScript dependencies and busy cosmetic mounts.
  run("hdiutil", ["create", "-volname", `TermOne ${version}`, "-srcfolder", stage, "-format", "UDZO", "-o", dmg]);
  run("hdiutil", ["verify", dmg]);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  const sums = [dmg, zip].map(path => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${path.split("/").pop()}`).join("\n") + "\n";
  writeFileSync(join(output, `${stem}.sha256`), sums);
  console.log(`Verified macOS ${arch} assets in ${output}`);
} finally { rmSync(stage, { recursive: true, force: true }); }
