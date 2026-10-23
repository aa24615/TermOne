/**
 * 本机浏览器凭据缓存。
 *
 * **与「服务端保存」的区别**：这里的数据**永远不上传**，只写在本机 localStorage，
 * 服务端完全不知情。用于「记住密码，但绝不交给服务器」的场景。
 *
 * 注意：localStorage 中的内容是明文（浏览器没有安全的跨会话密钥库），
 * 仅适合个人可信设备；换设备 / 清除浏览器数据即失效。
 */

export interface LocalCred {
  authType: "password" | "key";
  /** 密码 或 私钥 PEM */
  secret: string;
  passphrase?: string;
}

const PREFIX = "termone.web.cred.";

export function getLocalCred(hostId: string): LocalCred | null {
  try {
    const raw = localStorage.getItem(PREFIX + hostId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalCred;
    if (!parsed || (parsed.authType !== "password" && parsed.authType !== "key")) return null;
    if (typeof parsed.secret !== "string" || !parsed.secret) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function setLocalCred(hostId: string, cred: LocalCred): void {
  try {
    localStorage.setItem(PREFIX + hostId, JSON.stringify(cred));
  } catch {
    /* 隐私模式下可能写入失败，忽略 */
  }
}

export function clearLocalCred(hostId: string): void {
  try {
    localStorage.removeItem(PREFIX + hostId);
  } catch {
    /* ignore */
  }
}

/** 清除本机记住的全部凭据（退出登录或用户主动清空时调用）。 */
export function clearAllLocalCreds(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/** 把本机凭据展开成 WebSocket connect 帧的字段（临时凭据，服务端不落盘）。 */
export function credToConnect(cred: LocalCred): Record<string, unknown> {
  const out: Record<string, unknown> = { authType: cred.authType };
  if (cred.authType === "key") {
    out.privateKey = cred.secret;
    if (cred.passphrase) out.passphrase = cred.passphrase;
  } else {
    out.password = cred.secret;
  }
  return out;
}
