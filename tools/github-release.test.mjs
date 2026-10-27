import test from "node:test";
import assert from "node:assert/strict";
import { chooseReleaseVersion } from "../scripts/github-release-version.mjs";
import { findWindowsInstaller, verifyWindowsExecutable } from "../scripts/package-windows.mjs";

test("manual GitHub releases increment from both source and reserved tags", () => {
  assert.equal(chooseReleaseVersion("0.1.14", []), "0.1.15");
  assert.equal(chooseReleaseVersion("0.1.14", ["v0.1.15", "v0.1.16", "unrelated"]), "0.1.17");
  assert.equal(chooseReleaseVersion("0.1.9", ["v0.1.10", "v0.1.2"]), "0.1.11");
  assert.equal(chooseReleaseVersion("0.1.14", ["v0.2.0"]), "0.2.1");
});
test("requested versions must be new, stable and valid", () => {
  assert.equal(chooseReleaseVersion("0.1.14", ["v0.1.15"], "v0.2.0"), "0.2.0");
  for (const requested of ["0.1.14", "0.1.15", "0.1.13", "0.01.20", "0.2.0-beta", "$(touch /tmp/nope)", "0.2.0\nmalicious", "9007199254740992.0.0"]) {
    assert.throws(() => chooseReleaseVersion("0.1.14", ["v0.1.15"], requested));
  }
});
test("a failed reservation stays consumed and fresh attempts advance again", () => {
  const reserved = ["v0.1.15"];
  const retry = chooseReleaseVersion("0.1.15", reserved);
  assert.equal(retry, "0.1.16");
  assert.throws(() => chooseReleaseVersion("0.1.15", reserved, "0.1.15"));
});

test("Windows packaging rejects corrupt executables and incorrect architecture", () => {
  const bytes = Buffer.alloc(256);
  bytes.write("MZ"); bytes.writeUInt32LE(128, 0x3c); bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x8664, 132);
  assert.doesNotThrow(() => verifyWindowsExecutable(bytes));
  bytes.writeUInt16LE(0x14c, 132);
  assert.throws(() => verifyWindowsExecutable(bytes), /x64/);
  assert.doesNotThrow(() => verifyWindowsExecutable(bytes, null));
  bytes.writeUInt32LE(0xffffffff, 0x3c);
  assert.throws(() => verifyWindowsExecutable(bytes), /PE/);
  assert.throws(() => verifyWindowsExecutable(Buffer.from("not-an-exe")), /EXE/);
});

test("Windows packaging selects only the reserved version and rejects ambiguous installers", () => {
  const files = ["TermOne_0.1.15_x64-setup.exe", "TermOne_0.1.16_x64-setup.exe", "TermOne_0.1.16_arm64-setup.exe"];
  assert.equal(findWindowsInstaller(files, "0.1.16", "nsis"), files[1]);
  assert.equal(findWindowsInstaller(["TermOne_0.1.16_x64_en-US.msi"], "0.1.16", "msi"), "TermOne_0.1.16_x64_en-US.msi");
  assert.throws(() => findWindowsInstaller(files, "0.1.17", "nsis"));
  assert.throws(() => findWindowsInstaller(["TermOne_0.1.160_x64-setup.exe"], "0.1.16", "nsis"));
  assert.throws(() => findWindowsInstaller(["TermOne_0.1.16_x64.msi", "TermOne_0.1.16_x64_en-US.msi"], "0.1.16", "msi"));
});
