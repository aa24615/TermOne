// Real system-SSH/PTY transport. Linux collection runs in a dedicated disposable container.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import ssh2 from "ssh2";
const { Server } = ssh2;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "termone-monitor-"));
const container = `termone-monitor-${Date.now()}`;
const image = process.env.TERMONE_MONITOR_TEST_IMAGE || "termone-linux-build:requirements-20261024";
execFileSync("docker", ["run", "--rm", "-d", "--name", container, "--entrypoint", "sh", image, "-c", "sleep 3600"]);
for (const key of ["server-key", "client-key"]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, key)]);
const clients = new Set();
let active = 0, closed = 0;
const statsPath = path.resolve("target/qa/monitor-fixture-stats.json");
const stats = () => fs.writeFileSync(statsPath, JSON.stringify({ active, closed, container }));
fs.mkdirSync(path.dirname(statsPath), { recursive: true }); stats();
const server = new Server({ hostKeys: [fs.readFileSync(path.join(root, "server-key"))] }, client => {
  clients.add(client); let user = ""; const cleanups = new Set();
  client.on("authentication", context => {
    user = context.username;
    if (user === "password") context.method === "password" && context.password === "monitor-test" ? context.accept() : context.reject(["password"]);
    else if (user === "key") context.method === "publickey" ? context.accept() : context.reject(["publickey"]);
    else context.accept();
  }).on("ready", () => client.on("session", accept => {
    const session = accept();
    session.on("exec", (accept, reject, info) => {
      const token = info.command.match(/TMON_([a-f0-9]{32})_BEGIN/)?.[1];
      if (!token || !info.command.startsWith("sh -c ") || !info.command.includes("df -Pk -l")) { reject(); return; }
      const stream = accept(); active++; stats();
      let child, timer, index = 0;
      const dispose = () => { if (!cleanups.delete(dispose)) return; active--; closed++; clearInterval(timer); child?.kill(); stats(); };
      cleanups.add(dispose); stream.on("close", dispose);
      if (user === "unsupported") { stream.write(`TMON_${token}_UNSUPPORTED\n`); stream.exit(1); stream.end(); return; }
      if (user === "linux") {
        child = spawn("docker", ["exec", container, "sh", "-c", info.command], { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", bytes => { if (!stream.destroyed) stream.write(bytes); });
        child.stderr.on("data", bytes => { if (!stream.destroyed) stream.stderr.write(bytes); });
        child.on("close", code => { if (!stream.destroyed) { stream.exit(code ?? 1); stream.end(); } });
        return;
      }
      const frame = () => {
        index++;
        const raw = `TMON_${token}_BEGIN\n#CPU\ncpu ${100 + index * 30} 0 ${index * 5} ${300 + index * 65} 0 0 0 0 0 0\n#UPTIME\n${3600 + index * 2}.00 0\n#MEM\nMemTotal: 8388608 kB\nMemAvailable: ${5000000 - index * 1000} kB\n#NET\neth0: ${index * 5000} 1 0 0 0 0 0 0 ${index * 3000} 1 0 0 0 0 0 0\nlo: ${index * 100} 1 0 0 0 0 0 0 ${index * 100} 1 0 0 0 0 0 0\n#DISK\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 104857600 41943040 62914560 40% /\n/dev/sdb1 209715200 125829120 83886080 60% /data\n#LOAD\n0.12 0.20 0.25 1/99 42\nTMON_${token}_END\n`;
        stream.write(raw.slice(0, 28)); stream.write(raw.slice(28));
        if (user === "drop" && index >= 2) { clearInterval(timer); stream.exit(1); stream.end(); }
      };
      timer = setInterval(frame, 600); frame();
    });
  })).on("error", () => {}).on("close", () => { clients.delete(client); for (const dispose of [...cleanups]) dispose(); });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const bin = path.join(root, "bin"); fs.mkdirSync(bin);
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nexec /usr/bin/ssh -F /dev/null -o IdentityAgent=none -o IdentityFile=${quote(path.join(root, "unused"))} -o UserKnownHostsFile=${quote(path.join(root, "known_hosts"))} "$@"\n`, { mode: 0o755 });
const info = { port: server.address().port, root, bin, container };
fs.writeFileSync(path.resolve("target/qa/monitor-fixture.json"), JSON.stringify(info));
async function cleanup() {
  for (const client of clients) client.destroy(); server.close();
  try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
if (process.argv.includes("--serve")) {
  console.log("monitor fixture ready:", JSON.stringify(info));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void cleanup().finally(() => process.exit(0)); });
} else {
  try {
    const child = spawn(path.resolve("target/debug/examples/monitor_smoke"), [String(info.port), root], { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH }, stdio: "inherit" });
    const timer = setTimeout(() => child.kill(), 90000);
    const code = await new Promise(resolve => child.on("exit", resolve)); clearTimeout(timer);
    if (code !== 0) throw new Error(`monitor smoke failed: ${code}`);
    await new Promise(resolve => setTimeout(resolve, 500));
    if (active !== 0 || clients.size !== 0) throw new Error(`monitor connections still active: ${active}, clients: ${clients.size}`);
  } finally { await cleanup(); }
}
