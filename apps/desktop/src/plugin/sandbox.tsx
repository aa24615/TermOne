import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { installedKind, kindName } from "./kinds";
import { createHost } from "./hostApi";
import type { Host, Installed, PluginModule } from "./types";

// Only this trusted bridge runs in the iframe. Untrusted ESM runs in a Worker:
// no DOM, no navigation, no Tauri, CSP denies direct networking and imports.
const workerBridge = String.raw`
let seq=0; const pending=new Map(), callbacks=new Map();
const call=(method,args=[])=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});postMessage({kind:'rpc',id,method,args});});
const viewCallbacks=new Set();
const wire=(view,owned=viewCallbacks)=>JSON.parse(JSON.stringify(view,(_,value)=>{if(typeof value==='function'){const id=++seq;callbacks.set(id,value);owned.add(id);return {callback:id};}return value;}));
const registerView=(method,id,title,view)=>{const owned=new Set();const dispose=registration(method,[id,title,wire(view,owned)]);return ()=>{for(const id of owned)callbacks.delete(id);dispose();};};
const registration=(method,args)=>{const id=++seq;call(method,[...args,id]);return ()=>call('unsubscribe',[id]);};
const ui={render(view){for(const id of viewCallbacks)callbacks.delete(id);viewCallbacks.clear();postMessage({kind:'view',view:wire(view)});},
 registerCommand(id,title,run,shortcut){const cb=++seq;callbacks.set(cb,run);const dispose=registration('ui.command',[id,title,cb,shortcut]);return ()=>{callbacks.delete(cb);dispose();};},
 registerPanel:(id,title,view)=>registerView('ui.panel',id,title,view),
 registerSetting:(id,title,view)=>registerView('ui.setting',id,title,view),
 setStatusBar:(id,text)=>registration('ui.status',[id,text])};
onunhandledrejection=event=>postMessage({kind:'error',error:String(event.reason)});

const host={invoke:(...a)=>call('invoke',a),sessions:()=>call('sessions'),write:(...a)=>call('write',a),toast:(...a)=>call('toast',a),confirm:(...a)=>call('confirm',a),openDialog:(...a)=>call('openDialog',a),ui,
 storage:{get:(...a)=>call('storage.get',a),set:(...a)=>call('storage.set',a),remove:(...a)=>call('storage.remove',a)},
 fetch:async(...a)=>{const data=await call('fetch',a);return {ok:data.ok,status:data.status,json:async()=>JSON.parse(data.body),text:async()=>data.body};},
 output(cb){const id=++seq;callbacks.set(id,cb);call('output',[id]);return ()=>{callbacks.delete(id);call('unsubscribe',[id]);};},
 onSessions(cb){const id=++seq;callbacks.set(id,cb);call('onSessions',[id]);return ()=>{callbacks.delete(id);call('unsubscribe',[id]);};}};
onmessage=async({data})=>{if(data.kind==='start'){try{const url=URL.createObjectURL(new Blob([data.code],{type:'text/javascript'}));const module=await import(url);URL.revokeObjectURL(url);await module.activate({host,manifest:data.manifest,assets:data.files});postMessage({kind:'ready'});}catch(e){postMessage({kind:'error',error:String(e)});}}
 else if(data.kind==='result'){const p=pending.get(data.id);pending.delete(data.id);if(p){data.error?p.reject(new Error(data.error)):p.resolve(data.value);}}
 else if(data.kind==='callback'){try{await callbacks.get(data.id)?.(...data.args);}catch(e){postMessage({kind:'error',error:String(e)});}}};
`;
type View = {
  type?: string;
  text?: string;
  label?: string;
  value?: string;
  children?: View[];
  onClick?: { callback: number };
  onChange?: { callback: number };
};
function renderView(
  v: View,
  send: (id: number, value?: string) => void,
  depth = 0,
): ReactNode {
  if (!v || depth > 10) return null;
  const children = (v.children ?? [])
    .slice(0, 200)
    .map((c, i) => <div key={i}>{renderView(c, send, depth + 1)}</div>);
  switch (v.type) {
    case "button":
      return (
        <button
          className="btn"
          onClick={() => {
            if (v.onClick) send(v.onClick.callback);
          }}
        >
          {v.text ?? v.label}
        </button>
      );
    case "input":
      return (
        <label>
          {v.label}
          <input
            defaultValue={v.value}
            onChange={(e) => {
              if (v.onChange) send(v.onChange.callback, e.target.value);
            }}
          />
        </label>
      );
    case "textarea":
      return (
        <label>
          {v.label}
          <textarea
            defaultValue={v.value}
            onChange={(e) => {
              if (v.onChange) send(v.onChange.callback, e.target.value);
            }}
          />
        </label>
      );
    case "pre":
      return <pre>{v.text}</pre>;
    case "column":
    case "row":
      return <div className="plugin-stack">{children}</div>;
    default:
      return <p>{v.text}</p>;
  }
}

