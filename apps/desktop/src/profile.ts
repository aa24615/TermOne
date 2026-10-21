import type {
  LocalProfileConfig,
  ProfileConfig,
  ProfileKind,
  ProfileRow,
  SerialProfileConfig,
  SessionRequest,
  SshProfileConfig,
} from "./types";

export function defaultConfig(kind: ProfileKind): ProfileConfig {
  switch (kind) {
    case "local":
      return { args: [] } satisfies LocalProfileConfig;
    case "ssh":
      return { host: "", port: 22, user: "", auth: "password" } satisfies SshProfileConfig;
    case "serial":
      return {
        path: "",
        baud: 115200,
        dataBits: 8,
        parity: "none",
        stopBits: 1,
        flowControl: "none",
      } satisfies SerialProfileConfig;
  }
}

export function defaultProfileName(kind: ProfileKind, config: ProfileConfig): string {
  switch (kind) {
    case "local":
      return "本地 Shell";
    case "ssh": {
      const c = config as SshProfileConfig;
      return c.host ? `SSH ${c.host}` : "SSH 连接";
    }
    case "serial": {
      const c = config as SerialProfileConfig;
      return c.path ? `串口 ${c.path}` : "串口连接";
    }
  }
}

export function profileSubtitle(p: ProfileRow): string {
  const c = p.config as Record<string, unknown>;
  switch (p.kind) {
    case "local":
      return (c.shell as string) || "系统默认 Shell";
    case "ssh": {
      const user = c.user as string | undefined;
      const port = c.port as number | undefined;
      const host = (c.host as string) || "-";
      return `${user ? `${user}@` : ""}${host}${port && port !== 22 ? `:${port}` : ""}`;
    }
    case "serial":
      return `${(c.path as string) || "-"} · ${(c.baud as number) || 115200}`;
  }
}

export function buildSessionRequest(profile?: ProfileRow): SessionRequest {
  if (!profile) return { kind: "local", args: [] };
  switch (profile.kind) {
    case "local": {
      const c = profile.config as LocalProfileConfig;
      let args = c.args ?? [];
      if (c.preset === "docker") {
        const image = (c.image ?? "").trim();
        args = image ? ["run", "--rm", "-it", image] : ["run", "--rm", "-it"];
      } else if (c.preset === "ssh") {
        const target = (c.target ?? "").trim();
        args = target ? ["-t", target] : [];
      }
      return {
        kind: "local",
        shell: c.shell || undefined,
        args,
        cwd: c.cwd || undefined,
      };
    }
    case "ssh": {
      const c = profile.config as SshProfileConfig;
      return {
        kind: "ssh",
        host: c.host,
        port: c.port || 22,
        user: c.user || undefined,
        auth:
          c.auth === "key"
            ? { type: "key", identityFile: c.identityFile ?? "" }
            : { type: c.auth },
        command: undefined,
      };
    }
    case "serial": {
      const c = profile.config as SerialProfileConfig;
      return {
        kind: "serial",
        path: c.path,
        baud: c.baud,
        dataBits: c.dataBits,
        parity: c.parity,
        stopBits: c.stopBits,
        flowControl: c.flowControl,
      };
    }
  }
}
