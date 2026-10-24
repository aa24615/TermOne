import { useState } from "react";
import { useRegistry } from "../plugin/registry";
import { useStore } from "../store";
import { Modal } from "./Dialog";
export function CommandsDialog() {
  const items = useRegistry(s => s.items); const [query,setQuery] = useState("");
  return <Modal title="插件命令" onClose={() => useStore.getState().setDialog(null)} width={560}><input autoFocus placeholder="搜索命令" value={query} onChange={e => setQuery(e.target.value)} />{Object.entries(items).filter(([,item]) => item.kind === "command" && item.title.toLowerCase().includes(query.toLowerCase())).map(([key,item]) => <button key={key} className="side-btn" onClick={() => { useStore.getState().setDialog(null); item.run?.(); }}>{item.title} {item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}{!Object.values(items).some(i => i.kind === "command") && <p className="muted">尚无插件注册命令，请先启用对应插件。</p>}</Modal>;
}
