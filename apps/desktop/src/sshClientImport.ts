// Client-specific data adapters. Imported commands are parsed as data and never executed.
type Obj = Record<string, any>;
type Emit = (entry: Obj, notes?: string[]) => void;
const arr = (v: any): any[] => v == null ? [] : Array.isArray(v) ? v : [v];
const obj = (v: any): Obj => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const text = (v: any) => typeof v === "string" ? v.trim() : "";
const record = (v: any): Obj => typeof v === "string" ? obj(JSON.parse(v)) : obj(v);

export function parseElecterm(data: any, emit: Emit, warn: (message: string) => void) {
  const root = obj(data);
  const bookmarks = arr(root.bookmarks ?? data).map(record);
  const groups = arr(root.bookmarkGroups).map(record);
  const byId = new Map(groups.map(g => [g.id, g]));
  const parents = new Map<string, string>();
  const memberships = new Map<string, string[]>();
  for (const g of groups) {
    for (const child of arr(g.bookmarkGroupIds)) {
      if (parents.has(child) && parents.get(child) !== g.id) throw new Error("分组有多个父组");
      parents.set(child, g.id);
    }
    for (const id of arr(g.bookmarkIds)) memberships.set(id, [...(memberships.get(id) || []), g.id]);
  }
  const pathFor = (id: string) => {
    const path: string[] = [], seen = new Set<string>();
    while (id) {
      if (seen.has(id) || seen.size > 16) throw new Error("分组有循环或层级过深");
      seen.add(id);
      const g = byId.get(id);
      if (!g) break;
      if (g.id !== "default") path.unshift(text(g.title));
      id = parents.get(id) || "";
    }
    return path;
  };
  const profiles = new Map(arr(root.profiles).map(record).map(p => [p.id, p]));
  const authFor = (b: Obj) => {
    if (b.authType !== "profiles") return b;
    const profile = profiles.get(b.profile);
    if (!profile) throw new Error("缺少认证档案");
    // electerm profile values override the bookmark's values when profile auth is selected.
    return { ...b, ...Object.fromEntries(Object.entries(profile).filter(([k, v]) => !["id", "name"].includes(k) && v !== undefined && v !== "")) };
  };
  for (const b of bookmarks) {
    if (!b.host || b.type && b.type !== "ssh") continue;
    try {
      const auth = authFor(b), notes: string[] = [];
      const membership = memberships.get(b.id) || [];
      if (membership.length > 1) notes.push("书签属于多个分组，仅迁移第一个分组");
      if (auth.privateKey) notes.push("内嵌私钥未迁移，请导入后选择本机私钥");
      if (auth.certificate || auth.certificatePath) notes.push("SSH 证书未迁移，请检查认证配置");
      if (b.proxy || b.proxyCommand || arr(b.sshTunnels).length || arr(b.runScripts).length || arr(b.quickCommands).length) notes.push("代理、隧道及登录脚本请对照原软件检查");
      if (b.proxyCommand) { warn("electerm：依赖代理命令的书签已跳过，请先改为跳板连接"); continue; }
      const hops = arr(b.connectionHoppings).map(record).map(authFor);
      const jump = hops.map(h => {
        const host = text(h.host), user = text(h.username), port = h.port ?? 22;
        if (!host || /[\s@,]/.test(host) || /[\s@,]/.test(user) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error("跳板无效");
        return `${user ? user + "@" : ""}${host.includes(":") ? `[${host.replace(/^\[|\]$/g, "")}]` : host}:${port}`;
      }).join(",");
      if (jump) notes.push("跳板机凭据需由本机 OpenSSH/ssh-agent 提供");
      emit({ name: b.title, host: b.host, port: b.port, user: auth.username,
        group: pathFor(membership[0]), identityFile: auth.privateKey ? undefined : auth.privateKeyPath,
        auth: auth.useSshAgent ? "agent" : "password", password: auth.password, proxyJump: jump }, notes);
    } catch { warn("electerm：跳过分组、认证档案或跳板引用无效的书签"); }
  }
}

// Shell-like tokenization is only for finding SSH arguments; no shell or subprocess is invoked.
function commandWords(command: string): string[] {
  const words: string[] = []; let word = "", quote = "", started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (/\r|\n|\0/.test(c)) throw new Error("多条命令");
    if (quote) {
      if (c === quote) quote = "";
      else if (quote === '"' && c === "\\" && ['"', "\\"].includes(command[i + 1])) word += command[++i];
      else if (quote !== "'" && (c === "$" || c === "`")) throw new Error("命令含变量");
      else word += c;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = ""; started = false;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === "\\") { if (i + 1 >= command.length) throw new Error("不完整转义"); word += command[++i]; started = true; }
    else if (/[;&|<>`$()]/.test(c)) throw new Error("命令含 shell 表达式");
    else { word += c; started = true; }
  }
  if (quote) throw new Error("引号未闭合");
  if (started) words.push(word);
  return words;
}
function sshCommand(command: string): { entry: Obj; notes: string[] } | null {
  const args = commandWords(command);
  if (!/^(?:\/[^\s]+\/)?ssh$/.test(args.shift() || "")) return null;
  const entry: Obj = { auth: "agent" }, notes: string[] = [];
  const option = (value: string) => {
    const match = /^([a-z]+)(?:=|\s+)(.*)$/i.exec(value);
    if (!match) throw new Error("SSH option 无效");
    const key = match[1].toLowerCase(), val = match[2];
    if (["proxycommand", "localcommand", "remotecommand", "knownhostscommand"].includes(key)) throw new Error("SSH 命令选项无法迁移");
    const fields: Record<string, string> = { hostname: "host", port: "port", user: "user", identityfile: "identityFile", proxyjump: "proxyJump", localforward: "localForward", remoteforward: "remoteForward", dynamicforward: "dynamicForward" };
    if (fields[key]) entry[fields[key]] ??= val;
    else notes.push("部分 SSH 选项未迁移，请对照原 Profile 检查");
  };
  let destination = "";
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--") { destination = args.shift() || ""; break; }
    if (!arg.startsWith("-")) { destination = arg; break; }
    const flag = arg[1];
    const fields: Record<string, string> = { p: "port", l: "user", i: "identityFile", J: "proxyJump", L: "localForward", R: "remoteForward", D: "dynamicForward" };
    if (fields[flag] || flag === "o") {
      const value = arg.slice(2) || args.shift();
      if (!value) throw new Error("SSH 选项缺少参数");
      if (flag === "o") option(value); else entry[fields[flag]] ??= value;
    } else if (/^-[46AaCfGgKkMNnqsTtVvXxYy]+$/.test(arg)) notes.push("部分 SSH 开关未迁移，请对照原 Profile 检查");
    else throw new Error("SSH 选项未支持");
  }
  if (!destination || destination.startsWith("-")) throw new Error("缺少 SSH 目标");
  if (destination.startsWith("ssh://")) {
    const url = new URL(destination);
    entry.host ??= url.hostname;
    entry.user ??= decodeURIComponent(url.username);
    if (url.port) entry.port ??= url.port;
    if (url.password) notes.push("密码未迁移，连接时重新输入");
    if (url.pathname && url.pathname !== "/" || url.search || url.hash) throw new Error("SSH URL 包含额外参数");
  } else {
    const at = destination.lastIndexOf("@");
    entry.host ??= at >= 0 ? destination.slice(at + 1) : destination;
    if (at >= 0) entry.user ??= destination.slice(0, at);
  }
  if (args.length) notes.push("远端启动命令未迁移，连接后进入普通 SSH 终端");
  if (entry.proxyJump === "none") delete entry.proxyJump;
  for (const k of ["localForward", "remoteForward"]) if (entry[k]) entry[k] = entry[k].replace(/\s+/, ":");
  return { entry, notes };
}

export function parseIterm(data: any, emit: Emit, warn: (message: string) => void) {
  const root = obj(data);
  const profiles = arr(root.Profiles ?? root["New Bookmarks"] ?? data).map(record);
  const byGuid = new Map(profiles.map(p => [p.Guid, p]));
  const byName = new Map(profiles.map(p => [p.Name, p]));
  const resolve = (p: Obj, seen = new Set<Obj>()): Obj => {
    if (seen.has(p) || seen.size > 16) throw new Error("Profile 继承循环");
    seen.add(p);
    const parentId = p["Dynamic Profile Parent GUID"], parentName = p["Dynamic Profile Parent Name"];
    let parent = parentId ? byGuid.get(parentId) : parentName ? byName.get(parentName) : byGuid.get(root["Default Bookmark Guid"]);
    if (parent === p) parent = undefined;
    const notes: string[] = [];
    if ((parentId || parentName) && !parent) notes.push("父 Profile 不在导入文件中，请检查继承配置");
    return { ...(parent ? resolve(parent, seen) : {}), ...p, __notes: notes };
  };
  for (const p of profiles) {
    try {
      const profile = resolve(p);
      const custom = profile["Custom Command"];
      const useCommand = custom === "Yes" || custom === true || custom == null;
      const command = text(useCommand ? profile.Command || profile["Initial Text"] : profile["Initial Text"]);
      if (!command) continue;
      const parsed = sshCommand(command);
      if (!parsed) { if (/\bssh\b/.test(command)) warn("iTerm2：跳过通过 shell 包装、复合命令启动的 SSH Profile，请改为直接 ssh 命令"); continue; }
      const tags = arr(profile.Tags).map(text).filter(t => t && t !== "Dynamic");
      const notes = [...profile.__notes, ...parsed.notes];
      if (tags.length > 1) notes.push("Profile 有多个标签，仅使用第一个作为分组");
      if (profile["Initial Text"] && useCommand && profile.Command) notes.push("启动后发送文本未迁移");
      emit({ ...parsed.entry, name: profile.Name, group: tags[0] }, notes);
    } catch { warn("iTerm2：跳过命令或继承配置无法安全转换的 Profile，请使用直接的 ssh 命令"); }
  }
}
