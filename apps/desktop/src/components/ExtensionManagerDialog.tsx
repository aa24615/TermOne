import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import catalog from "../plugin/catalog.json";
import {
  bytesB64,
  download,
  readPackage,
  verifyDigest,
} from "../plugin/package";
import {
  openPlugin,
  refreshPlugins,
  stopPlugin,
  togglePlugin,
  uninstallPlugin,
  usePlugins,
} from "../plugin/runtime";
import { installedKind, kindOf, kindName } from "../plugin/kinds";
import type { ExtensionKind, Installed, Manifest } from "../plugin/types";
import { useStore } from "../store";
import { confirm, Modal } from "./Dialog";
import "../plugin/ui.css";
import { describePermission } from "../plugin/permissions";
import { useRegistry } from "../plugin/registry";
import { PluginBoundary, ContributionView } from "../plugin/PluginSurface";

import { ApplicationTile } from "./ApplicationTile";

interface MarketEntry {
  kind?: ExtensionKind;
  id: string;
  name: string;
  version: string;
  url: string;
  sha256: string;
}
interface Audit {
  at: number;
  pluginId: string;
  action: string;
  allowed: boolean;
}
export default function ExtensionManagerDialog({
  kind = "plugin",
}: {
  kind?: ExtensionKind;
}) {
  const allInstalled = usePlugins((s) => s.installed);
  const installed = allInstalled.filter((p) => installedKind(p) === kind);
  const noun = kindName(kind);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [registry, setRegistry] = useState(
    localStorage.getItem("termone.registry") ?? "",
  );
  const [market, setMarket] = useState<MarketEntry[]>([]);
  const [error, setError] = useState("");
  const contributions = useRegistry((s) => s.items);
  const [domain, setDomain] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refreshPlugins();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refreshPlugins().catch((e) => setError(String(e)));
  }, []);
  const approve = (m: Manifest) =>
    confirm({
      title: "安装" + kindName(kindOf(m)) + " · " + m.name,
      message:
        "请确认来源可信并核对权限（应用在独立窗口运行，插件附加到主窗口）：\n\n" +
        m.permissions.map(describePermission).join("\n") +
        (kindOf(m) === "app" ? "\n\n安装后点击应用图标即可使用。" : "\n\n安装及更新后默认关闭，需要手动启用。"),
    });
  const local = async (directory: boolean, dev = false) => {
    const p = await open({
      directory,
      multiple: false,
      filters: directory
        ? undefined
        : [{ name: "TermOne 扩展", extensions: ["tpk"] }],
    });
    if (typeof p !== "string") return;
    const pkg = readPackage(await invoke("plugin_read_package", { path: p }));
    if (kindOf(pkg.manifest) !== kind)
      throw new Error(
        "此包为" + kindName(kindOf(pkg.manifest)) + "，请在对应管理页导入",
      );
    if (!(await approve(pkg.manifest))) return;
    stopPlugin(pkg.manifest.id);
    await invoke("plugin_install", {
      ...pkg,
      source: dev ? "dev" : "local",
      devPath: dev ? p : null,
    });
  };
  const fromMarket = async (entry: MarketEntry) => {
    const bytes = await download(entry.url);
    await verifyDigest(bytes, entry.sha256);
    const pkg = readPackage({ archive: bytesB64(bytes) });
    if (
      pkg.manifest.id !== entry.id ||
      pkg.manifest.version !== entry.version ||
      kindOf(pkg.manifest) !== (entry.kind ?? "plugin")
    )
      throw new Error("仓库与包内清单不一致");
    if (!(await approve(pkg.manifest))) return;
    stopPlugin(pkg.manifest.id);
    await invoke("plugin_install", { ...pkg, source: "market", devPath: null });
  };
  const installBuiltin = async (m: Manifest) => {
    if (!(await approve(m))) return;
    stopPlugin(m.id);
    await invoke("plugin_install", {
      manifest: m,
      files: {},
      source: "builtin",
      devPath: null,
    });
  };
  const openApplication = (id: string) => {
    useStore.getState().setDialog(null);
    void openPlugin(id);
  };
  const remove = (p: Installed) => run(async () => {
    if (await confirm({ title: "卸载" + noun, message: "将清除 " + p.manifest.name + " 的私有数据，确认卸载？" }))
      await uninstallPlugin(p.id);
  });
  const actions = (
    p?: Installed,
    install?: () => Promise<void>,
    installLabel = "已安装",
    current = false,
  ) => (
    <div className="plugin-actions plugin-row-actions">
      <button
        className="btn"
        disabled={busy || !install || current}
        onClick={() => install && void run(install)}
      >
        {installLabel}
      </button>
      <button
        className="btn"
        disabled={busy || !p}
        title={!p ? "请先安装" + noun : undefined}
        onClick={() => p && void run(() => togglePlugin(p))}
      >
        {p?.enabled ? "停用" : "启用"}
      </button>
      {p?.enabled && (
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            useStore.getState().setDialog(null);
            void openPlugin(p.id);
          }}
        >
          {kind === "app" ? "打开应用" : "打开"}
        </button>
      )}
      {p && (
        <button
          className="btn danger"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (
                await confirm({
                  title: "卸载" + noun,
                  message:
                    "将清除 " + p.manifest.name + " 的私有数据，确认卸载？",
                })
              )
                await uninstallPlugin(p.id);
            })
          }
        >
          卸载
        </button>
      )}
    </div>
  );
  const rows = [
    ...catalog
      .filter((m) => kindOf(m) === kind)
      .map((m) => ({
        manifest: m as Manifest,
        existing: installed.find((p) => p.id === m.id),
        official: true,
      })),
    ...installed
      .filter((p) => !catalog.some((m) => m.id === p.id && kindOf(m) === kind))
      .map((p) => ({ manifest: p.manifest, existing: p, official: false })),
  ];
  return (
    <Modal
      title={noun + "管理"}
      onClose={() => useStore.getState().setDialog(null)}
      width={880}
    >
      <div className="extension-tabs" role="tablist" aria-label="扩展类型">
        {(["plugin", "app"] as const).map((type) => (
          <button
            key={type}
            className={`btn${kind === type ? " selected" : ""}`}
            role="tab"
            aria-selected={kind === type}
            onClick={() =>
              useStore
                .getState()
                .setDialog({
                  type: type === "app" ? "applications" : "plugins",
                })
            }
          >
            {kindName(type)}
          </button>
        ))}
      </div>
      <p className="muted">
        {kind === "app"
          ? "安装后点击图标即可使用，应用在独立窗口打开。关闭应用不会影响主窗口终端。"
          : "插件附加到主窗口，用于增强当前终端、会话和主窗口能力。"}
        {kind === "app" ? "安装时确认权限。" : "按需安装、默认停用，权限需明确授权。"}
      </p>
      <div className="plugin-actions">
        <button
          className="btn"
          disabled={busy}
          onClick={() => void run(() => local(false))}
        >
          导入 .tpk
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => void run(() => local(true))}
        >
          导入目录
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => void run(() => local(true, true))}
        >
          开发者模式
        </button>
        <button
          className="btn"
          onClick={() =>
            void run(async () => setAudit(await invoke("plugin_audit")))
          }
        >
          查看权限审计
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <h3 className="plugin-list-heading">
        {noun}列表{" "}
        <small>
          已安装 {installed.length}
          {kind === "plugin" && <> · 已启用 {installed.filter((p) => p.enabled).length}</>}
        </small>
      </h3>
      <div className={kind === "app" ? "application-grid" : "plugin-list"}>
        {rows.map(({ manifest: m, existing: p, official }) => {
          const shown = p?.manifest ?? m;
          const current =
            p?.source === "builtin" && p.manifest.version === m.version;
          if (kind === "app") return (
            <ApplicationTile
              key={m.id} id={m.id} name={shown.name} description={shown.description}
              version={shown.version} permissions={shown.permissions}
              source={p ? (p.source === "builtin" ? "随包官方版" : p.source) : "官方应用"}
              installed={!!p} busy={busy}
              onOpen={() => openApplication(m.id)}
              onInstall={official ? () => void run(() => installBuiltin(m)) : undefined}
              onUpdate={official && !!p && !current ? () => void run(() => installBuiltin(m)) : undefined}
              onUninstall={p ? () => void remove(p) : undefined}
            />
          );
          return (
            <section
              className="plugin-card plugin-list-row"
              key={m.id}
              aria-label={shown.name}
            >
              <div className="plugin-list-info">
                <div className="plugin-list-title">
                  <strong>{shown.name}</strong>
                  <small>
                    {shown.version} ·{" "}
                    {p
                      ? p.source === "builtin"
                        ? "随包官方版"
                        : p.source
                      : "官方" + noun}
                  </small>
                  <span
                    className={`plugin-state${p?.enabled ? " enabled" : ""}`}
                  >
                    {p ? (p.enabled ? "已启用" : "未启用") : "未安装"}
                  </span>
                </div>
                <p title={shown.description}>{shown.description}</p>
                <details>
                  <summary>权限</summary>
                  <pre>
                    {shown.permissions
                      .map((permission) => describePermission(permission))
                      .join("\n")}
                  </pre>
                </details>
              </div>
              {actions(
                p,
                official ? () => installBuiltin(m) : undefined,
                official
                  ? !p
                    ? "安装"
                    : current
                      ? "已安装"
                      : "更新官方版"
                  : "已安装",
                current,
              )}
            </section>
          );
        })}
      </div>
      {Object.values(contributions).some(
        (item) =>
          item.kind === "setting" &&
          installed.some((p) => p.id === item.pluginId),
      ) && <h3>{noun}设置</h3>}
      {Object.entries(contributions)
        .filter(
          ([, item]) =>
            item.kind === "setting" &&
            installed.some((p) => p.id === item.pluginId),
        )
        .map(([key, item]) => (
          <PluginBoundary key={key} stop={() => stopPlugin(item.pluginId)}>
            <h4>{item.title}</h4>
            <ContributionView render={item.render} />
          </PluginBoundary>
        ))}
      <details>
        <summary>为已安装扩展添加联网域名</summary>
        <p>只填写准确域名，不含协议和路径。{kind === "app" ? "授权后关闭已有窗口，再点击应用图标打开。" : "添加后插件会停用，需要重新启用。"}</p>
        <input
          placeholder="api.example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value.trim().toLowerCase())}
        />
        {installed.map((p) => (
          <button
            className="btn"
            key={p.id}
            disabled={busy || !domain}
            onClick={() =>
              void run(async () => {
                if (
                  !(await confirm({
                    title: "新增网络权限",
                    message:
                      p.manifest.name +
                      " 将被允许向 https://" +
                      domain +
                      " 发送数据。是否授权？",
                  }))
                )
                  return;
                stopPlugin(p.id);
                await invoke("plugin_add_domain", { id: p.id, domain });
              })
            }
          >
            授权给 {p.manifest.name}
          </button>
        ))}
      </details>
      <h3>自托管{noun}仓库</h3>
      <p className="muted">
        仓库索引包含
        id、name、version、kind、url、sha256；下载后核验摘要、类型并确认权限。第三方扩展均在隔离环境运行。
      </p>
      <div className="plugin-actions">
        <input
          value={registry}
          placeholder="https://plugins.example.com/index.json"
          onChange={(e) => setRegistry(e.target.value)}
        />
        <button
          className="btn"
          disabled={busy || !registry}
          onClick={() =>
            void run(async () => {
              const bytes = await download(registry);
              const index: unknown = JSON.parse(
                new TextDecoder().decode(bytes),
              );
              if (!Array.isArray(index) || index.length > 200)
                throw new Error("仓库索引格式无效");
              if (
                index.some(
                  (entry) =>
                    !entry ||
                    typeof entry !== "object" ||
                    ["id", "name", "version", "url", "sha256"].some(
                      (key) =>
                        typeof entry[key] !== "string" ||
                        entry[key].length > 2000,
                    ) ||
                    !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
                    !/^\d+\.\d+\.\d+$/.test(entry.version) ||
                    (entry.kind !== undefined &&
                      !["plugin", "app"].includes(entry.kind)),
                )
              )
                throw new Error("仓库条目无效");
              setMarket(index as MarketEntry[]);
              localStorage.setItem("termone.registry", registry);
            })
          }
        >
          检查更新
        </button>
      </div>
      <div className={kind === "app" ? "application-grid" : "plugin-list"}>
      {market
        .filter((entry) => (entry.kind ?? "plugin") === kind)
        .map((entry) => {
          const p = installed.find((p) => p.id === entry.id);
          if (kind === "app") return (
            <ApplicationTile key={entry.id} id={entry.id} name={entry.name} version={entry.version}
              source="自托管仓库" installed={!!p} busy={busy}
              onOpen={() => openApplication(entry.id)}
              onInstall={() => void run(() => fromMarket(entry))}
              onUpdate={p ? () => void run(() => fromMarket(entry)) : undefined}
              onUninstall={p ? () => void remove(p) : undefined}
            />
          );
          return (
            <section
              className="plugin-card plugin-list-row"
              key={entry.id}
              aria-label={entry.name}
            >
              <div className="plugin-list-info">
                <div className="plugin-list-title">
                  <strong>{entry.name}</strong>
                  <small>{entry.version}</small>
                </div>
              </div>
              {actions(p, () => fromMarket(entry), p ? "更新 / 重装" : "安装")}
            </section>
          );
        })}
      </div>
      {audit.length > 0 && (
        <>
          <h3>最近权限调用</h3>
          <div className="plugin-audit">
            {audit.map((a, i) => (
              <div key={i}>
                {new Date(a.at).toLocaleString()} · {a.pluginId} · {a.action} ·{" "}
                {a.allowed ? "允许" : "拒绝"}
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
