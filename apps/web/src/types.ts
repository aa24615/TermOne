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
  /** 服务端是否持有加密凭据。false = 连接时需客户端临时提供（默认策略） */
  hasCredential: boolean;
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
  /**
   * 明文：密码 或 私钥 PEM。
   * **缺省 = 不上传**（默认策略）：服务端只登记元数据。
   */
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** true = 删除服务端已保存的凭据（用户取消勾选「保存到服务端」） */
  clearCredential?: boolean;
}

/** WebSocket 服务端帧 */
export type ServerFrame =
  | { type: "ready"; host: string; username: string }
  | { type: "data"; data: string }
  | { type: "hostkey"; fingerprint: string; firstUse: boolean }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "exit"; code?: number; signal?: string };
