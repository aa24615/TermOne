import { useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri } from "../env";
import { fromB64, ipc } from "../ipc";
import { scheduleSync, useStore } from "../store";
import { existingSshKeys, IMPORT_FORMATS, parseSshImport, sshConnectionKey, type ImportFile, type ImportFormat } from "../sshImport";
import { Modal } from "./Dialog";
import { Dropdown } from "./Dropdown";

export function SshImportDialog() {
  const profiles = useStore(s => s.profiles), groups = useStore(s => s.groups);
  const setDialog = useStore(s => s.setDialog), showToast = useStore(s => s.showToast);
  const [format, setFormat] = useState<ImportFormat>("auto");
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [readWarnings, setReadWarnings] = useState<string[]>([]);
  const [paste, setPaste] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => parseSshImport(files, format), [files, format]);
  const existing = existingSshKeys(profiles);
  const seen = new Set(existing);
  const duplicates = preview.entries.map(e => { const key = sshConnectionKey(e.config); const exists = seen.has(key); seen.add(key); return exists; });
  const enabled = preview.entries.map((_, i) => i).filter(i => !skipDuplicates || !duplicates[i]);
  const chosen = enabled.filter(i => selected.has(i));
  const close = () => { if (!busy) setDialog(null); };
  const load = (next: ImportFile[], warnings: string[] = [], nextFormat = format) => {
    setError(""); setFiles(next); setReadWarnings(warnings); setPage(0);
    const parsed = parseSshImport(next, nextFormat);
    setSelected(new Set(parsed.entries.map((_, i) => i)));
  };
  const pick = async (directory: boolean) => {
    setError("");
    try {
      const selection = await open({ title: directory ? "选择 SSH 软件的配置目录" : "选择 SSH 配置文件", directory, multiple: !directory });
      if (!selection) return;
      setBusy(true);
      const result = await ipc.sshImportRead(Array.isArray(selection) ? selection : [selection]);
      load(result.files.map(f => ({ name: f.name, data: fromB64(f.dataB64) })), result.warnings);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!chosen.length || busy) return;
    setBusy(true); setError("");
    try {
      const stats = await ipc.sshImportApply(chosen.map(i => {
        const { name, group, config } = preview.entries[i]; return { name, group, config };
      }), skipDuplicates, parentId || null);
      await Promise.all([useStore.getState().loadProfiles(), useStore.getState().loadGroups()]);
      scheduleSync();
      showToast(`已导入 ${stats.imported} 个 SSH 连接、新建 ${stats.groups} 个分组${stats.skipped ? `，跳过 ${stats.skipped} 个重复连接` : ""}`, "success");
      setDialog(null);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const groupLabel = (id: string): string => {
    const names: string[] = [], visited = new Set<string>();
    let g = groups.find(g => g.id === id);
    while (g && !visited.has(g.id)) { visited.add(g.id); names.unshift(g.name); g = groups.find(p => p.id === g!.parentId); }
    return names.join(" / ");
  };
  return <Modal title="导入 SSH 配置" onClose={close} width={900}>
    <div className="ssh-import">
      <p className="form-hint">从其他软件迁移远程 SSH 连接，保留名称、主机、端口、用户名和分组。先预览，再导入。</p>
      <div className="import-controls">
        <label>来源软件<Dropdown ariaLabel="来源软件" disabled={busy} value={format} options={IMPORT_FORMATS.map(([value, label]) => ({ value, label }))} onChange={value => {
          const next = value as ImportFormat; setFormat(next); load(files, readWarnings, next);
        }} /></label>
        <label>导入到分组<Dropdown ariaLabel="导入到分组" disabled={busy} value={parentId} options={[{ value: "", label: "根目录（保留原分组）" }, ...groups.map(g => ({ value: g.id, label: groupLabel(g.id) }))]} onChange={setParentId} /></label>
      </div>
      <div className="import-buttons">
        <button className="btn" disabled={busy} onClick={() => isTauri() ? void pick(false) : fileInput.current?.click()}>选择配置文件（可多选）</button>
        {isTauri() && <button className="btn" disabled={busy} onClick={() => void pick(true)}>选择配置目录</button>}
        <input hidden ref={fileInput} type="file" multiple onChange={async e => {
          const list = Array.from(e.target.files || []);
          if (list.length > 1000 || list.some(f => f.size > 16 * 1024 * 1024) || list.reduce((n, f) => n + f.size, 0) > 32 * 1024 * 1024) { setError("文件数量或大小超过限制"); return; }
          setBusy(true);
          try { load(await Promise.all(list.map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })))); }
          catch { setError("读取配置文件失败"); } finally { setBusy(false); }
        }} />
        <span className="form-hint">{busy ? "处理中…" : files.length ? `已选择 ${files.length} 个文件` : "支持文件、多文件、配置目录与未加密 ZIP / XTS"}</span>
      </div>
      <details className="import-help" open={format === "termius" || undefined}>
        <summary>各软件配置位置与兼容说明</summary>
        <p>Tabby：设置 → 配置文件中的 config.yaml；WindTerm：profiles/default.v10/terminal/user.sessions（版本目录可能不同）。</p>
        <p>electerm：设置 → 同步 → 导出的全量 JSON，或复制的单个书签 JSON；iTerm2：设置 → Profiles → Other Actions → Save Profile as JSON，也可选择 com.googlecode.iterm2.plist。iTerm2 仅迁移直接 ssh 命令对应的远程连接。</p>
        <p>Termius：选择已有的 CSV 或 OpenSSH 格式迁移文件，也可按下面的 CSV 模板整理连接。加密数据目录不能直接导入。</p>
        <p>Xshell：会话 .xsh 或未加密 .xts；FinalShell：conn 目录；SecureCRT：Sessions 目录或导出的 XML；PuTTY / KiTTY：Sessions 注册表导出 .reg；MobaXterm：INI 或会话导出文件。</p>
        <p>也支持 mRemoteNG / SuperPuTTY XML、WinSCP INI、Remmina。加密归档请先在原软件解密导出。私钥只迁移路径；密码需连接时重新输入。代理、隧道或登录脚本未完整迁移时会提示检查。</p>
      </details>
      <details>
        <summary>粘贴配置 / CSV 模板</summary>
        <textarea aria-label="粘贴 SSH 配置" disabled={busy} spellCheck={false} rows={5} value={paste} onChange={e => setPaste(e.target.value)} placeholder={'name,host,port,username,group\n生产服务器,192.0.2.10,22,root,生产/华东\n\n也可粘贴 OpenSSH 配置或 Tabby YAML'} />
        <button className="btn" disabled={busy || !paste.trim()} onClick={() => load([{ name: /^\s*\{/.test(paste) ? "粘贴.json" : "粘贴配置", data: new TextEncoder().encode(paste) }])}>解析粘贴内容</button>
      </details>
      {!!files.length && <>
        <div className="import-summary">
          <span>识别 {preview.entries.length} 个 SSH 连接 · 已选 {chosen.length} 个 · 重复 {duplicates.filter(Boolean).length} 个</span>
          <label><input type="checkbox" disabled={busy} checked={skipDuplicates} onChange={e => setSkipDuplicates(e.target.checked)} />跳过重复连接</label>
        </div>
        <div className="import-table-wrap"><table className="import-table">
          <thead><tr><th><input type="checkbox" aria-label="全选连接" disabled={busy || !enabled.length} checked={!!enabled.length && chosen.length === enabled.length} onChange={e => setSelected(e.target.checked ? new Set(enabled) : new Set())} /></th><th>连接名称 / 来源</th><th>主机 / 用户</th><th>分组</th><th>检查结果</th></tr></thead>
          <tbody>{preview.entries.slice(page * 100, page * 100 + 100).map((entry, offset) => {
            const i = page * 100 + offset, duplicate = duplicates[i];
            return <tr key={i} className={duplicate && skipDuplicates ? "import-skipped" : undefined}>
              <td><input type="checkbox" aria-label={`导入 ${entry.name}`} disabled={busy || duplicate && skipDuplicates} checked={chosen.includes(i)} onChange={e => setSelected(previous => { const next = new Set(previous); if (e.target.checked) next.add(i); else next.delete(i); return next; })} /></td>
              <td><strong>{entry.name}</strong><small>{entry.source}</small></td>
              <td>{entry.config.host}:{entry.config.port}<small>{entry.config.user || "使用本机默认用户名"}{entry.config.proxyJump ? ` · 跳板 ${entry.config.proxyJump}` : ""}</small></td>
              <td>{entry.group.join(" / ") || "未分组"}</td>
              <td>{duplicate ? "重复连接" : "可导入"}{entry.warnings.map(w => <small key={w} className="import-notice">{w}</small>)}</td>
            </tr>;
          })}</tbody>
        </table>{!preview.entries.length && <p className="form-hint">未识别到可导入的 SSH 连接，请检查来源格式和下面的提示。</p>}</div>
        {preview.entries.length > 100 && <div className="import-pagination"><button className="btn" disabled={!page} onClick={() => setPage(p => p - 1)}>上一页</button><span>{page + 1} / {Math.ceil(preview.entries.length / 100)}</span><button className="btn" disabled={(page + 1) * 100 >= preview.entries.length} onClick={() => setPage(p => p + 1)}>下一页</button></div>}
      </>}
      {(readWarnings.length > 0 || preview.warnings.length > 0) && <details className="import-notice" open><summary>解析提示（{readWarnings.length + preview.warnings.length}）</summary><ul>{[...readWarnings, ...preview.warnings].slice(0, 100).map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
      {error && <p role="alert" className="form-error">{error}</p>}
      <div className="form-actions"><button className="btn" disabled={busy} onClick={close}>取消</button><button className="btn primary" disabled={busy || !chosen.length} onClick={() => void apply()}>{busy ? "处理中…" : `导入 ${chosen.length} 个 SSH 连接`}</button></div>
    </div>
  </Modal>;
}