function ExternalPanel({ plugin, outer }: { plugin: Installed; outer: Host }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const token = useRef(crypto.randomUUID());
  const code = useRef("");
  const post = (value: unknown) =>
    frame.current?.contentWindow?.postMessage(
      { token: token.current, ...(value as object) },
      "*",
    );
  useEffect(() => {
    const host = createHost(plugin);
    const subscriptions = new Map<number, () => void>();
    let disposed = false;
    let ready = false;
    const stop = () => {
      post({ kind: "stop" });
      disposed = true;
      host.dispose();
      for (const d of subscriptions.values()) d();
      subscriptions.clear();
    };
    outer.signal.addEventListener("abort", stop, { once: true });
    let count = 0;
    let last = Date.now();
    const listener = async (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.token !== token.current ||
        disposed
      )
        return;
      const msg = event.data;
      if (Date.now() - last > 1000) {
        last = Date.now();
        count = 0;
      }
      if (++count > 200 || JSON.stringify(msg).length > 250_000) {
        setError("插件超出消息配额，已停止");
        stop();
        return;
      }
      if (msg.kind === "ready") {
        ready = true;
        return;
      }
      if (msg.kind === "error") {
        setError(String(msg.error));
        stop();
        return;
      }
      if (msg.kind === "view") {
        try {
          await host.authorize({ type: "ui-panel" }, "ui.panel.render");
          if (!disposed) setView(msg.view);
        } catch (e) {
          setError(String(e));
          stop();
        }
        return;
      }
      if (msg.kind === "rpc") {
        try {
          if (subscriptions.size >= 64 && msg.method !== "unsubscribe")
            throw new Error("插件订阅数量超限");
          if (!Array.isArray(msg.args))
            throw new Error("Host API 参数格式错误");
          const a = msg.args as unknown[];
          let value: unknown;
          switch (msg.method) {
            case "invoke":
              value = await host.invoke(
                String(a[0]),
                a[1] as Record<string, unknown>,
              );
              break;
            case "sessions":
              value = host.sessions();
              break;
            case "write":
              value = await host.write(String(a[0]), String(a[1]));
              break;
            case "toast":
              value = host.toast(String(a[0]), Boolean(a[1]));
              break;
            case "confirm":
              value = await host.confirm(String(a[0]));
              break;
            case "openDialog":
              value = await host.openDialog(Boolean(a[0]));
              break;
            case "storage.get":
              value = await host.storage.get(String(a[0]));
              break;
            case "storage.set":
              value = await host.storage.set(String(a[0]), a[1]);
              break;
            case "storage.remove":
              value = await host.storage.remove(String(a[0]));
              break;
            case "fetch": {
              const res = await host.fetch(String(a[0]), a[1] as RequestInit);
              const reader = res.body?.getReader();
              const decoder = new TextDecoder();
              let body = "";
              let bytes = 0;
              if (reader) {
                try {
                  for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    bytes += value.length;
                    if (bytes > 2_000_000) throw new Error("网络响应过大");
                    body += decoder.decode(value, { stream: true });
                  }
                  body += decoder.decode();
                } finally {
                  await reader.cancel();
                }
              }
              value = { ok: res.ok, status: res.status, body };
              break;
            }
            case "ui.command":
              subscriptions.set(
                Number(a[4]),
                host.ui.registerCommand(
                  String(a[0]),
                  String(a[1]),
                  () => post({ kind: "callback", id: Number(a[2]), args: [] }),
                  a[3] ? String(a[3]) : undefined,
                ),
              );
              break;
            case "ui.panel":
              subscriptions.set(
                Number(a[3]),
                host.ui.registerPanel(String(a[0]), String(a[1]), () =>
                  renderView(a[2] as View, (id, value) =>
                    post({
                      kind: "callback",
                      id,
                      args: value === undefined ? [] : [value],
                    }),
                  ),
                ),
              );
              break;
            case "ui.setting":
              subscriptions.set(
                Number(a[3]),
                host.ui.registerSetting(String(a[0]), String(a[1]), () =>
                  renderView(a[2] as View, (id, value) =>
                    post({
                      kind: "callback",
                      id,
                      args: value === undefined ? [] : [value],
                    }),
                  ),
                ),
              );
              break;
            case "ui.status":
              subscriptions.set(
                Number(a[2]),
                host.ui.setStatusBar(String(a[0]), String(a[1])),
              );
              break;
            case "output":
              subscriptions.set(
                Number(a[0]),
                host.output((...args) =>
                  post({ kind: "callback", id: Number(a[0]), args }),
                ),
              );
              break;
            case "onSessions":
              subscriptions.set(
                Number(a[0]),
                host.onSessions((s) =>
                  post({ kind: "callback", id: Number(a[0]), args: [s] }),
                ),
              );
              break;
            case "unsubscribe":
              subscriptions.get(Number(a[0]))?.();
              subscriptions.delete(Number(a[0]));
              break;
            default:
              void invoke("plugin_denied", {
                id: plugin.id,
                action: "unknown-host-api",
              }).catch(() => {});
              throw new Error("不允许的 Host API");
          }
          post({ kind: "result", id: msg.id, value });
        } catch (e) {
          post({ kind: "result", id: msg.id, error: String(e) });
        }
      }
    };
    window.addEventListener("message", listener);
    const start = async () => {
      try {
        const loaded = await invoke<{
          code: string;
          files: Record<string, string>;
          manifest: unknown;
        }>("plugin_load", { id: plugin.id });
        if (!disposed) {
          code.current = JSON.stringify(loaded);
          post({ kind: "start", ...loaded });
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      }
    };
    frame.current?.addEventListener("load", start, { once: true });
    const reload =
      plugin.source === "dev"
        ? setInterval(() => {
            void invoke<{
              code: string;
              files: Record<string, string>;
              manifest: unknown;
            }>("plugin_load", { id: plugin.id })
              .then((p) => {
                if (!disposed && JSON.stringify(p) !== code.current)
                  setRevision((n) => n + 1);
              })
              .catch((e) => {
                setError(String(e));
                stop();
              });
          }, 1500)
        : null;
    const timeout = setTimeout(() => {
      if (!disposed && !ready) {
        setError("插件启动超时，已终止隔离 Worker");
        stop();
      }
    }, 5000);
    return () => {
      stop();
      outer.signal.removeEventListener("abort", stop);
      window.removeEventListener("message", listener);
      frame.current?.removeEventListener("load", start);
      if (reload) clearInterval(reload);
      clearTimeout(timeout);
    };
  }, [plugin.id, outer, revision]);
  const bridge =
    "const token=" +
    JSON.stringify(token.current) +
    ";const worker=new Worker(URL.createObjectURL(new Blob([" +
    JSON.stringify(workerBridge).replace(/</g, "\\u003c") +
    "],{type:'text/javascript'})),{type:'module'});worker.onmessage=({data})=>parent.postMessage({...data,token},'*');worker.onerror=e=>parent.postMessage({kind:'error',error:e.message,token},'*');onmessage=({data,source})=>{if(source===parent&&data?.token===token){if(data.kind==='stop')worker.terminate();else worker.postMessage(data);}};";
  const src =
    "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'\"><script>" +
    bridge +
    "</script>";
  return (
    <>
      <iframe
        key={revision}
        ref={frame}
        title={kindName(installedKind(plugin)) + "隔离运行环境"}
        sandbox="allow-scripts"
        srcDoc={src}
        style={{ display: "none" }}
      />
      {error ? (
        <p role="alert">
          {kindName(installedKind(plugin))}出错：{error}
        </p>
      ) : view ? (
        renderView(view, (id, value) =>
          post({
            kind: "callback",
            id,
            args: value === undefined ? [] : [value],
          }),
        )
      ) : (
        <p>正在启动隔离插件…</p>
      )}
    </>
  );
}
export async function externalModule(plugin: Installed): Promise<PluginModule> {
  return {
    default: ({ host }) => <ExternalPanel plugin={plugin} outer={host} />,
  };
}
