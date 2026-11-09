import Link from "next/link";
import { headers } from "next/headers";
import { canViewTeam } from "@/server/guard";
import { teamById } from "@/engine/worlds";
import { FACTS, CHECK_ACTIONS, NOTIFICATION_EVENTS, SCENARIOS } from "@/engine/config/schemas";
import { NoAccess } from "../no-access";
import { BrandBar } from "@/components/brand";

export default async function Docs(props: PageProps<"/t/[team]/docs">) {
  const { team } = await props.params;
  if (!(await canViewTeam(team))) return <NoAccess />;
  const key = teamById(team)!.key;
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const base = `${origin}/api/w/${team}`;
  const basic = Buffer.from(`${team}:${key}`).toString("base64");

  return (
    <>
    <BrandBar subtitle="Developer API" />
    <main className="mx-auto w-full max-w-4xl px-4 py-6 text-sm leading-relaxed text-gray-800">
      <Link href={`/t/${team}/console`} className="text-xs text-gray-500 underline">
        ← Back to console
      </Link>
      <h1 className="mt-2 text-2xl font-semibold text-gray-900">API for coders</h1>
      <p className="mt-1 text-gray-600">
        Everything the console and assistant can do is also available over HTTP. Authenticate with your team key in the <code>x-team-key</code> header. Keep it within your team.
      </p>

      <div className="card mt-4 grid gap-1 p-4 font-mono text-xs">
        <div>
          <span className="text-gray-500">Base URL </span>
          {base}
        </div>
        <div>
          <span className="text-gray-500">Team key </span>
          {key}
        </div>
      </div>

      <Section title="1. Merchant-side track: telco APIs (MTN MoMo Open API shape)">
        <p>
          Each network exposes a collection and disbursement API at <code>{base}/momo/&#123;mtn|telecel|at&#125;</code>, modelled on the MTN MoMo Open API: OAuth-style token, <code>X-Reference-Id</code>, asynchronous
          status and callbacks. Your team owns a merchant wallet on each network (Team Shop). Telecel and AT use the same shape until their own specs arrive.
        </p>
        <Code>{`# 1. Get a token (API user = team id, API key = team key)
curl -X POST ${base}/momo/mtn/collection/token/ -H "Authorization: Basic ${basic}"

# 2. Request to Pay: the customer approves on their phone (*170# → 4)
curl -X POST ${base}/momo/mtn/collection/v1_0/requesttopay \\
  -H "Authorization: Bearer $TOKEN" -H "X-Reference-Id: $(uuidgen)" \\
  -H "X-Callback-Url: https://your-app.example/callback" -H "content-type: application/json" \\
  -d '{"amount":"25","currency":"GHS","externalId":"order-17","payer":{"partyIdType":"MSISDN","partyId":"233249900001"},"payerMessage":"Order 17","payeeNote":"thanks"}'

# 3. Poll status: PENDING → SUCCESSFUL | FAILED
curl ${base}/momo/mtn/collection/v1_0/requesttopay/$REF -H "Authorization: Bearer $TOKEN"

# Also: GET  /collection/v1_0/account/balance
#       GET  /collection/v1_0/accountholder/msisdn/{msisdn}/active
#       GET  /collection/v1_0/accountholder/msisdn/{msisdn}/basicuserinfo
#       POST /disbursement/v1_0/transfer      (pay out from your Team Shop wallet)
#       GET  /disbursement/v1_0/transfer/{referenceId}`}</Code>
        <p>Population members answer your payment requests after about one simulated minute. Featured personas (e.g. Akosua 0249900001) wait for a participant to approve on the sandbox phone.</p>
      </Section>

      <Section title="2. Telco-side track: control surfaces">
        <p>
          Five surfaces: <code>menus</code>, <code>rules</code>, <code>notifications</code>, <code>fraudChecks</code>, <code>scenarios</code>. Read with GET, replace with PUT <code>&#123;value, summary&#125;</code>, or
          patch with PATCH <code>&#123;operations, summary&#125;</code> (JSON Patch: add, replace, remove). Invalid configs are rejected with a list of errors; every change is recorded and can be undone.
        </p>
        <Code>{`curl ${base}/config/fraudChecks -H "x-team-key: ${key}"

curl -X PATCH ${base}/config/fraudChecks -H "x-team-key: ${key}" -H "content-type: application/json" -d '{
  "summary": "Hold big first-time transfers",
  "operations": [{ "op": "add", "path": "/checks/-", "value": {
    "id": "first_time_hold", "name": "Hold first-time transfers over GHS 500", "enabled": true,
    "appliesTo": ["p2p"], "action": "hold", "holdMinutes": 30,
    "when": { "all": [ { "fact": "recipient_is_new", "op": "==", "value": true }, { "fact": "amount", "op": ">", "value": 500 } ] }
  }}]}'

curl ${base}/history -H "x-team-key: ${key}"                         # changes + before/after impact
curl -X POST ${base}/history/{changeId} -H "x-team-key: ${key}"        # undo`}</Code>
        <p className="mt-2 font-medium">Check actions</p>
        <p>{CHECK_ACTIONS.join(" · ")} (precedence in that order)</p>
        <p className="mt-2 font-medium">Facts available to conditions</p>
        <ul className="grid gap-x-6 sm:grid-cols-2">
          {Object.entries(FACTS).map(([k, v]) => (
            <li key={k} className="py-0.5">
              <code className="text-xs">{k}</code> <span className="text-xs text-gray-500">{v}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 font-medium">Notification events</p>
        <p className="text-xs">{Object.keys(NOTIFICATION_EVENTS).join(" · ")}</p>
        <p className="mt-2 font-medium">Scenario ids</p>
        <p className="text-xs">{Object.keys(SCENARIOS).join(" · ")}</p>
      </Section>

      <Section title="3. Plug in your own model">
        <p>
          Set <code>fraudChecks.webhook</code> to <code>&#123;enabled: true, url, timeoutMs, failOpen&#125;</code>. Before every payment we POST <code>&#123;world, at, transaction, facts&#125;</code> to your URL; reply with{" "}
          <code>&#123;&quot;action&quot;: &quot;allow&quot; | &quot;block&quot; | &quot;hold&quot; | &quot;warn&quot; | &quot;require_second_factor&quot; | &quot;flag&quot;, &quot;reason&quot;: &quot;…&quot;, &quot;holdMinutes&quot;: 30&#125;</code>. Slow webhooks slow fast-forward.
        </p>
      </Section>

      <Section title="4. Data for analysis">
        <Code>{`curl "${base}/txns?limit=500" -H "x-team-key: ${key}"              # newest first; page with &before=<ISO time>
curl "${base}/txns?status=held" -H "x-team-key: ${key}"
curl ${base}/reports -H "x-team-key: ${key}"                         # scams customers reported (delayed, partial labels)
curl ${base}/state -H "x-team-key: ${key}"                           # clock, metrics, recent feed
curl -X POST ${base}/sim -H "x-team-key: ${key}" -H "content-type: application/json" -d '{"action":"fast_forward","hours":24}'
curl -X POST ${base}/ussd -H "x-team-key: ${key}" -H "content-type: application/json" -d '{"msisdn":"0249900001","input":"*170#"}'`}</Code>
        <p>Ground-truth fraud labels are never exposed. Scoring uses them on the organiser side.</p>
      </Section>
    </main>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 space-y-2">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 text-[11px] leading-relaxed text-gray-100">{children}</pre>;
}
