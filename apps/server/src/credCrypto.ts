import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { dataDir } from "./db";

/**
 * Web SSH 凭据的静态加密（AES-256-GCM）。
 *
 * 说明：桌面端的隐私承诺是「密钥永不上传」——那是针对**桌面端**的。
 * Web 版 SSH 必须由服务端发起 SSH 连接，因此若用户选择「保存凭据」，
 * 服务端会加密落盘。本模块保证：
 *   - 静态加密：每条记录独立随机 IV，带 GCM 认证标签；
 *   - 主密钥与数据分离：密钥存 `dataDir/cred.key`（0600），不在数据库里；
 *   - 明文只在内存中存在，且仅用于建立 SSH 连接，连接结束即丢弃；
 *   - 对外 API **永不返回明文**（见 sshHosts.ts）。
 */

const KDF_SALT = "termone-ssh-credential-v1";
const KEY_LEN = 32;
const IV_LEN = 12;

let cachedKey: Buffer | null = null;

function loadOrCreateMasterSecret(): string {
  const file = path.join(dataDir, "cred.key");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // 首次启动
  }
  const secret = randomBytes(48).toString("hex");
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  return secret;
}

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = scryptSync(loadOrCreateMasterSecret(), KDF_SALT, KEY_LEN);
  return cachedKey;
}

/** 加密为 `v1.<iv>.<tag>.<ct>`（全部 base64）。 */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(".");
}

/** 解密；格式错误或认证失败时抛异常（绝不回退为明文）。 */
export function decryptSecret(payload: string): string {
  const parts = String(payload ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("凭据格式无效");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf8");
}

export function newHostId(): string {
  return randomUUID();
}
