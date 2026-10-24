import assert from "node:assert/strict";
import Zmodem from "zmodem.js";
const bytes = Uint8Array.from({ length: 1024 * 1024 + 255 }, (_, i) => i % 256);
const receiver = new Zmodem.Session.Receive();
let resolveSender;
const senderReady = new Promise((resolve) => (resolveSender = resolve));
let fail;
const failure = new Promise((_, reject) => (fail = reject));
const deliver = (fn) => (data) => {
  const copy = Array.from(data);
  queueMicrotask(() => {
    try {
      fn(copy);
    } catch (e) {
      fail(e);
    }
  });
};
const sentry = new Zmodem.Sentry({
  to_terminal: () => {},
  on_retract: () => {},
  sender: deliver((data) => receiver.consume(data)),
  on_detect: (detection) => resolveSender(detection.confirm()),
});
receiver.set_sender(deliver((data) => sentry.consume(data)));
let received;
let accepted;
receiver.on("offer", (offer) => {
  accepted = offer.accept().then((payloads) => {
    received = Buffer.concat(payloads.map((b) => Buffer.from(b)));
  });
});
let timer;
await Promise.race([
  (async () => {
    const done = receiver.start();
    const sender = await senderReady;
    const transfer = await sender.send_offer({
      name: "binary-all-bytes.bin",
      size: bytes.length,
      mtime: new Date(),
    });
    assert.ok(transfer);
    for (let at = 0; at < bytes.length; at += 65536)
      transfer.send(bytes.slice(at, at + 65536));
    await transfer.end();
    await accepted;
    await sender.close();
    await done;
    assert.deepEqual(received, Buffer.from(bytes));
    console.log(
      "PASS Zmodem 1 MiB binary offer/accept/send/receive/close and byte equality",
    );
  })(),
  failure,
  new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Zmodem timeout")), 15000);
  }),
]).finally(() => clearTimeout(timer));
