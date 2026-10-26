import { parseDocument } from "yaml";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { unzipSync } from "fflate";
import type { ProfileRow, SshProfileConfig } from "./types";
import { parseElecterm, parseIterm } from "./sshClientImport";

export const IMPORT_FORMATS = [
  ["auto", "自动识别"], ["termius", "Termius（CSV / OpenSSH）"], ["openssh", "OpenSSH / SSH Config"],
  ["xshell", "Xshell (.xsh / .xts)"], ["finalshell", "FinalShell (.json)"],
  ["securecrt", "SecureCRT (.ini / .xml)"], ["putty", "PuTTY / KiTTY (.reg)"],
  ["mobaxterm", "MobaXterm (.ini / .mxtsessions)"], ["tabby", "Tabby (.yaml)"],
  ["windterm", "WindTerm (user.sessions)"], ["mremoteng", "mRemoteNG (.xml)"],
  ["superputty", "SuperPuTTY (.xml)"], ["winscp", "WinSCP (.ini)"],
  ["remmina", "Remmina (.remmina)"], ["csv", "通用 CSV"],
  ["electerm", "electerm（书签 / 全量导出 JSON）"], ["iterm2", "iTerm2（Profile JSON / plist）"],
] as const;
export type ImportFormat = typeof IMPORT_FORMATS[number][0];
export interface ImportFile { name: string; data: Uint8Array }
export interface SshImportEntry { name: string; group: string[]; config: SshProfileConfig }
export interface ImportCandidate extends SshImportEntry { source: string; warnings: string[] }
export interface ImportPreview { entries: ImportCandidate[]; warnings: string[]; files: number }
type Obj = Record<string, any>;
const object = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const array = (v: any): any[] => v == null ? [] : Array.isArray(v) ? v : [v];
const str = (v: any): string => typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
const leaf = (p: string) => p.replace(/\\/g, "/").split("/").pop()!.replace(/\.(xsh|ini|json|remmina)$/i, "");
const pathGroup = (p: string) => p.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
const groups = (v: any): string[] => Array.isArray(v) ? v.map(str).filter(Boolean) : str(v).split(/[\\/>]/).map(s => s.trim()).filter(Boolean);
const nonSsh = (v: any) => !!str(v) && !/^(ssh|ssh2|sftp|scp)$/i.test(str(v));
const clean = (v: string) => v.length <= 1024 && !/[\x00-\x1f\x7f]/.test(v);

export function sshConnectionKey(config: Partial<SshProfileConfig>): string {
  return JSON.stringify([str(config.host).toLowerCase().replace(/^\[|\]$/g, ""), config.port || 22,
    str(config.user), str(config.proxyJump)]);
}
export function existingSshKeys(profiles: ProfileRow[]): Set<string> {
  return new Set(profiles.filter(p => p.kind === "ssh" && !p.deleted).map(p => sshConnectionKey(p.config as SshProfileConfig)));
}

export function decodeImportText(data: Uint8Array): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) return new TextDecoder("utf-16be").decode(data);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { return new TextDecoder("gb18030", { fatal: true }).decode(data); }
}

