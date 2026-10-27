import test from "node:test";
import assert from "node:assert/strict";
import { chooseReleaseVersion } from "../scripts/github-release-version.mjs";

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
