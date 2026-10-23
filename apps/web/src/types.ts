export interface UserDto {
  id: string;
  email: string;
  name: string | null;
}

/** 主机元数据：服务端永不返回凭据明文。 */
export interface SshHostMeta {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  hasPassphrase: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface HostInput {
  name?: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  /** 仅提交时存在：密码 或 私钥 PEM */
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** WebSocket 服务端帧 */
export type ServerFrame =
  | { type: "ready"; host: string; username: string }
  | { type: "data"; data: string }
  | { type: "hostkey"; fingerprint: string; firstUse: boolean }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "exit"; code?: number; signal?: string };
