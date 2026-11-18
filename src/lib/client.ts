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

export const ghs = (n: number) => `${n < 0 ? "−" : ""}GH₵${Math.abs(n).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function when(iso: string | null | undefined, withDay = true) {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return withDay ? `${day} ${time}` : time;
}

export const teamName = (team: string) => (team === "organiser" ? "Organiser world" : team.replace("team-", "Team "));
