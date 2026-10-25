import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { TerminalInputGuard } from "../apps/desktop/src/terminalInputGuard.ts";
const safe = { statementCount: 1, multiLine: false, risk: "safe", reasons: [] };
const danger = { ...safe, risk: "danger", reasons: ["recursiveDelete"] };
const caution = {
  ...safe,
  statementCount: 2,
  multiLine: true,
  risk: "caution",
  reasons: ["multiLinePaste"],
};
function fixture({
  check = async () => safe,
  confirm = async () => true,
  bracketed = false,
} = {}) {
  const sent = [],
    checked = [],
    errors = [],
    prompts = [];
  const guard = new TerminalInputGuard({
    check: async (text) => {
      checked.push(text);
      return check(text);
    },
    confirm: async (result, text, signal) => {
      prompts.push({ result, text });
      return confirm(result, text, signal);
    },
    send: (data) => sent.push(data),
    paste: (text) =>
      guard.input(
        bracketed
          ? "\x1b[200~" + text.replace(/\r?\n/g, "\r") + "\x1b[201~"
          : text.replace(/\r?\n/g, "\r"),
      ),
    visibleLine: () => "$ rm -rf /tmp/fixture",
    error: (text) => errors.push(text),
  });
  return { guard, sent, checked, errors, prompts };
}
test("Ordinary typing stays synchronous; Enter is withheld until classification finishes", async () => {
  let finish;
  const f = fixture({
    check: () => new Promise((resolve) => (finish = resolve)),
  });
  for (const c of "ls -la") f.guard.input(c);
  assert.equal(f.sent.join(""), "ls -la");
  f.guard.input("\r");
  assert.equal(f.sent.join(""), "ls -la");
  assert.equal(f.checked[0], "ls -la\n");
  finish(safe);
  await settle();
  assert.equal(f.sent.join(""), "ls -la\r");
  f.guard.dispose();
});
test("Cancelled multiline paste sends no bytes, approved paste preserves bracketed mode", async () => {
  const cancelled = fixture({
    check: async () => caution,
    confirm: async () => false,
  });
  cancelled.guard.paste("echo 一\necho 二");
  await settle();
  assert.deepEqual(cancelled.sent, []);
  assert.equal(cancelled.prompts.length, 1);
  const accepted = fixture({ check: async () => caution, bracketed: true });
  accepted.guard.paste("echo 一\necho 二");
  await settle();
  assert.deepEqual(accepted.sent, ["\x1b[200~echo 一\recho 二\x1b[201~"]);
  accepted.guard.input("\r");
  await settle();
  assert.equal(accepted.checked.length, 1);
  assert.equal(accepted.sent[1], "\r");
  accepted.guard.dispose();
  cancelled.guard.dispose();
});
test("A pasted suffix is checked together with the already typed prefix before sending", async () => {
  const f = fixture({ check: async () => danger, confirm: async () => false });
  f.guard.input("r");
  f.guard.paste("m -rf /tmp/fixture");
  await settle();
  assert.equal(f.checked[0], "rm -rf /tmp/fixture");
  assert.deepEqual(f.sent, ["r"]);
  f.guard.dispose();
});
test("Dangerous typed Enter can be cancelled and retried without losing the tracked command", async () => {
  const f = fixture({ check: async () => danger, confirm: async () => false });
  for (const c of "rm -rf /tmp/fixture") f.guard.input(c);
  f.guard.input("\r");
  await settle();
  f.guard.input("\r");
  await settle();
  assert.equal(f.prompts.length, 2);
  assert.equal(f.sent.join(""), "rm -rf /tmp/fixture");
  f.guard.dispose();
});
test("Editing after an approved paste invalidates approval and rechecks the final text", async () => {
  const f = fixture({ check: async () => danger });
  f.guard.paste("rm -rf /tmp/fixture");
  await settle();
  f.guard.input("x");
  f.guard.input("\r");
  await settle();
  assert.equal(f.checked.length, 2);
  assert.equal(f.prompts[1].text, "rm -rf /tmp/fixturex\r");
  f.guard.dispose();
});
test("History navigation uses the visible terminal line for the final check", async () => {
  const f = fixture({ check: async () => danger, confirm: async () => false });
  f.guard.input("\x1b[A");
  f.guard.input("\r");
  await settle();
  assert.match(f.checked[0], /rm -rf/);
  assert.deepEqual(f.sent, ["\x1b[A"]);
  f.guard.dispose();
});
test("A disposed session cannot send a paste when a late check or confirmation returns", async () => {
  let finish;
  const f = fixture({
    check: () => new Promise((resolve) => (finish = resolve)),
  });
  f.guard.paste("echo test");
  f.guard.dispose();
  finish(safe);
  await settle();
  assert.deepEqual(f.sent, []);
  let approval;
  const g = fixture({
    check: async () => danger,
    confirm: (_r, _t, signal) =>
      new Promise((resolve) => {
        approval = resolve;
        signal.addEventListener("abort", () => resolve(false));
      }),
  });
  g.guard.paste("rm -rf /tmp/fixture");
  await settle();
  g.guard.dispose();
  approval(true);
  await settle();
  assert.deepEqual(g.sent, []);
});
test("Classifier errors and unsafe clipboard control bytes fail closed", async () => {
  const f = fixture({
    check: async () => {
      throw new Error("IPC unavailable");
    },
  });
  f.guard.paste("echo ok");
  await settle();
  assert.deepEqual(f.sent, []);
  assert.equal(f.errors.length, 1);
  const g = fixture();
  g.guard.paste("echo ok\x1b[201~bad");
  await settle();
  assert.deepEqual(g.sent, []);
  assert.equal(g.checked.length, 0);
  g.guard.paste("x".repeat(1024 * 1024 + 1));
  await settle();
  assert.deepEqual(g.sent, []);
  assert.equal(g.checked.length, 0);
  f.guard.dispose();
  g.guard.dispose();
});
test("A pending confirmation prevents another input from overtaking the guarded text", async () => {
  let finish;
  const f = fixture({
    check: async () => danger,
    confirm: () => new Promise((resolve) => (finish = resolve)),
  });
  f.guard.paste("rm -rf /tmp/fixture");
  await settle();
  f.guard.input("\r");
  f.guard.paste("echo overtaking");
  assert.deepEqual(f.sent, []);
  finish(false);
  await settle();
  assert.deepEqual(f.sent, []);
  f.guard.dispose();
});

