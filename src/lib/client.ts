"use client";

export async function api<T = unknown>(team: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/w/${team}${path}`, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, data.details);
  return data as T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public details?: string[],
  ) {
    super(message);
  }
}

export const ghs = (n: number) => `GH₵${n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

export function simClock(iso: string, withDay = true) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return withDay ? `${day} ${time}` : time;
}
