export function activate({ host }) {
  let message = "你好，TermOne";
  host.ui.render({
    type: "column",
    children: [
      { type: "text", text: "本插件运行在隔离 Worker 中，不能直接读取宿主 DOM、存储或访问网络。" },
      { type: "input", label: "消息", value: message, onChange: value => { message = value; } },
      { type: "button", text: "显示通知", onClick: () => host.toast(message) },
    ],
  });
}
