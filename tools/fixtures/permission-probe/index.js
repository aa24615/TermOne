export async function activate({ host }) {
  const lines = [];
  lines.push("DOM: " + (typeof document === "undefined" ? "隔离通过" : "失败"));
  lines.push(
    "Tauri: " +
      (typeof globalThis.__TAURI_INTERNALS__ === "undefined"
        ? "隔离通过"
        : "失败"),
  );
  try {
    await host.invoke("secret_get", {});
    lines.push("密钥环: 失败");
  } catch {
    lines.push("密钥环: 已拒绝");
  }
  try {
    await host.storage.get("private");
    lines.push("私有存储: 失败");
  } catch {
    lines.push("未声明存储: 已拒绝");
  }
  try {
    await host.fetch("https://blocked.example.invalid/");
    lines.push("域名白名单: 失败");
  } catch {
    lines.push("域名白名单: 已拒绝");
  }
  try {
    await fetch("https://blocked.example.invalid/");
    lines.push("直接网络: 失败");
  } catch {
    lines.push("直接网络: 已拒绝");
  }
  try {
    await host.invoke("local_list", { path: "/" });
    lines.push("未授权文件系统: 失败");
  } catch {
    lines.push("未授权文件系统: 已拒绝");
  }
  host.ui.render({
    type: "column",
    children: [
      { type: "pre", text: lines.join("\n") },
      {
        type: "button",
        text: "选择测试目录并验证授权",
        onClick: async () => {
          const path = await host.openDialog(true);
          if (path) {
            const rows = await host.invoke("local_list", { path });
            host.toast("授权目录读取成功，共 " + rows.length + " 项");
          }
        },
      },
      {
        type: "button",
        text: "模拟插件异常",
        onClick: () => {
          throw new Error("fixture crash");
        },
      },
    ],
  });
}
