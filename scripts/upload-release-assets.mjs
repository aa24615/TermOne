#!/usr/bin/env node
/**
 * 上传本机构建产物到 CNB Release 附件（自托管 Win/Mac 构建机用）。
 *
 * 用法:
 *   node scripts/upload-release-assets.mjs <目录或文件>...
 *   例: node scripts/upload-release-assets.mjs apps/desktop/src-tauri/target/release/bundle
 *
 * 自动递归收集以下扩展名的文件: .exe .msi .dmg .app.tar.gz .zip
 *
 * 环境变量（流水线内自动注入）:
 *   CNB_TOKEN                 访问令牌
 *   CNB_REPO_SLUG_LOWERCASE   仓库路径（org/repo）
 *   RELEASE_TAG               Release 标签名（如 v0.1.0）；缺省回退到 CNB_BRANCH
 *   CNB_BRANCH                当前分支/标签名
 *   CNB_API                   API 地址，默认 https://api.cnb.cool
 *
 * 行为: Release 不存在时自动创建（等待对应的 git 标签出现），随后上传附件。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const API = (process.env.CNB_API ?? "https://api.cnb.cool").replace(/\/+$/, "");
const TOKEN = process.env.CNB_TOKEN;
const REPO = process.env.CNB_REPO_SLUG_LOWERCASE;
const TAG = process.env.RELEASE_TAG || process.env.CNB_BRANCH;
const ASSET_EXTS = [".exe", ".msi", ".dmg", ".app.tar.gz", ".zip", ".deb", ".rpm", ".appimage"];
const RELEASE_WAIT_MS = 15_000;
const RELEASE_WAIT_MAX = 40;

function fail(msg) {
  console.error(`[upload] ${msg}`);
  process.exit(1);
}

if (!TOKEN) fail("缺少 CNB_TOKEN 环境变量");
if (!REPO) fail("缺少 CNB_REPO_SLUG_LOWERCASE 环境变量");
if (!TAG) fail("缺少 RELEASE_TAG（或 CNB_BRANCH）环境变量");

function isAsset(name) {
  const lower = name.toLowerCase();
  return ASSET_EXTS.some((ext) => lower.endsWith(ext));
}

function collect(input, out = []) {
  const abs = resolve(input);
  const stat = statSync(abs);
  if (stat.isFile()) return isAsset(basename(abs)) ? [...out, abs] : out;
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (isAsset(entry)) out.push(full);
  }
  return out;
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/vnd.cnb.api+json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${body}`);
  }
  return res.json().catch(() => ({}));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 获取或创建 Release（与镜像/打包流水线并行执行，需容忍时序）:
 * 1) 按 tag 查询 Release；2) 不存在则创建（git 标签可能尚未推送，失败则稍后重试）。
 */
async function ensureRelease() {
  const tagPath = `/${REPO}/-/releases/tags/${encodeURIComponent(TAG)}`;
  for (let attempt = 1; attempt <= RELEASE_WAIT_MAX; attempt++) {
    try {
      const rel = await api(tagPath);
      if (rel && rel.id) return rel.id;
    } catch {
      // 尚未创建
    }
    try {
      const created = await api(`/${REPO}/-/releases`, {
        method: "POST",
        body: JSON.stringify({
          tag_name: TAG,
          name: `TermOne ${TAG}`,
          body: `TermOne ${TAG} 发布。`,
          make_latest: "true",
        }),
      });
      if (created && created.id) return created.id;
    } catch {
      // 标签尚未推送，或已被并行流水线创建
    }
    console.log(`[upload] Release 未就绪，${RELEASE_WAIT_MS / 1000}s 后重试 (${attempt}/${RELEASE_WAIT_MAX})`);
    await sleep(RELEASE_WAIT_MS);
  }
  fail("等待/创建 Release 超时，请确认流水线已创建对应标签");
}

async function uploadAsset(releaseId, file) {
  const name = basename(file);
  const size = statSync(file).size;
  const { upload_url: uploadUrl, verify_url: verifyUrl } = await api(
    `/${REPO}/-/releases/${releaseId}/asset-upload-url`,
    { method: "POST", body: JSON.stringify({ asset_name: name, size, overwrite: true }) },
  );
  if (!uploadUrl || !verifyUrl) throw new Error("接口未返回 upload_url/verify_url");
  const putRes = await fetch(uploadUrl, { method: "PUT", body: readFileSync(file) });
  if (!putRes.ok) throw new Error(`上传失败: HTTP ${putRes.status}`);
  const confirmRes = await fetch(verifyUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!confirmRes.ok) throw new Error(`确认失败: HTTP ${confirmRes.status}`);
  console.log(`[upload] ✓ ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  fail("用法: node scripts/upload-release-assets.mjs <目录或文件>...");
}

const files = [...new Set(inputs.flatMap((i) => collect(i)))];
if (files.length === 0) {
  fail("未找到可上传的产物（支持 .exe/.msi/.dmg/.app.tar.gz/.zip）");
}

console.log(`[upload] 目标: ${REPO} @ ${TAG}，共 ${files.length} 个文件`);
const releaseId = await ensureRelease();
for (const file of files) {
  try {
    await uploadAsset(releaseId, file);
  } catch (e) {
    fail(`上传 ${basename(file)} 失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}
console.log("[upload] 全部完成");
