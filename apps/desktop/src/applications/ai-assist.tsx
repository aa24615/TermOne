import { useState } from "react";
import type { Host } from "../plugin/types";
export default function AiAssist({ host }: { host: Host }) {
  const [endpoint, setEndpoint] = useState(
    "https://api.openai.com/v1/chat/completions",
  );
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ask = async () => {
    if (!key.trim() || !model.trim() || !question.trim()) return;
    if (
      !(await host.confirm(
        "将仅向 " +
          new URL(endpoint).origin +
          " 发送你在问题框中填写的内容。是否发送？",
      ))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const response = await host.fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + key,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "Assist with shell commands. Explain commands and risks. Do not claim to execute commands.",
            },
            { role: "user", content: question },
          ],
        }),
      });
      if (!response.ok) throw new Error("服务返回 HTTP " + response.status);
      const json = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content)
        throw new Error(
          json.error?.message ??
            "服务未返回文字结果（需要兼容 Chat Completions 的 API）",
        );
      setAnswer(content);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="plugin-stack">
      <p className="muted">
        API Key
        仅保留在当前应用内存，关闭窗口即清除。不会自动读取终端内容，也不会执行生成的命令。新增服务域名请在应用管理中明确授权。
      </p>
      <label>
        API 地址
        <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
      </label>
      <label>
        模型
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="填写服务提供的模型 ID"
        />
      </label>
      <label>
        API Key
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <label>
        问题 / 待解释内容
        <textarea
          rows={7}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </label>
      <button
        className="btn primary"
        disabled={busy || !key.trim() || !model.trim() || !question.trim()}
        onClick={() => {
          void ask().catch((e) => setError(String(e)));
        }}
      >
        {busy ? "请求中…" : "确认后发送"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <pre className="plugin-log">{answer}</pre>
      {answer && (
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard
              .writeText(answer)
              .catch((e) => setError(String(e)));
          }}
        >
          复制结果
        </button>
      )}
    </div>
  );
}
