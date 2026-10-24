import { unzipSync } from "fflate";
import { fromB64 } from "../ipc";
import { safePath, validateManifest } from "./permissions";
import type { Manifest } from "./types";
export function bytesB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function readPackage(input: {
  files?: Record<string, string>;
  archive?: string;
}): { manifest: Manifest; files: Record<string, string> } {
  let files = input.files;
  if (input.archive) {
    const bytes = fromB64(input.archive);
    if (bytes.length > 4 * 1024 * 1024) throw new Error("压缩包超过 4 MiB");
    let expanded = 0;
    let count = 0;
    const names = new Set<string>();
    const zip = unzipSync(bytes, {
      filter: (e) => {
        if (!safePath(e.name.replace(/\/$/, "")))
          throw new Error("压缩包含不安全路径");
        if (names.has(e.name)) throw new Error("压缩包含重复路径");
        names.add(e.name);
        if (e.name.endsWith("/")) return false;
        expanded += e.originalSize;
        if (expanded > 16 * 1024 * 1024 || ++count > 256)
          throw new Error("插件文件过大或过多");
        return true;
      },
    });
    files = Object.fromEntries(
      Object.entries(zip).map(([name, bytes]) => [name, bytesB64(bytes)]),
    );
  }
  if (
    !files ||
    !files["termone.plugin.json"] ||
    Object.keys(files).length > 256
  )
    throw new Error("缺少 termone.plugin.json 或文件过多");
  let total = 0;
  for (const [name, value] of Object.entries(files)) {
    if (!safePath(name)) throw new Error("不安全的文件路径");
    total += fromB64(value).length;
  }
  if (total > 16 * 1024 * 1024) throw new Error("解压后超过 16 MiB");
  const manifest = validateManifest(
    JSON.parse(new TextDecoder().decode(fromB64(files["termone.plugin.json"]))),
  );
  if (
    manifest.files.some((f) => !Object.hasOwn(files, f)) ||
    !Object.hasOwn(files, manifest.entry)
  )
    throw new Error("插件缺少声明文件");
  return { manifest, files };
}
export async function download(url: string): Promise<Uint8Array> {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password)
    throw new Error("仓库和下载地址必须使用 HTTPS");
  const res = await fetch(u, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok || !res.body) throw new Error("下载失败: " + res.status);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 4 * 1024 * 1024) throw new Error("下载超过 4 MiB");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
export async function verifyDigest(bytes: Uint8Array, sha256: string) {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("仓库缺少有效 SHA-256");
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as BufferSource),
  );
  if (
    Array.from(hash, (x) => x.toString(16).padStart(2, "0")).join("") !==
    sha256.toLowerCase()
  )
    throw new Error("插件摘要不匹配，已拒绝安装");
}