test("History/completion still requires confirmation when visible output has not caught up", async () => {
  const f = fixture({ check: async () => safe, confirm: async () => false });
  f.guard.input("\t");
  f.guard.input("\r");
  await settle();
  assert.equal(f.prompts[0].result.risk, "caution");
  assert.ok(f.prompts[0].result.reasons.includes("editedInput"));
  assert.deepEqual(f.sent, ["\t"]);
  f.guard.dispose();
});
test("Enter submits the entire edited line rather than inserting a newline at the caret", async () => {
  const f = fixture();
  for (const c of "echo okay") f.guard.input(c);
  f.guard.input("\x01");
  f.guard.input("\r");
  await settle();
  assert.equal(f.checked[0], "echo okay\n");
  f.guard.dispose();
});

test("Backslash-continued commands retain the first line for the next Enter check", async () => {
  const f = fixture({
    check: async (text) => (text.includes("-rf") ? danger : safe),
    confirm: async () => false,
  });
  for (const c of "rm \\") f.guard.input(c);
  f.guard.input("\r");
  await settle();
  for (const c of "-rf /tmp/fixture") f.guard.input(c);
  f.guard.input("\r");
  await settle();
  assert.equal(f.checked[1], "rm -rf /tmp/fixture\n");
  assert.equal(f.prompts.length, 1);
  assert.equal(f.sent.join(""), "rm \\\r-rf /tmp/fixture");
  f.guard.dispose();
});

test("Quoted multiline input retains its complete logical text and resets when submitted", async () => {
  const f = fixture();
  for (const c of 'echo "a') f.guard.input(c);
  f.guard.input("\r");
  await settle();
  for (const c of 'b"') f.guard.input(c);
  f.guard.input("\r");
  await settle();
  assert.equal(f.checked[1], 'echo "a\nb"\n');
  f.guard.input("l");
  f.guard.input("s");
  f.guard.input("\r");
  await settle();
  assert.equal(f.checked[2], "ls\n");
  f.guard.dispose();
});
