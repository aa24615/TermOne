import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isVersionedBuild, nextBuildVersion, prepareBuildVersion } from "../scripts/build-version.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "termone-build-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  write("package.json", { name: "termone", version: "0.1.0" });
  write("apps/desktop/package.json", { name: "@termone/desktop", version: "0.1.0" });
  write("apps/desktop/src-tauri/tauri.conf.json", { version: "0.1.0" });
  write("package-lock.json", { version: "0.1.0", packages: {
    "": { version: "0.1.0" }, "apps/desktop": { version: "0.1.0" },
    "apps/server": { version: "0.1.0" }, "node_modules/example": { version: "2.3.4" },
  } });
  write("Cargo.toml", '[workspace.package]\nversion = "0.1.0"\n');
  write("Cargo.lock", ['term-core', 'termone', 'example'].map((name) =>
    `[[package]]\nname = "${name}"\nversion = "0.1.0"\n`).join("\n"));
  const read = (path) => readFileSync(join(root, path), "utf8");
  const json = (path) => JSON.parse(read(path));
  return { root, read, json, write };
}

test("only actual Tauri builds reserve a new version", () => {
  for (const args of [["dev"], ["info"], ["--version"], ["build", "--help"], ["build", "-h"]])
    assert.equal(isVersionedBuild(args), false);
  assert.equal(isVersionedBuild(["build", "--bundles", "app,dmg"]), true);
});

test("consecutive packages get distinct versions and synchronized metadata", (t) => {
  const f = fixture(t);
  assert.equal(prepareBuildVersion(f.root).version, "0.1.1");
  assert.equal(prepareBuildVersion(f.root).version, "0.1.2");
  for (const path of ["package.json", "apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json"])
    assert.equal(f.json(path).version, "0.1.2");
  const lock = f.json("package-lock.json");
  assert.equal(lock.version, "0.1.2");
  assert.equal(lock.packages[""].version, "0.1.2");
  assert.equal(lock.packages["apps/desktop"].version, "0.1.2");
  assert.equal(lock.packages["apps/server"].version, "0.1.0");
  assert.equal(lock.packages["node_modules/example"].version, "2.3.4");
  assert.match(f.read("Cargo.toml"), /version = "0.1.2"/);
  assert.match(f.read("Cargo.lock"), /name = "term-core"\nversion = "0.1.2"/);
  assert.match(f.read("Cargo.lock"), /name = "termone"\nversion = "0.1.2"/);
  assert.match(f.read("Cargo.lock"), /name = "example"\nversion = "0.1.0"/);
});

test("a CI release uses one explicit version on every platform and rejects rollback", (t) => {
  const f = fixture(t);
  assert.equal(prepareBuildVersion(f.root, "v0.2.0").version, "0.2.0");
  assert.equal(prepareBuildVersion(f.root, "0.2.0").version, "0.2.0");
  assert.throws(() => prepareBuildVersion(f.root, "0.1.99"), /不能低于/);
  assert.throws(() => nextBuildVersion("0.2.0", "invalid"), /无效/);
});

test("inconsistent version files fail before any version is changed", (t) => {
  const f = fixture(t);
  f.write("apps/desktop/package.json", { version: "0.0.9" });
  assert.throws(() => prepareBuildVersion(f.root), /不一致/);
  assert.equal(f.json("apps/desktop/src-tauri/tauri.conf.json").version, "0.1.0");
  assert.equal(f.json("package.json").version, "0.1.0");
});
