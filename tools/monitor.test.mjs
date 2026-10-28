import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { appendSample, createMonitorController, diskPeak, networkTotal } from "../apps/desktop/src/applications/monitorController.ts";

test("bounded history deduplicates polling, excludes loopback and selects the fullest filesystem", () => {
  let rows = [];
  for (let sequence = 0; sequence < 100; sequence++) rows = appendSample(rows, { sequence });
  assert.equal(rows.length, 60); assert.equal(rows[0].sequence, 40);
  assert.equal(appendSample(rows, { sequence: 99 }), rows);
  const sample = { network: [{ name: "lo", rx_bytes_per_sec: 999, tx_bytes_per_sec: 999 }, { name: "eth0", rx_bytes_per_sec: 10, tx_bytes_per_sec: 20 }], disks: [{ capacity_pct: 20 }, { capacity_pct: 90 }] };
  assert.deepEqual(networkTotal(sample), { rx: 10, tx: 20 });
  assert.deepEqual(networkTotal(sample, "lo"), { rx: 999, tx: 999 });
  assert.equal(diskPeak(sample).capacity_pct, 90);
});

test("switching hosts serializes starts, cleans the old connection and ignores stale snapshots", async () => {
  const abort = new AbortController(), calls = [], states = [];
  let started, polling;
  const host = { signal: abort.signal, invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === "monitor_start" && args.profileId === "a") return new Promise(resolve => { started = resolve; });
    if (command === "monitor_start") return { phase: "running", sample: { sequence: 1, host: "b" }, error: null };
    if (command === "monitor_poll") return new Promise(resolve => { polling = resolve; });
  } };
  const controller = createMonitorController(host, status => states.push(status));
  const a = controller.start("a", 5); await settle();
  const b = controller.start("b", 2);
  started({ phase: "running", sample: { host: "a" } });
  await Promise.all([a, b]); await settle();
  assert.equal(states.some(row => row.sample?.host === "a"), false);
  assert.equal(calls.filter(([command]) => command === "monitor_start").length, 2);
  assert.equal(calls.some(([command]) => command === "monitor_stop"), true);
  await controller.stop();
  polling({ phase: "running", sample: { host: "stale" } }); await settle();
  assert.equal(states.some(row => row.sample?.host === "stale"), false);
  controller.dispose(); abort.abort();
});

test("closing while a connection starts stops the late result and never starts polling", async () => {
  const abort = new AbortController(), calls = [], states = [];
  let ready;
  const host = { signal: abort.signal, invoke: async (command, args) => {
    calls.push([command, args]);
    if (command === "monitor_start") return new Promise(resolve => { ready = resolve; });
  } };
  const controller = createMonitorController(host, state => states.push(state));
  const pending = controller.start("a", 5); await settle();
  controller.dispose(); ready({ phase: "running", sample: { sequence: 1 } });
  await pending; await settle();
  assert.equal(calls.some(([command]) => command === "monitor_stop"), true);
  assert.equal(calls.some(([command]) => command === "monitor_poll"), false);
  assert.equal(states.length, 1);
});