// Only read data. Never execute Match exec, ProxyCommand, scripts, or source-client hooks.
export function parseSshImport(input: ImportFile[], format: ImportFormat = "auto"): ImportPreview {
  const result: ImportPreview = { entries: [], warnings: [], files: 0 };
  const warn = (s: string) => { if (result.warnings.length < 1000) result.warnings.push(s); };
  let total = 0;
  let visited = 0;
  const add = (raw: Obj, file: string, source: string, notes: string[] = []) => {
    let host = str(raw.host), user = str(raw.user);
    if (!host) return;
    if (host.includes("@")) { const at = host.lastIndexOf("@"); user ||= host.slice(0, at); host = host.slice(at + 1); }
    let portValue = raw.port;
    const address = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(host);
    if (address) { host = address[1] || address[2]; portValue ||= address[3]; }
    host = host.replace(/^\[|\]$/g, "");
    const port = portValue === undefined || portValue === "" ? 22 : Number(portValue);
    const name = str(raw.name) || host;
    if (!clean(host) || /[\s/@*?!]/.test(host) || host.startsWith("-") || !clean(user) || /[\s@]/.test(user)
      || !clean(name) || !Number.isInteger(port) || port < 1 || port > 65535) {
      warn(`${file}：跳过无效的主机、用户名、名称或端口`); return;
    }
    const group = groups(raw.group);
    if (group.length > 16 || group.some(s => !clean(s) || s.length > 200)) { warn(`${file}：分组层级或名称无效`); return; }
    const identityFile = str(raw.identityFile);
    if (identityFile && (!clean(identityFile) || identityFile.length > 1024)) { warn(`${file}：私钥路径无效`); return; }
    const config: SshProfileConfig = { host, port, user, auth: identityFile ? "key" : raw.auth === "agent" ? "agent" : "password" };
    if (identityFile) {
      config.identityFile = identityFile;
      notes.push("仅迁移私钥路径，请确认本机文件存在；PPK 需先转换为 OpenSSH 私钥");
    }
    for (const key of ["proxyJump", "localForward", "remoteForward"] as const) {
      const value = str(raw[key]);
      if (value && !clean(value)) { warn(`${file}：跳过含无效连接参数的条目`); return; }
      if (value) config[key] = value;
    }
    if (raw.dynamicForward) {
      const port = Number(raw.dynamicForward);
      if (!Number.isInteger(port) || port < 1 || port > 65535) { warn(`${file}：动态转发端口无效`); return; }
      config.dynamicForward = port;
    }
    if (raw.password) notes.push("密码未迁移，连接时重新输入");
    if (result.entries.length >= 10000) throw new Error("一次最多导入 10000 个 SSH 连接");
    result.entries.push({ name, group, config, source: `${source} · ${file}`, warnings: [...new Set(notes)] });
  };
  const read = (file: ImportFile, depth = 0) => {
    if (++visited > 1000 || depth > 1) throw new Error("导入文件过多或包含嵌套压缩包");
    total += file.data.length;
    if (file.data.length > 16 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error("导入文件超过限制（单文件 16 MiB，合计 32 MiB）");
    if (/\.(zip|xts)$/i.test(file.name)) {
      let expanded = 0, count = 0;
      const files = unzipSync(file.data, { filter: e => {
        if (++count > 1000 || (expanded += e.originalSize) > 32 * 1024 * 1024 || e.originalSize > 16 * 1024 * 1024) throw new Error("压缩包解压后过大或文件过多");
        if (e.name.split(/[\\/]/).some(s => s === "..") || /^[\\/]/.test(e.name)) throw new Error("压缩包路径无效");
        return !e.name.endsWith("/") && /\.(xsh|ini|json|xml|yaml|yml|reg|sessions|remmina|csv|conf|config)$/i.test(e.name);
      }});
      if (!Object.keys(files).length) warn(`${file.name}：压缩包中没有支持的配置文件`);
      for (const [name, data] of Object.entries(files)) read({ name: `${file.name}/${name}`, data }, depth + 1);
      return;
    }
    const text = decodeImportText(file.data).replace(/^\uFEFF/, "");
    if (text.includes("\0")) throw new Error("文件不是支持的文本配置；加密归档请先在原软件中导出为明文配置");
    const detected = format === "auto" || format === "termius" ? detect(text, file.name) : format;
    const emit = (raw: Obj, notes: string[] = []) => add(raw, file.name, IMPORT_FORMATS.find(f => f[0] === detected)?.[1] || detected, notes);
    result.files++;
    const before = result.entries.length;
    switch (detected) {
      case "openssh": parseOpenSsh(text, emit, s => warn(`${file.name}：${s}`)); break;
      case "csv": parseCsv(text, emit); break;
      case "electerm": parseElecterm(JSON.parse(text), emit, s => warn(`${file.name}：${s}`)); break;
      case "iterm2": parseIterm(JSON.parse(text), emit, s => warn(`${file.name}：${s}`)); break;
      case "tabby": {
        const doc = parseDocument(text, { uniqueKeys: true });
        if (doc.errors.length) throw new Error("YAML 配置语法错误");
        const data = object(doc.toJS({ maxAliasCount: 50 }));
        const profiles = array(data.profiles);
        const defaults = object(object(data.profileDefaults).ssh);
        const byId = new Map(profiles.map(p => [p.id, p]));
        const groupById = new Map(array(data.groups).map(g => [g.id, g]));
        const groupPath = (id: string) => {
          const path: string[] = [], seen = new Set<string>();
          while (id) {
            if (seen.has(id)) throw new Error("Tabby 分组引用有循环");
            seen.add(id);
            const group = groupById.get(id);
            if (!group) { path.unshift(...groups(id)); break; }
            path.unshift(str(group.name)); id = group.parentGroupId;
          }
          return path;
        };
        const optionsFor = (p: Obj) => ({ ...object(defaults.options), ...object(object(object(groupById.get(p.group)?.defaults).ssh).options), ...object(p.options) });
        for (const p of profiles) {
          if (p.type !== "ssh" || p.isTemplate) continue;
          const options = optionsFor(p);
          const notes: string[] = [];
          let jump: string | undefined;
          if (options.jumpHost) {
            const chain: string[] = [], seen = new Set<string>([p.id]);
            let id = options.jumpHost;
            while (id) {
              const j = byId.get(id), opts = j ? optionsFor(j) : {};
              if (!j || j.type !== "ssh" || !opts.host || seen.has(id)) throw new Error("Tabby 跳板机引用不存在或有循环");
              seen.add(id);
              chain.unshift(`${opts.user ? opts.user + "@" : ""}${str(opts.host).includes(":") ? `[${opts.host}]` : opts.host}${opts.port ? ":" + opts.port : ""}`);
              id = opts.jumpHost;
            }
            jump = chain.join(",");
            notes.push("跳板机凭据需由本机 OpenSSH/ssh-agent 提供");
          }
          if (array(options.forwardedPorts).length || options.scripts?.length || options.proxyCommand || options.socksProxyHost || options.httpProxyHost) notes.push("未迁移端口转发、登录脚本或代理命令，请检查原配置");
          emit({ name: p.name, group: groupPath(p.group), host: options.host, port: options.port, user: options.user,
            identityFile: array(options.privateKeys)[0], proxyJump: jump,
            auth: options.auth === "agent" ? "agent" : "password", password: options.password }, notes);
        }
        break;
      }
      case "finalshell": case "windterm": {
        const data = JSON.parse(text);
        for (const p of array(data)) {
          if (detected === "windterm") {
            if (nonSsh(p["session.protocol"])) continue;
            const notes = p["session.proxy"] && p["session.proxy"] !== "None" || p["ssh.tunnels"] ? ["代理或隧道未迁移，请检查原配置"] : [];
            emit({ name: p["session.label"], host: p["session.target"], port: p["session.port"], group: p["session.group"],
              identityFile: p["ssh.identityFilePath"] || p["ssh.identityFilePath.macos"] || p["ssh.identityFilePath.linux"] || p["ssh.identityFilePath.windows"],
              password: p["session.autoLogin"] }, notes);
          } else {
            if (p.type != null && Number(p.type) !== 100) continue;
            emit({ name: p.name, host: p.host, port: p.port, user: p.user_name, group: pathGroup(file.name),
              identityFile: p.private_key_path, password: p.password }, p.proxy_id ? ["代理设置未迁移，请检查原配置"] : []);
          }
        }
        break;
      }
      case "putty": parsePutty(text, emit); break;
      case "securecrt": if (text.trimStart().startsWith("<")) parseXml(text, detected, emit); else parseIni(text, detected, file.name, emit); break;
      case "mremoteng": case "superputty": parseXml(text, detected, emit); break;
      case "xshell": case "mobaxterm": case "winscp": case "remmina": parseIni(text, detected, file.name, emit); break;
      default: throw new Error("无法识别配置格式，请手动选择来源软件，或转为通用 CSV / OpenSSH 配置");
    }
    if (before === result.entries.length) warn(`${file.name}：未找到可导入的 SSH 远程连接（本地终端、RDP、Telnet 等不导入）`);
  };
  for (const file of input) {
    const start = result.entries.length;
    try { read(file); }
    catch {
      result.entries.splice(start);
      // Syntax errors can contain source lines with credentials. Do not echo parser messages.
      warn(`${file.name}：解析失败或超过文件限制，请检查格式；加密归档需先导出为明文配置`);
    }
  }
  return result;
}

function detect(text: string, name: string): ImportFormat {
  if (/"(?:Profiles|New Bookmarks|Custom Command)"\s*:/.test(text) || /"Name"\s*:/.test(text) && /"Command"\s*:/.test(text)) return "iterm2";
  if (/"(?:bookmarks|bookmarkGroups)"\s*:/.test(text) || /"title"\s*:/.test(text) && /"host"\s*:/.test(text)) return "electerm";
  if (/Windows Registry Editor|\[HKEY_.*\\(?:PuTTY|KiTTY)\\Sessions\\/i.test(text)) return "putty";
  if (/\[Bookmarks(?:_\d+)?\]/i.test(text)) return "mobaxterm";
  if (/S:"Hostname"\s*=/.test(text) || /<VanDyke[\s>]/i.test(text)) return "securecrt";
  if (/<Connections[\s>]/i.test(text)) return "mremoteng";
  if (/<(?:ArrayOfSessionData|SuperPuTTY|SessionData)[\s>]/i.test(text)) return "superputty";
  if (/\[CONNECTION\]/i.test(text)) return "xshell";
  if (/\[Sessions\\/i.test(text)) return "winscp";
  if (/\[remmina\]/i.test(text)) return "remmina";
  if (/"session\.target"\s*:/.test(text) || /\.sessions$/i.test(name)) return "windterm";
  if (/"user_name"\s*:/.test(text) || /_connect_config\.json$/i.test(name)) return "finalshell";
  if (/^profiles\s*:/m.test(text) || /\.(yaml|yml)$/i.test(name)) return "tabby";
  if (/\.csv$/i.test(name) || /(?:^|[,;])\s*"?(?:host|hostname|address|ip|ipaddress|主机地址|主机)"?\s*[,;]/i.test(text.split(/\r?\n/)[0])) return "csv";
  if (/^\s*Host\s*[=\s]/im.test(text)) return "openssh";
  return "auto";
}

// Quoting/comments and OpenSSH's first-value-wins rules; no subprocesses or Include traversal.
function sshWords(s: string): string[] {
  const words: string[] = []; let word = "", quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!quoted && c === "#") break;
    if (c === '"') quoted = !quoted;
    else if (c === "\\" && ["\\", '"', " ", "#"].includes(s[i + 1])) word += s[++i];
    else if (!quoted && /\s/.test(c)) { if (word) { words.push(word); word = ""; } }
    else word += c;
  }
  if (quoted) throw new Error("OpenSSH 引号未闭合");
  if (word) words.push(word);
  return words;
}
function parseOpenSsh(text: string, emit: (p: Obj, notes?: string[]) => void, warn: (s: string) => void) {
  const blocks: { patterns: string[]; values: Map<string, string[]>; conditional?: boolean }[] = [{ patterns: ["*"], values: new Map() }];
  const aliases = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([\w]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), values = sshWords(m[2]);
    if (!values.length) continue;
    if (key === "host") {
      blocks.push({ patterns: values, values: new Map() });
      values.filter(v => !/[!*?]/.test(v)).forEach(v => aliases.add(v));
    } else if (key === "match") { blocks.push({ patterns: [], values: new Map(), conditional: true }); warn("Match 条件块未迁移，请核对连接参数"); }
    else if (key === "include") warn("Include 文件未自动读取，请将相关配置一同选择或先合并配置");
    else { const b = blocks[blocks.length - 1]; b.values.set(key, [...(b.values.get(key) || []), values.join(" ")]); }
  }
  const matches = (patterns: string[], alias: string) => {
    const match = (p: string) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i").test(alias);
    return !patterns.some(p => p.startsWith("!") && match(p.slice(1))) && patterns.some(p => !p.startsWith("!") && match(p));
  };
  for (const alias of aliases) {
    const values = new Map<string, string[]>();
    for (const b of blocks) if (matches(b.patterns, alias)) for (const [k, v] of b.values) if (!values.has(k)) values.set(k, v);
    const get = (k: string) => values.get(k)?.[0];
    const host = (get("hostname") || alias).replace(/%h/g, alias);
    const notes: string[] = [];
    if (get("proxycommand") && get("proxycommand") !== "none") { warn(`${alias}：依赖 ProxyCommand，未导入；请改用 ProxyJump 后重试`); continue; }
    if (get("localcommand") || get("remotecommand")) notes.push("登录命令未迁移");
    for (const k of ["identityfile", "localforward", "remoteforward", "dynamicforward"]) if ((values.get(k)?.length || 0) > 1) notes.push(`${k} 有多个值，仅迁移第一个`);
    const identity = get("identityfile");
    if (identity?.includes("%") || identity?.includes("${")) notes.push("私钥路径含变量，请在导入后检查");
    emit({ name: alias, host, port: get("port"), user: get("user"), identityFile: identity === "none" ? undefined : identity,
      auth: "agent", proxyJump: get("proxyjump") === "none" ? undefined : get("proxyjump"),
      localForward: get("localforward")?.replace(/\s+/, ":"), remoteForward: get("remoteforward")?.replace(/\s+/, ":"),
      dynamicForward: get("dynamicforward") }, notes);
  }
}

