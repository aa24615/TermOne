import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync } from "fflate";
import { parseSshImport, decodeImportText, sshConnectionKey, existingSshKeys } from "../apps/desktop/src/sshImport.ts";
const file = (name, text) => ({ name, data: new TextEncoder().encode(text) });
const parse = (name, text, format) => parseSshImport([file(name, text)], format);

test("OpenSSH: explicit hosts, aliases, first value, wildcard inheritance, quoting, comments, IPv6 and forwards", () => {
  const out = parse("config", `Host production alias # not another alias
  HostName 192.0.2.10
  User deploy
  User ignored
  Port=2222
  IdentityFile "~/.ssh/key with space"
  LocalForward 8080 localhost:80
  RemoteForward 9000 localhost:90
  DynamicForward 1080
  ProxyJump admin@jump:22
Host ipv6
  HostName 2001:db8::1
Host * !ipv6
  User inherited
  Port 2200
`);
  assert.equal(out.entries.length, 3);
  assert.deepEqual(out.entries.map(e => e.name), ["production", "alias", "ipv6"]);
  const c = out.entries[0].config;
  assert.equal(c.host, "192.0.2.10"); assert.equal(c.user, "deploy"); assert.equal(c.port, 2222);
  assert.equal(c.identityFile, "~/.ssh/key with space"); assert.equal(c.auth, "key");
  assert.equal(c.localForward, "8080:localhost:80"); assert.equal(c.remoteForward, "9000:localhost:90");
  assert.equal(c.dynamicForward, 1080); assert.equal(c.proxyJump, "admin@jump:22");
  assert.equal(out.entries[2].config.port, 22);
});
test("OpenSSH: Include/Match never execute and ProxyCommand-dependent hosts are skipped", () => {
  const out = parse("config", `Include ~/.ssh/config.d/*
Host jump
 HostName example.com
 ProxyCommand sh -c anything
Match exec "touch /tmp/should-never-run"
 User incorrect
Host safe
 HostName safe.example
`);
  assert.deepEqual(out.entries.map(e => e.name), ["safe"]);
  assert.ok(out.warnings.some(w => w.includes("Include")));
  assert.ok(out.warnings.some(w => w.includes("Match")));
  assert.ok(out.warnings.some(w => w.includes("ProxyCommand")));
});
test("Tabby: only SSH profiles, key path, groups, default port and jump chain", () => {
  const out = parse("config.yaml", `profiles:
  - id: jump
    type: ssh
    name: 堡垒机
    group: 生产/华东
    options:
      host: jump.example
      user: ops
      port: 2222
      auth: agent
  - id: app
    type: ssh
    name: 业务机
    group: 生产/华东
    options:
      host: app.example
      user: deploy
      auth: publicKey
      privateKeys: ["~/.ssh/id_ed25519"]
      jumpHost: jump
      password: do-not-import
  - type: local
    options: {command: bash}
`);
  assert.equal(out.entries.length, 2);
  assert.deepEqual(out.entries[1].group, ["生产", "华东"]);
  assert.equal(out.entries[1].config.proxyJump, "ops@jump.example:2222");
  assert.equal(out.entries[1].config.auth, "key");
  assert.ok(!JSON.stringify(out).includes("do-not-import"));
});
test("Tabby: unresolved/circular jump references reject the file instead of importing a direct connection", () => {
  for (const jumpHost of ["missing", "app"]) {
    const out = parse("config.yaml", `profiles:\n- id: app\n  type: ssh\n  name: app\n  options: {host: app.example, jumpHost: ${jumpHost}}`);
    assert.equal(out.entries.length, 0); assert.ok(out.warnings.length);
  }
});
test("Tabby: group IDs resolve names/parents and inherit SSH group defaults", () => {
  const out = parse("config.yaml", `groups:
  - {id: root, name: 生产}
  - id: child
    name: 华东
    parentGroupId: root
    defaults:
      ssh:
        options: {port: 2222, user: inherited}
profiles:
  - type: ssh
    name: app
    group: child
    options: {host: app.example}
  - {type: ssh, isTemplate: true, options: {host: template.example}}
`);
  assert.equal(out.entries.length, 1); assert.deepEqual(out.entries[0].group, ["生产", "华东"]);
  assert.equal(out.entries[0].config.user, "inherited"); assert.equal(out.entries[0].config.port, 2222);
});
test("WindTerm: mixed session protocols, embedded username, IPv6 and group hierarchy", () => {
  const out = parse("user.sessions", JSON.stringify([
    { "session.protocol": "SSH", "session.target": "ops@[2001:db8::2]", "session.port": 2222, "session.label": "Prod", "session.group": "生产>上海", "session.autoLogin": "encrypted-secret" },
    { "session.protocol": "Shell", "session.target": "/bin/zsh" },
    { "session.protocol": "SSH", "session.target": "db.example", "ssh.identityFilePath": "~/.ssh/key" },
  ]));
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries[0].config.user, "ops"); assert.equal(out.entries[0].config.host, "2001:db8::2");
  assert.equal(out.entries[0].config.port, 2222); assert.deepEqual(out.entries[0].group, ["生产", "上海"]);
  assert.equal(out.entries[1].config.auth, "key"); assert.ok(!JSON.stringify(out).includes("encrypted-secret"));
});
test("Termius CSV: template headers, quoted names, subgroups, defaults and no passwords", () => {
  const out = parse("termius.csv", 'label,address,ssh_port,ssh_username,groups,ssh_password\r\n"业务,一",192.0.2.5,2222,root,生产/一组,secret\r\n数据库,db.example,,deploy,生产/二组,\r\n', "termius");
  assert.equal(out.entries.length, 2); assert.equal(out.entries[0].name, "业务,一");
  assert.equal(out.entries[0].config.port, 2222); assert.equal(out.entries[0].config.user, "root");
  assert.equal(out.entries[1].config.port, 22); assert.ok(!JSON.stringify(out).includes("secret"));
});
test("Termius OpenSSH migration file", () => {
  const out = parse("sshconfig", "Host prod\n HostName prod.example\n User deploy\n", "termius");
  assert.equal(out.entries[0].config.host, "prod.example");
});
test("Xshell: section parsing, Windows path and non-SSH filter", () => {
  const text = "[CONNECTION]\nProtocol=SSH\nHost=prod.example\nPort=2222\n[CONNECTION:AUTHENTICATION]\nUserName=Admin\nUserKey=C:\\keys\\key.pem\nPassword=encrypted\n";
  const out = parse("生产/App.xsh", text);
  assert.equal(out.entries[0].name, "App"); assert.deepEqual(out.entries[0].group, ["生产"]);
  assert.equal(out.entries[0].config.user, "Admin"); assert.equal(out.entries[0].config.identityFile, "C:\\keys\\key.pem");
  assert.equal(parse("App.xsh", text.replace("Protocol=SSH", "Protocol=TELNET")).entries.length, 0);
});
test("FinalShell: remote SSH type, directory grouping, credentials never leave parser", () => {
  const out = parse("生产/app_connect_config.json", JSON.stringify({ type: 100, name: "app", host: "app.example", port: 22, user_name: "root", password: "secret" }));
  assert.equal(out.entries[0].config.user, "root"); assert.deepEqual(out.entries[0].group, ["生产"]);
  assert.ok(!JSON.stringify(out).includes("secret"));
});
test("SecureCRT INI: hexadecimal port", () => {
  const out = parse("Group/Prod.ini", 'S:"Protocol Name"=SSH2\nS:"Hostname"=prod.example\nS:"Username"=root\nD:"[SSH2] Port"=000008ae\n');
  assert.equal(out.entries[0].config.port, 2222); assert.deepEqual(out.entries[0].group, ["Group"]);
});
test("SecureCRT XML: nested Sessions folders and XML entities", () => {
  const out = parse("export.xml", '<VanDyke><key name="Sessions"><key name="生产"><key name="A &amp; B"><string name="Hostname">a.example</string><string name="Username">root</string><dword name="[SSH2] Port">2222</dword></key></key></key></VanDyke>');
  assert.equal(out.entries.length, 1); assert.equal(out.entries[0].name, "A & B");
  assert.equal(out.entries[0].config.port, 2222); assert.deepEqual(out.entries[0].group, ["生产"]);
});
test("PuTTY/KiTTY: exported reg, escaped key path, encoded labels, SSH only", () => {
  const out = parse("putty.reg", 'Windows Registry Editor Version 5.00\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Prod%20Server]\n"HostName"="prod.example"\n"PortNumber"=dword:000008ae\n"Protocol"="ssh"\n"UserName"="admin"\n"PublicKeyFile"="C:\\\\key.ppk"\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Telnet]\n"Protocol"="telnet"\n"HostName"="telnet.example"\n');
  assert.equal(out.entries.length, 1); assert.equal(out.entries[0].name, "Prod Server");
  assert.equal(out.entries[0].config.port, 2222); assert.equal(out.entries[0].config.identityFile, "C:\\key.ppk");
});
test("MobaXterm: bookmark SSH discriminant, case-preserved label and groups", () => {
  const out = parse("MobaXterm.ini", "[Bookmarks]\nSubRep=Prod\\Shanghai\nImgNum=42\nAppServer=#109#0%app.example%2222%Admin%%-1%-1%%%%\nRDP=#109#4%rdp.example%3389%admin%\n");
  assert.equal(out.entries.length, 1); assert.equal(out.entries[0].name, "AppServer");
  assert.equal(out.entries[0].config.user, "Admin"); assert.deepEqual(out.entries[0].group, ["Prod", "Shanghai"]);
});
test("mRemoteNG: SSH2 connection nodes, nested containers, skip RDP", () => {
  const out = parse("confCons.xml", '<Connections><Node Type="Container" Name="Prod"><Node Type="Connection" Name="Web" Hostname="web.example" Protocol="SSH2" Username="admin" Port="22" Password="secret"/><Node Type="Connection" Name="RDP" Hostname="rdp.example" Protocol="RDP"/></Node></Connections>');
  assert.equal(out.entries.length, 1); assert.deepEqual(out.entries[0].group, ["Prod"]);
  assert.ok(!JSON.stringify(out).includes("secret"));
});
test("SuperPuTTY, WinSCP and Remmina formats", () => {
  assert.equal(parse("sessions.xml", '<ArrayOfSessionData><SessionData SessionId="Prod/App" SessionName="App" Host="app.example" Port="22" Proto="SSH" Username="root"/></ArrayOfSessionData>').entries[0].group[0], "Prod");
  const winscp = parse("WinSCP.ini", "[Sessions\\Prod%2FAppServer]\nHostName=app.example\nPortNumber=2222\nUserName=Admin\nFSProtocol=2\n");
  assert.equal(winscp.entries[0].name, "AppServer"); assert.deepEqual(winscp.entries[0].group, ["Prod"]);
  assert.equal(parse("prod.remmina", "[remmina]\nname=Production\nprotocol=SSH\nserver=app.example:2222\nusername=admin\n").entries[0].config.port, 2222);
});
test("UTF-16 Windows exports and GB18030 Chinese files", () => {
  assert.equal(decodeImportText(Uint8Array.from([255,254,65,0])), "A");
  assert.equal(decodeImportText(Uint8Array.from([254,255,0,65])), "A");
  assert.equal(decodeImportText(Uint8Array.from([0xd6,0xd0,0xce,0xc4])), "中文");
});
test("ZIP/XTS batch, resource limits and paths never extracted to disk", () => {
  const zip = zipSync({ "Sessions/App.xsh": file("", "[CONNECTION]\nProtocol=SSH\nHost=app.example").data });
  assert.equal(parseSshImport([{ name: "export.xts", data: zip }]).entries.length, 1);
  const unsafe = zipSync({ "../App.xsh": file("", "[CONNECTION]\nHost=app.example").data });
  assert.equal(parseSshImport([{ name: "export.zip", data: unsafe }]).entries.length, 0);
});
test("malformed files are isolated, reject controls/invalid ports/XXE, never echo parser secrets", () => {
  const out = parseSshImport([file("bad.yaml", "profiles: [secret: broken"), file("good.csv", "name,host,port\nApp,app.example,22\n")]);
  assert.equal(out.entries.length, 1); assert.ok(!JSON.stringify(out).includes("secret"));
  assert.equal(parse("bad.csv", "host,port\napp.example,70000\n").entries.length, 0);
  assert.equal(parse("bad.csv", 'host,username\napp.example,"bad\nuser"\n').entries.length, 0);
  assert.equal(parse("export.xml", '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><VanDyke>&x;</VanDyke>').entries.length, 0);
});
test("duplicate identity is host+port+user+jump, excludes local profiles and soft deletes", () => {
  const config = { host: "Example.COM", port: 22, user: "ops", auth: "password" };
  assert.equal(sshConnectionKey(config), sshConnectionKey({ ...config, host: "example.com" }));
  assert.notEqual(sshConnectionKey(config), sshConnectionKey({ ...config, proxyJump: "jump" }));
  assert.equal(existingSshKeys([{kind:"local",config}, {kind:"ssh",config,deleted:true}, {kind:"ssh",config}]).size, 1);
});


