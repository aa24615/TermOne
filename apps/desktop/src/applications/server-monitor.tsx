import { useEffect, useMemo, useRef, useState } from "react";
import type { Host } from "../plugin/types";
import { Dropdown } from "../components/Dropdown";
import { screenIsLocked } from "../screenLock";
import { appendSample, createMonitorController, diskPeak, networkTotal, type MonitorSample, type MonitorStatus } from "./monitorController";
import "./server-monitor.css";

const idle: MonitorStatus = { phase: "idle", sample: null, error: null };
const phases: Record<string, string> = { idle: "未开始", connecting: "正在连接…", auth: "等待 SSH 认证", running: "采集中", stopped: "已停止", error: "采集已中断" };
function bytes(value: number) { const index = Math.min(4, Math.max(0, Math.floor(Math.log2(Math.max(1, value)) / 10))); return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}`; }
function pct(value: number | null | undefined) { return value == null ? "采样中…" : `${value.toFixed(1)}%`; }
function Chart({ title, series, percentage = false }: { title: string; series: (number | null)[][]; percentage?: boolean }) {
  const maximum = percentage ? 100 : Math.max(1, ...series.flat().filter((v): v is number => v != null));
  return <svg className="monitor-chart" viewBox="0 0 480 100" role="img" aria-label={`${title}最近 60 次采样趋势`} preserveAspectRatio="none">
    {[20, 60, 98].map(y => <path key={y} className="monitor-gridline" d={`M0 ${y} H480`} />)}
    {series.map((values, index) => <path key={index} className={index ? "monitor-line secondary" : "monitor-line"} d={values.map((value, i) => value == null ? "" : `${i === 0 || values[i - 1] == null ? "M" : "L"}${i * 480 / Math.max(1, values.length - 1)},${98 - Math.min(maximum, Math.max(0, value)) / maximum * 90}`).join(" ")} />)}
  </svg>;
}
export default function ServerMonitor({ host }: { host: Host }) {
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [profileId, setProfileId] = useState("");
  const [interval, setIntervalValue] = useState(5);
  const [network, setNetwork] = useState("");
  const [status, setStatus] = useState<MonitorStatus>(idle);
  const [samples, setSamples] = useState<MonitorSample[]>([]);
  const [secret, setSecret] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const controller = useMemo(() => createMonitorController(host, next => {
    if (!alive.current) return;
    setStatus(next);
    if (next.sample) setSamples(rows => appendSample(rows, next.sample!));
  }, screenIsLocked), [host]);
  useEffect(() => {
    alive.current = true;
    void host.invoke<{ id: string; name: string }[]>("profile_refs").then(rows => { if (alive.current) setProfiles(rows); }).catch(error => { if (alive.current) setError(String(error)); });
    return () => { alive.current = false; controller.dispose(); };
  }, [controller, host]);
  useEffect(() => { if (status.phase !== "auth") setSecret(""); }, [status.phase]);
  const active = ["connecting", "auth", "running"].includes(status.phase);
  const sample = samples.at(-1);
  const disk = sample && diskPeak(sample);
  const total = sample && networkTotal(sample, network);
  const stop = () => { void controller.stop(); setStatus(previous => ({ ...previous, phase: "stopped", error: null })); setSecret(""); setError(""); };
  const start = () => { setSamples([]); setNetwork(""); setSecret(""); setError(""); void controller.start(profileId, interval); };
  return <div className="server-monitor">
    <div className="monitor-controls">
      <label>SSH 主机<Dropdown ariaLabel="监控 SSH 主机" value={profileId} options={profiles.map(row => ({ value: row.id, label: row.name }))} placeholder="请选择 Linux 服务器" onChange={value => { stop(); setSamples([]); setProfileId(value); }} /></label>
      <label>采样间隔<Dropdown ariaLabel="监控采样间隔" value={String(interval)} options={[2, 5, 10, 30].map(value => ({ value: String(value), label: `${value} 秒` }))} onChange={value => { stop(); setIntervalValue(Number(value)); }} /></label>
      <button className="btn primary" disabled={!profileId || active} onClick={start}>开始监控</button>
      <button className="btn" disabled={!active} onClick={stop}>停止</button>
    </div>
    <div className="monitor-status" role="status"><span className={`monitor-dot ${status.phase}`} />{phases[status.phase] ?? status.phase}
      {sample && <span>最后采样 {new Date(sample.sampledAt).toLocaleTimeString("zh-CN", { hour12: false })} · 最近 {samples.length} 次</span>}
      <span className="monitor-local">数据仅留本机</span>
    </div>
    <p className="muted">独立 SSH 连接采集 Linux /proc 与 df，无需 root，不执行档案启动命令。停止、切换主机或关闭窗口会断开监控连接。</p>
    {!profiles.length && !error && <p className="muted">暂无 SSH 档案，请先在主窗口添加或导入服务器。</p>}
    {status.phase === "auth" && <form className="monitor-auth" onSubmit={event => {
      event.preventDefault(); if (!secret || authBusy) return;
      setAuthBusy(true); setError("");
      void controller.authenticate(secret).then(() => setSecret("")).catch(error => setError(String(error))).finally(() => setAuthBusy(false));
    }}><label htmlFor="monitor-auth">SSH 登录认证</label><p className="muted">SSH 正在请求密码、私钥口令或验证码，仅提交给本次监控连接，不保存。</p>
      <div className="input-row"><input id="monitor-auth" aria-label="监控 SSH 认证" type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} disabled={authBusy} autoFocus /><button className="btn primary" disabled={!secret || authBusy}>{authBusy ? "正在提交…" : "继续连接"}</button></div>
    </form>}
    {(error || status.error) && <div className="monitor-error" role="alert"><p>{error || status.error}</p><p>可在原终端手动检查：<code>top</code> · <code>free -h</code> · <code>df -h</code> · <code>cat /proc/net/dev</code></p></div>}
    <div className="monitor-cards">
      <section className="monitor-card"><header><h2>CPU</h2><strong>{pct(sample?.cpuPct)}</strong></header><Chart title="CPU" percentage series={[samples.map(row => row.cpuPct)]} /><p>{sample?.load ? `平均负载 ${sample.load.one.toFixed(2)} / ${sample.load.five.toFixed(2)} / ${sample.load.fifteen.toFixed(2)}` : "连续两次采样后显示 CPU 使用率"}</p></section>
      <section className="monitor-card"><header><h2>内存</h2><strong>{pct(sample?.memoryPct)}</strong></header><Chart title="内存" percentage series={[samples.map(row => row.memoryPct)]} /><p>{sample ? `${bytes(sample.memoryUsed)} / ${bytes(sample.memoryTotal)} · 已用按总量减可用估算` : "等待内存采样"}</p></section>
      <section className="monitor-card"><header><h2>磁盘</h2><strong>{pct(disk?.capacity_pct)}</strong></header><Chart title="磁盘" percentage series={[samples.map(row => diskPeak(row)?.capacity_pct ?? null)]} /><p>{disk ? `最高使用率：${disk.mountpoint} · ${bytes(disk.used_bytes)} / ${bytes(disk.total_bytes)}` : "等待磁盘采样"}</p></section>
      <section className="monitor-card"><header><h2>网络</h2><strong>{total ? `${bytes(total.rx)}/s` : "采样中…"}</strong></header><Chart title="网络" series={[samples.map(row => networkTotal(row, network)?.rx ?? null), samples.map(row => networkTotal(row, network)?.tx ?? null)]} />
        <p><span className="monitor-rx">↓ 接收 {total ? `${bytes(total.rx)}/s` : "—"}</span> <span className="monitor-tx">↑ 发送 {total ? `${bytes(total.tx)}/s` : "—"}</span></p>
        <Dropdown ariaLabel="监控网卡" value={network} options={[{ value: "", label: "全部网卡（不含 lo）" }, ...(sample?.network ?? []).map(row => ({ value: row.name, label: row.name }))]} onChange={setNetwork} />
      </section>
    </div>
    {sample && <section className="monitor-disks"><h2>文件系统 <small>运行 {Math.floor(sample.uptimeSeconds / 86400)} 天 {Math.floor(sample.uptimeSeconds % 86400 / 3600)} 小时</small></h2><table><thead><tr><th>挂载点</th><th>文件系统</th><th>已用 / 总量</th><th>使用率</th></tr></thead><tbody>{sample.disks.map((row, index) => <tr key={`${row.filesystem}-${row.mountpoint}-${index}`}><td>{row.mountpoint}</td><td>{row.filesystem}</td><td>{bytes(row.used_bytes)} / {bytes(row.total_bytes)}</td><td>{row.capacity_pct}%</td></tr>)}</tbody></table></section>}
  </div>;
}