const iniLabels = new WeakMap<Obj, { name: string; keys: Map<string, string> }>();
function ini(text: string, preserveSections = false, preserveKeys = false): Map<string, Obj> {
  const sections = new Map<string, Obj>();
  let section: Obj = {}; sections.set("", section);
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[;#]/.test(line)) continue;
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) { section = {}; sections.set(preserveSections ? heading[1] : heading[1].toLowerCase(), section); iniLabels.set(section, { name: heading[1], keys: new Map() }); continue; }
    const equal = line.indexOf("=");
    if (equal >= 0) {
      const key = line.slice(0, equal).trim();
      section[preserveKeys ? key : key.toLowerCase()] = line.slice(equal + 1).trim();
      iniLabels.get(section)?.keys.set(key.toLowerCase(), key);
    }
  }
  return sections;
}
function parseIni(text: string, format: ImportFormat, file: string, emit: (p: Obj, notes?: string[]) => void) {
  const s = ini(text, format === "winscp", format === "mobaxterm"), folder = pathGroup(file);
  if (format === "xshell") {
    const c = s.get("connection") || {}, a = s.get("connection:authentication") || {};
    if (!nonSsh(c.protocol)) emit({ name: leaf(file), group: folder, host: c.host, port: c.port, user: a.username,
      identityFile: a.userkey, password: a.password }, ["代理、隧道及登录脚本请对照原软件检查"]);
  } else if (format === "securecrt") {
    const get = (k: string) => s.get("")?.[`s:"${k}"`];
    if (nonSsh(get("protocol name"))) return;
    const port = s.get("")?.['d:"[ssh2] port"'];
    emit({ name: leaf(file), group: folder, host: get("hostname"), port: port ? parseInt(port, 16) : 22, user: get("username"),
      identityFile: get("identity filename"), password: get("password v2") || get("password") }, ["防火墙/跳板、隧道及登录脚本请对照原软件检查"]);
  } else if (format === "winscp") {
    for (const [name, v] of s) {
      // WinSCP TFSProtocol: 0=SCP, 1=SFTP, 2=SFTP-only; 5=FTP, 6=WebDAV, 7=S3.
      if (!name.toLowerCase().startsWith("sessions\\") || v.fsprotocol && !["0", "1", "2"].includes(v.fsprotocol)) continue;
      const label = decodeName((iniLabels.get(v)?.name || name).slice(9)), parts = groups(label);
      emit({ name: parts.pop(), group: parts, host: decodeName(v.hostname || ""), port: v.portnumber, user: decodeName(v.username || ""), identityFile: decodeName(v.publickeyfile || ""), password: v.password }, v.proxyhost || v.tunnelhostname ? ["代理/隧道未迁移，请检查原配置"] : []);
    }
  } else if (format === "remmina") {
    const v = s.get("remmina") || {};
    if (!nonSsh(v.protocol)) emit({ name: v.name, group: v.group, host: v.server, user: v.username, identityFile: v.ssh_privatekey, password: v.password });
  } else {
    for (const [section, v] of s) {
      if (!/^bookmarks(?:_\d+)?$/.test(section)) continue;
      for (const [name, value] of Object.entries(v)) {
        if (name.toLowerCase() === "subrep" || name.toLowerCase() === "imgnum") continue;
        const fields = str(value).split("#").find(part => /^\d+%/.test(part))?.split("%");
        if (!fields || fields[0] !== "0") continue;
        emit({ name, group: Object.entries(v).find(([k]) => k.toLowerCase() === "subrep")?.[1], host: fields[1], port: fields[2], user: fields[3] }, ["密码、私钥、网关、隧道及登录脚本请在导入后检查"]);
      }
    }
  }
}
function decodeName(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }
function parsePutty(text: string, emit: (p: Obj, notes?: string[]) => void) {
  let name = "", fields: Obj = {};
  const flush = () => {
    if (name && name !== "Default Settings" && !nonSsh(fields.Protocol)) emit({ name, host: fields.HostName, port: fields.PortNumber,
      user: fields.UserName, identityFile: fields.PublicKeyFile }, ["代理、隧道及登录命令请对照原软件检查"]);
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      flush(); fields = {}; name = "";
      const match = /^\[HKEY_[^\]]*\\(?:PuTTY|KiTTY)\\Sessions\\([^\]]+)\]$/i.exec(line);
      if (match) name = decodeName(match[1]);
    } else {
      const m = /^"([^"]+)"=(?:"((?:\\.|[^"\\])*)"|dword:([\da-f]+))\s*$/i.exec(line);
      if (m) fields[m[1]] = m[3] ? parseInt(m[3], 16) : m[2].replace(/\\([\\"])/g, "$1");
    }
  }
  flush();
}

function parseXml(text: string, format: ImportFormat, emit: (p: Obj, notes?: string[]) => void) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("不支持带 DTD/实体声明的 XML");
  if (XMLValidator.validate(text) !== true) throw new Error("XML 配置语法错误");
  const data = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, trimValues: false }).parse(text);
  const walk = (value: any, path: string[] = [], depth = 0) => {
    if (depth > 64) throw new Error("XML 层级过深");
    for (const node of array(value)) {
      const n = object(node);
      if (format === "securecrt") {
        const fields: Obj = {};
        for (const tag of ["string", "dword"]) for (const x of array(n[tag])) if (x?.["@name"]) fields[x["@name"]] = str(x["#text"]);
        if (fields.Hostname && !nonSsh(fields["Protocol Name"])) emit({ name: n["@name"], group: path.slice(path.indexOf("Sessions") + 1), host: fields.Hostname,
          port: fields["[SSH2] Port"], user: fields.Username, identityFile: fields["Identity Filename"], password: fields["Password V2"] }, ["防火墙/跳板、隧道及登录脚本请对照原软件检查"]);
        for (const child of array(n.key)) walk(child, [...path, str(n["@name"])].filter(Boolean), depth + 1);
        for (const [k, v] of Object.entries(n)) if (!k.startsWith("@") && !["key", "string", "dword"].includes(k)) walk(v, path, depth + 1);
      } else if (format === "mremoteng") {
        if (n["@Type"] === "Connection" && !nonSsh(n["@Protocol"])) emit({ name: n["@Name"], group: path, host: n["@Hostname"], port: n["@Port"],
          user: n["@Username"], password: n["@Password"] }, ["继承凭据、网关及登录脚本请对照原软件检查"]);
        for (const [k, v] of Object.entries(n)) if (!k.startsWith("@")) walk(v, n["@Type"] === "Container" ? [...path, str(n["@Name"])] : path, depth + 1);
      } else {
        if (n["@Host"] && !nonSsh(n["@Proto"])) emit({ name: n["@SessionName"], group: pathGroup(n["@SessionId"] || ""), host: n["@Host"],
          port: n["@Port"], user: n["@Username"] }, ["PuTTY 引用会话、私钥及额外参数请对照原软件检查"]);
        for (const [k, v] of Object.entries(n)) if (!k.startsWith("@")) walk(v, path, depth + 1);
      }
    }
  };
  walk(data);
}