test("electerm: full export preserves nested group membership and resolves authentication profiles", () => {
  const out = parse("electerm-all-data.json", JSON.stringify({
    bookmarks:[{id:"app",type:"ssh",title:"应用",host:"app.example",port:2222,authType:"profiles",profile:"auth"},{id:"local",type:"local",title:"本地",host:"ignored"}],
    bookmarkGroups:[{id:"prod",title:"生产",bookmarkIds:[],bookmarkGroupIds:["east"]},{id:"east",title:"华东",bookmarkIds:["app"],bookmarkGroupIds:[]}],
    profiles:[{id:"auth",name:"认证",username:"deploy",privateKeyPath:"~/.ssh/key",password:"dont-copy"}],
  }));
  assert.equal(out.entries.length,1);assert.deepEqual(out.entries[0].group,["生产","华东"]);
  assert.equal(out.entries[0].config.user,"deploy");assert.equal(out.entries[0].config.port,2222);
  assert.equal(out.entries[0].config.identityFile,"~/.ssh/key");assert.ok(!JSON.stringify(out).includes("dont-copy"));
});
test("electerm: copied bookmark and array export, inline credentials never copied", () => {
  for(const data of [{type:"ssh",host:"app.example",title:"app",username:"ops",privateKey:"PRIVATE-KEY-CONTENT",password:"SECRET-PASSWORD"},[{type:"ssh",host:"db.example",title:"db",username:"ops"}]]) {
    const out=parse("bookmark.json",JSON.stringify(data));assert.equal(out.entries.length,1);assert.equal(out.entries[0].config.user,"ops");
    assert.ok(!JSON.stringify(out).includes("PRIVATE-KEY-CONTENT"));assert.ok(!JSON.stringify(out).includes("SECRET-PASSWORD"));
  }
});
test("electerm: jump hosts, legacy string records, missing profile and group cycle", () => {
  const out=parse("electerm.json",JSON.stringify({bookmarks:[JSON.stringify({id:"a",title:"app",host:"app.example",connectionHoppings:[{host:"2001:db8::1",username:"jump",port:2222}]}),{id:"b",title:"bad",host:"bad.example",authType:"profiles",profile:"missing"}],bookmarkGroups:[{id:"default",title:"默认",bookmarkIds:["a"]}]}));
  assert.equal(out.entries.length,1);assert.equal(out.entries[0].config.proxyJump,"jump@[2001:db8::1]:2222");assert.deepEqual(out.entries[0].group,[]);
  assert.ok(out.warnings.length);
  const cycle=parse("electerm.json",JSON.stringify({bookmarks:[{id:"a",title:"app",host:"app.example"}],bookmarkGroups:[{id:"one",title:"1",bookmarkIds:["a"],bookmarkGroupIds:["two"]},{id:"two",title:"2",bookmarkGroupIds:["one"]}]}));
  assert.equal(cycle.entries.length,0);assert.ok(cycle.warnings.length);
});
test("iTerm2: dynamic profiles, direct command arguments, quoting and tags", () => {
  const out=parse("profiles.json",JSON.stringify({Profiles:[{Name:"生产 SSH",Guid:"prod","Custom Command":"Yes",Command:'/usr/bin/ssh -p2222 -l deploy -i "~/.ssh/key with space" -J ops@jump:22 -L8080:localhost:80 -R9000:localhost:90 -D1080 app.example',Tags:["生产/华东"]},{Name:"本地","Custom Command":"No",Command:"/bin/zsh"}]}));
  assert.equal(out.entries.length,1);const c=out.entries[0].config;
  assert.equal(c.host,"app.example");assert.equal(c.port,2222);assert.equal(c.user,"deploy");assert.equal(c.identityFile,"~/.ssh/key with space");
  assert.equal(c.proxyJump,"ops@jump:22");assert.equal(c.localForward,"8080:localhost:80");assert.equal(c.remoteForward,"9000:localhost:90");assert.equal(c.dynamicForward,1080);
  assert.deepEqual(out.entries[0].group,["生产","华东"]);
});
test("iTerm2: single JSON, IPv6 SSH URL and options-style command",()=>{
  const a=parse("profile.json",JSON.stringify({Name:"IPv6","Custom Command":"Yes",Command:"ssh ssh://ops:do-not-copy@[2001:db8::1]:2222"}));
  assert.equal(a.entries[0].config.host,"2001:db8::1");assert.equal(a.entries[0].config.user,"ops");assert.equal(a.entries[0].config.port,2222);assert.ok(!JSON.stringify(a).includes("do-not-copy"));
  const b=parse("profile.json",JSON.stringify({Name:"Options",Command:'ssh -o "HostName=app.example" -oUser=root -oPort=2200 -- alias'}));
  assert.equal(b.entries[0].config.host,"app.example");assert.equal(b.entries[0].config.user,"root");assert.equal(b.entries[0].config.port,2200);
});
test("iTerm2: initial text and inherited profiles from preferences JSON",()=>{
  const out=parse("iterm.json",JSON.stringify({"New Bookmarks":[{Name:"Parent",Guid:"parent","Custom Command":"Yes",Command:"ssh deploy@app.example"},{Name:"Child",Guid:"child","Dynamic Profile Parent GUID":"parent"},{Name:"Initial","Custom Command":"No","Initial Text":"ssh ops@db.example"}]}));
  assert.equal(out.entries.length,3);assert.equal(out.entries[1].name,"Child");assert.equal(out.entries[1].config.host,"app.example");assert.equal(out.entries[2].config.user,"ops");
});
test("iTerm2: shell wrappers, command substitutions, ProxyCommand and custom config are never executed or imported",()=>{
  const commands=["ssh host && touch /tmp/nope","sh -c 'ssh host'","ssh $(touch /tmp/nope)","ssh -oProxyCommand=anything host","ssh -F /tmp/external-config host"];
  const out=parse("profiles.json",JSON.stringify({Profiles:commands.map((Command,i)=>({Name:"bad"+i,Command,"Custom Command":"Yes"})).concat({Name:"good",Command:"ssh user@safe.example"})}));
  assert.equal(out.entries.length,1);assert.equal(out.entries[0].name,"good");assert.ok(out.warnings.length>=commands.length);
});
test("WinSCP: official protocol enum admits SCP/SFTP/SFTP-only and excludes FTP/WebDAV/S3",()=>{
  const out=parse("WinSCP.ini",[0,1,2,5,6,7,99].map(n=>`[Sessions\\server${n}]\nHostName=server${n}.example\nFSProtocol=${n}\n`).join(""));
  assert.deepEqual(out.entries.map(e=>e.name),["server0","server1","server2"]);
});
test("WinSCP and MobaXterm preserve case-distinct session names",()=>{
  const w=parse("WinSCP.ini","[Sessions\\Prod]\nHostName=prod.example\n[Sessions\\prod]\nHostName=other.example\n");
  assert.deepEqual(w.entries.map(e=>e.name),["Prod","prod"]);
  const m=parse("MobaXterm.ini","[Bookmarks]\nSubRep=生产\nProd=#109#0%one.example%22%ops%\nprod=#109#0%two.example%22%ops%\n");
  assert.deepEqual(m.entries.map(e=>e.name),["Prod","prod"]);assert.deepEqual(m.entries[0].group,["生产"]);
});
