import { useEffect, useState } from "react";
import type { Host } from "../plugin/types";
import type { SftpEntry, LocalEntry } from "../types";
import { promptText } from "../components/Dialog";
import { joinPath, report } from "../plugin/shared";
interface Task {
  id: string;
  command: "sftp_download" | "sftp_upload";
  args: Record<string, unknown>;
  name: string;
  state: string;
  error?: string;
}
export default function Sftp({ host }: { host: Host }) {
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([]);
  const [profileId, setProfile] = useState("");
  const [remote, setRemote] = useState("");
  const [local, setLocal] = useState("");
  const [path, setPath] = useState("");
  const [remoteRows, setRemoteRows] = useState<SftpEntry[]>([]);
  const [localRows, setLocalRows] = useState<LocalEntry[]>([]);
  const [selection, setSelection] = useState<{
    side: "remote" | "local";
    name: string;
    isDir: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    report(host, async () => {
      setProfiles(await host.invoke("profile_refs"));
      const config = await host.storage.get<{
        profileId: string;
        local: string;
      }>("location");
      if (config) {
        setProfile(config.profileId);
        setLocal(config.local);
      }
    });
  }, [host]);
  const refresh = async (remotePath = remote) => {
    setBusy(true);
    setError("");
    try {
      if (profileId) {
        setRemoteRows(
          await host.invoke("sftp_list", { profileId, path: remotePath }),
        );
        setRemote(remotePath);
        setPath(remotePath);
      }
      if (local) setLocalRows(await host.invoke("local_list", { path: local }));
      await host.storage.set("location", { profileId, local });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [profileId, local]);
  const transfer = async (task: Task) => {
    setTasks((rows) =>
      rows.map((t) =>
        t.id === task.id ? { ...t, state: "进行中", error: "" } : t,
      ),
    );
    try {
      await host.invoke(task.command, task.args);
      if (!host.signal.aborted) {
        setTasks((rows) =>
          rows.map((t) => (t.id === task.id ? { ...t, state: "完成" } : t)),
        );
        await refresh();
      }
    } catch (e) {
      if (!host.signal.aborted)
        setTasks((rows) =>
          rows.map((t) =>
            t.id === task.id ? { ...t, state: "已暂停", error: String(e) } : t,
          ),
        );
    }
  };
  const add = (side: "remote" | "local", name: string) => {
    if (!local || !profileId) {
      host.toast("请先选择 SSH 档案与本地目录", true);
      return;
    }
    const task: Task = {
      id: crypto.randomUUID(),
      command: side === "remote" ? "sftp_download" : "sftp_upload",
      name,
      state: "进行中",
      args: {
        profileId,
        remote: joinPath(remote, name).replace(/\\/g, "/"),
        local: joinPath(local, name),
      },
    };
    setTasks((rows) => [task, ...rows].slice(0, 100));
    void transfer(task);
  };
  const mutate = async (command: string, args: Record<string, unknown>) => {
    await host.invoke(command, { profileId, ...args });
    setSelection(null);
    await refresh();
  };
  return (
    <div className="plugin-stack">
      <label>
        SSH 档案
        <select
          value={profileId}
          onChange={(e) => {
            setProfile(e.target.value);
            setRemote("");
            setRemoteRows([]);
            setSelection(null);
          }}
        >
          <option value="">请选择</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        使用系统 ssh-agent
        或密钥；口令不会提供给应用。将列表中的文件拖到另一侧即可传输。
      </p>
      <div className="plugin-actions">
        <button
          className="btn"
          onClick={() =>
            report(host, async () =>
              setProfiles(await host.invoke("profile_refs")),
            )
          }
        >
          刷新档案
        </button>
        <input
          aria-label="远端路径"
          placeholder="远端路径（空为家目录）"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void refresh(path);
          }}
        />
        <button
          className="btn"
          disabled={busy || !profileId}
          onClick={() => void refresh(path)}
        >
          前往 / 刷新
        </button>
        <button
          className="btn"
          onClick={() =>
            report(host, async () => {
              const p = await host.openDialog(true);
              if (p) setLocal(p);
            })
          }
        >
          选择本地目录
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="file-columns">
        {(["remote", "local"] as const).map((side) => (
          <section
            key={side}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const data = e.dataTransfer.getData("application/x-termone-file");
              if (data) {
                const file = JSON.parse(data) as {
                  side: "remote" | "local";
                  name: string;
                };
                if (file.side !== side) add(file.side, file.name);
              }
            }}
          >
            <h4>
              {side === "remote"
                ? "远端 · " + (remote || "~")
                : "本地 · " + (local || "未选择")}
            </h4>
            <button
              className="btn small"
              onClick={() => {
                if (side === "remote")
                  void refresh(remote.replace(/\/?[^/]+\/?$/, "") || "/");
                else setLocal(local.replace(/[\\/][^\\/]+[\\/]?$/, "") || "/");
              }}
            >
              上级目录
            </button>
            <div className="plugin-file-list">
              {(side === "remote" ? remoteRows : localRows).map((row) => (
                <button
                  className={
                    selection?.side === side && selection.name === row.name
                      ? "file-row selected"
                      : "file-row"
                  }
                  key={row.name}
                  draggable={!row.isDir}
                  onDragStart={(e) =>
                    e.dataTransfer.setData(
                      "application/x-termone-file",
                      JSON.stringify({ side, name: row.name }),
                    )
                  }
                  onClick={() =>
                    setSelection({ side, name: row.name, isDir: row.isDir })
                  }
                  onDoubleClick={() => {
                    if (row.isDir) {
                      setSelection(null);
                      if (side === "remote")
                        void refresh(joinPath(remote, row.name));
                      else setLocal(joinPath(local, row.name));
                    }
                  }}
                >
                  {row.isDir ? "📁" : "📄"} {row.name}{" "}
                  <small>{row.isDir ? "" : row.size + " B"}</small>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="plugin-actions">
        <button
          className="btn"
          disabled={!selection || selection.isDir}
          onClick={() => selection && add(selection.side, selection.name)}
        >
          {selection?.side === "local" ? "上传选中文件" : "下载选中文件"}
        </button>
        <button
          className="btn"
          disabled={!profileId}
          onClick={() =>
            report(host, async () => {
              const name = await promptText("远端新目录名");
              if (name?.trim())
                await mutate("sftp_mkdir", {
                  path: joinPath(remote, name.trim()),
                });
            })
          }
        >
          远端新建目录
        </button>
        <button
          className="btn"
          disabled={selection?.side !== "remote"}
          onClick={() =>
            report(host, async () => {
              if (!selection) return;
              const name = await promptText("重命名", selection.name);
              if (name?.trim())
                await mutate("sftp_rename", {
                  from: joinPath(remote, selection.name),
                  to: joinPath(remote, name.trim()),
                });
            })
          }
        >
          重命名
        </button>
        <button
          className="btn danger"
          disabled={selection?.side !== "remote"}
          onClick={() =>
            report(host, async () => {
              if (
                selection &&
                (await host.confirm(
                  "删除远端 " + selection.name + "？目录须为空。",
                ))
              )
                await mutate("sftp_remove", {
                  path: joinPath(remote, selection.name),
                  isDir: selection.isDir,
                });
            })
          }
        >
          删除
        </button>
      </div>
      <h4>传输队列</h4>
      {tasks.map((t) => (
        <div className="plugin-card" key={t.id}>
          {t.command === "sftp_upload" ? "↑" : "↓"} {t.name} · {t.state}
          {t.error && <p className="error">{t.error}</p>}
          {t.state === "已暂停" && (
            <button className="btn" onClick={() => void transfer(t)}>
              重试
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