function parseCsv(text: string, emit: (p: Obj, notes?: string[]) => void) {
  const rows: string[][] = []; let row: string[] = [], field = "", quote = false;
  const delimiter = (text.split(/\r?\n/)[0].match(/;/g)?.length || 0) > (text.split(/\r?\n/)[0].match(/,/g)?.length || 0) ? ";" : ",";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quote && text[i + 1] === '"') { field += '"'; i++; } else quote = !quote; }
    else if (!quote && (c === delimiter || c === "\n")) { row.push(field); field = ""; if (c === "\n") { rows.push(row); row = []; } }
    else if (c !== "\r" || quote) field += c;
  }
  if (quote) throw new Error("CSV 引号未闭合");
  row.push(field); if (row.some(s => s.trim())) rows.push(row);
  const names = rows.shift()?.map(s => s.trim().toLowerCase().replace(/[\s_-]/g, "")) || [];
  const aliases: Record<string, string[]> = {
    host: ["host", "hostname", "address", "ip", "ipaddress", "主机", "主机地址", "地址"],
    name: ["name", "label", "alias", "名称"], port: ["port", "sshport", "端口"],
    user: ["user", "username", "sshusername", "用户名"], group: ["group", "groups", "分组"],
    identityFile: ["identityfile", "privatekeypath", "keyfile", "私钥路径"],
    proxyJump: ["proxyjump", "跳板机"], password: ["password", "sshpassword", "密码"], protocol: ["protocol", "协议"],
  };
  if (!aliases.host.some(k => names.includes(k))) throw new Error("CSV 缺少 host / hostname / address / 主机地址 列");
  for (const row of rows) {
    const p: Obj = {};
    for (const [key, options] of Object.entries(aliases)) { const at = names.findIndex(n => options.includes(n)); if (at >= 0) p[key] = row[at]; }
    if (!nonSsh(p.protocol)) emit(p);
  }
}
