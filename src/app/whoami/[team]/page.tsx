import fs from "node:fs";
import { headers } from "next/headers";
import { teamById } from "@/engine/worlds";
import { consoleCookie, isOrganiser, phoneCookie, savedRole } from "@/server/http";

/**
 * A plain page that says what this device is, for sorting out access problems:
 * /whoami/{team}. It shows no keys, so it is safe to read out or send to someone.
 */
export default async function WhoAmI(props: PageProps<"/whoami/[team]">) {
  const { team } = await props.params;
  const t = teamById(team);
  const h = await headers();
  const kept = (h.get("cookie") ?? "").split(";").map((c) => c.split("=")[0].trim()).filter((n) => n.startsWith("momo_"));
  const role = t ? savedRole(t, h.get("cookie")) : undefined;
  let version = "unknown";
  try {
    version = fs.readFileSync(".next/.built-commit", "utf8").trim().slice(0, 7);
  } catch {}
  const rows: [string, string][] = [
    ["Team", t ? t.name : `${team} (no such team)`],
    ["This device can open", role === "team" ? "the consoles, and the phone and agent screens" : role === "customer" ? "only the customer phone" : role === "agent" ? "only the agent screens" : "nothing yet"],
    ["Opened the team link", t && kept.includes(consoleCookie(t.id)) ? "yes" : "no"],
    ["Opened a phone code", t && kept.includes(phoneCookie(t.id)) ? "yes" : "no"],
    ["Signed in as organiser", (await isOrganiser()) ? "yes" : "no"],
    ["Kept by this browser", kept.length ? kept.join(", ") : "nothing"],
    ["Address this device used", `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`],
    ["Address the sandbox gives out", process.env.PUBLIC_URL ?? "(not set)"],
    ["Sandbox version", version],
    ["Time on the server", new Date().toISOString()],
  ];
  return (
    <main className="mx-auto w-full max-w-lg px-4 py-8">
      <h1 className="text-xl font-semibold text-gray-900">What this device is</h1>
      <p className="mt-1 text-sm text-gray-600">No keys are shown here, so this page is safe to copy and send.</p>
      <dl className="card mt-4 divide-y divide-gray-100 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 px-4 py-2">
            <dt className="text-gray-500">{k}</dt>
            <dd className="break-all text-right font-medium text-gray-900">{v}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
