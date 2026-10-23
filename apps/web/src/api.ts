import type { HostInput, SshHostMeta, UserDto } from "./types";

const TOKEN_KEY = "termone.web.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const hasBody = init.body !== undefined && init.body !== null;
  const headers: Record<string, string> = {
    // 仅在带 body 时声明 JSON：DELETE 等无 body 请求不声明，
    // 否则 Fastify 会因「content-type 是 json 但 body 为空」返回 400。
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 401) {
    clearToken();
    throw new Error("登录已过期，请重新登录");
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `请求失败（${res.status}）`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; user: UserDto }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, name?: string) =>
    request<{ token: string; user: UserDto }>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, name }),
    }),

  me: () => request<{ user: UserDto }>("/me"),

  listHosts: () => request<{ hosts: SshHostMeta[] }>("/ssh/hosts"),

  createHost: (input: HostInput) =>
    request<{ id: string }>("/ssh/hosts", { method: "POST", body: JSON.stringify(input) }),

  updateHost: (id: string, input: HostInput) =>
    request<{ ok: boolean }>(`/ssh/hosts/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  deleteHost: (id: string) => request<{ ok: boolean }>(`/ssh/hosts/${id}`, { method: "DELETE" }),
};
