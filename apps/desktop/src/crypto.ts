// 客户端端到端加密（R-05）：同步数据在本地加密后仅以密文上传服务端，
// 服务端零知识（只存密文、不提供检索）。密钥由用户口令经 PBKDF2 派生，
// 每次加密使用随机 salt + 随机 nonce，密文格式：enc::base64(salt[16]|nonce[12]|ct)。

const ENC_PREFIX = "enc::";
const PBKDF2_ITER = 120_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    enc.encode(pass),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITER, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function isEncrypted(payload: string): boolean {
  return payload.startsWith(ENC_PREFIX);
}

export async function encryptData(plain: string, pass: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, enc.encode(plain)),
  );
  const blob = new Uint8Array(16 + 12 + ct.length);
  blob.set(salt, 0);
  blob.set(nonce, 16);
  blob.set(ct, 28);
  return ENC_PREFIX + toB64(blob);
}

export async function decryptData(payload: string, pass: string): Promise<string> {
  if (!payload.startsWith(ENC_PREFIX)) return payload;
  const blob = fromB64(payload.slice(ENC_PREFIX.length));
  const salt = blob.slice(0, 16);
  const nonce = blob.slice(16, 28);
  const ct = blob.slice(28);
  const key = await deriveKey(pass, salt);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    key,
    ct as BufferSource,
  );
  return dec.decode(pt);
}
