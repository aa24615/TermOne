import { useEffect, useState } from "react";
import { ImageAddon } from "@xterm/addon-image";
import Zmodem, { type Session as ZSession, type Detection } from "zmodem.js";
import type { Host } from "../plugin/types";
import { report } from "../plugin/shared";
interface Protocol {
  session: ZSession | null;
  status: string;
  flush: () => Promise<void>;
}
const protocols = new WeakMap<Host, Map<string, Protocol>>();
const LIMIT = 64 * 1024 * 1024;
export function activate(host: Host) {
  const entries = new Map<string, Protocol>();
  protocols.set(host, entries);
  const detach = host.terminals((h) => {
    let alive = true;
    let queue = Promise.resolve();
    const state: Protocol = {
      session: null,
      status: "Sixel 就绪",
      flush: () => queue,
    };
    entries.set(h.id, state);
    const image = h.addon(
      new ImageAddon({
        storageLimit: 16,
        pixelLimit: 4_194_304,
        sixelSupport: true,
        iipSupport: false,
      }),
    );
    const detect = async (detection: Detection) => {
      if (
        !(await host.confirm(
          "会话 " +
            (host.sessions().find((s) => s.id === h.id)?.title ??
              h.id.slice(0, 8)) +
            " 请求 Zmodem 文件传输，是否接受？",
        ))
      ) {
        if (alive && detection.is_valid()) detection.deny();
        return;
      }
      if (!alive || !detection.is_valid()) return;
      const session = detection.confirm();
      state.session = session;
      state.status =
        session.type === "send"
          ? "远端 rz 就绪，请在插件面板选择文件"
          : "正在接收文件";
      session.on("session_end", () => {
        state.session = null;
        state.status = "传输结束";
      });
      if (session.type === "receive") {
        session.on("offer", (offer) => {
          const details = offer.get_details();
          if (details.size > LIMIT || !Number.isFinite(details.size)) {
            offer.skip();
            host.toast("文件超过 64 MiB，已拒绝", true);
            return;
          }
          report(host, async () => {
            if (
              !(await host.confirm(
                "接收文件「" + details.name + "」（" + details.size + " B）？",
              ))
            ) {
              offer.skip();
              return;
            }
            if (!alive) return;
            let size = 0;
            offer.on("input", (bytes) => {
              size += bytes.length;
              if (size > LIMIT) {
                session.abort();
                state.status = "接收超过大小上限，已中止";
              }
            });
            const payloads = await offer.accept();
            if (!alive || size > LIMIT) return;
            const blob = new Blob(payloads as BlobPart[]);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = details.name.split(/[\\/]/).pop() || "received.bin";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            state.status = "已接收 " + a.download;
          });
        });
        session.start();
      }
    };
    const sentry = new Zmodem.Sentry({
      to_terminal: (bytes) => {
        if (alive) h.term.write(Uint8Array.from(bytes));
      },
      sender: (bytes) => {
        queue = queue
          .then(() => host.writeBytes(h.id, Uint8Array.from(bytes)))
          .catch((e) => {
            if (alive) {
              state.status = String(e);
              host.toast("Zmodem 传输失败", true);
            }
          });
      },
      on_detect: (detection) => {
        void detect(detection).catch((e) => {
          if (alive) host.toast(String(e), true);
        });
      },
      on_retract: () => {
        state.status = "检测已撤销";
      },
    });
    const output = h.output((bytes) => {
      sentry.consume(bytes);
      return null;
    });
    const input = h.input((text) => (state.session ? null : text));
    return () => {
      try {
        state.session?.abort();
      } catch {
        /* peer may already have exited */
      }
      alive = false;
      output();
      input();
      image();
      entries.delete(h.id);
    };
  });
  return () => {
    detach();
    entries.clear();
    protocols.delete(host);
  };
}
export default function ZmodemPanel({ host }: { host: Host }) {
  const [version, refresh] = useState(0);
  const [target, setTarget] = useState("");
  const entries = protocols.get(host) ?? new Map<string, Protocol>();
  useEffect(() => {
    const timer = setInterval(() => refresh((n) => n + 1), 600);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="plugin-stack" data-revision={version}>
      <p>
        Sixel 图片解码已开启，图像存储上限 16 MiB。远端运行 <code>sz 文件</code>{" "}
        接收、<code>rz</code> 后选文件发送。每次传输需要确认，单文件上限 64
        MiB。
      </p>
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">选择传输会话</option>
        {[...entries.entries()].map(([id, p]) => (
          <option key={id} value={id}>
            {host.sessions().find((s) => s.id === id)?.title ?? id.slice(0, 8)}{" "}
            · {p.status}
          </option>
        ))}
      </select>
      <label>
        发送文件
        <input
          type="file"
          disabled={!target || entries.get(target)?.session?.type !== "send"}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            report(host, async () => {
              const entry = entries.get(target);
              const session = entry?.session;
              if (!session || !entry) throw new Error("远端尚未执行 rz");
              if (file.size > LIMIT) throw new Error("文件超过 64 MiB");
              if (
                !(await host.confirm("向所选会话发送「" + file.name + "」？"))
              )
                return;
              const transfer = await session.send_offer({
                name: file.name,
                size: file.size,
                mtime: new Date(file.lastModified),
              });
              if (!transfer) return;
              for (let at = 0; at < file.size; at += 65536) {
                if (host.signal.aborted) return;
                transfer.send(
                  new Uint8Array(
                    await file.slice(at, at + 65536).arrayBuffer(),
                  ),
                );
                await entry.flush();
                entry.status =
                  "发送 " + Math.min(at + 65536, file.size) + "/" + file.size;
              }
              await transfer.end();
              await entry.flush();
              await session.close();
              entry.status = "发送完成";
            });
          }}
        />
      </label>
      <button
        className="btn danger"
        disabled={!entries.get(target)?.session}
        onClick={() => {
          entries.get(target)?.session?.abort();
        }}
      >
        中止传输
      </button>
      {[...entries.entries()].map(([id, p]) => (
        <p key={id}>
          {id.slice(0, 8)}：{p.status}
        </p>
      ))}
    </div>
  );
}
