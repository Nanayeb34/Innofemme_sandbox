import Link from "next/link";
import { headers } from "next/headers";
import { BrandBar } from "@/components/brand";
import { canViewTeam } from "@/server/guard";
import { SYSTEM_PATHS } from "@/server/systems";
import { teamById } from "@/engine/worlds";
import { SURFACE_NAMES } from "@/engine/config/schemas";
import NoAccess from "../no-access";

export default async function Docs(props: PageProps<"/t/[team]/docs">) {
  const { team } = await props.params;
  if (!(await canViewTeam(team))) return <NoAccess />;
  const key = teamById(team)?.key ?? "<organiser key>";
  const h = await headers();
  const origin = process.env.PUBLIC_URL || `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const base = `${origin}/api/w/${team}`;
  const basic = Buffer.from(`${team}:${key}`).toString("base64");
  const auth = `-H "x-team-key: ${key}"`;
  const json = `-H "content-type: application/json"`;

  return (
    <>
      <BrandBar subtitle="Developer API" />
      <main className="mx-auto w-full max-w-4xl px-4 py-6 text-sm leading-relaxed text-gray-800">
        <Link href={`/t/${team}`} className="text-xs text-gray-500 underline">
          ← All systems
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-gray-900">API for coders</h1>
        <p className="mt-1 text-gray-600">
          Everything the consoles do is also available over HTTP, one endpoint per institution. Authenticate with your team key in the <code>x-team-key</code> header. Keep it within your team.
        </p>

        <div className="card mt-4 grid gap-1 break-all p-4 font-mono text-xs">
          <div>
            <span className="text-gray-500">Base URL </span>
            {base}
          </div>
          <div>
            <span className="text-gray-500">Team key </span>
            {key}
          </div>
        </div>

        <Section title="1. One endpoint per institution">
          <p className="break-words">
            <code>GET {"{base}"}/s/{"{system}"}</code> returns what that institution&apos;s console shows. <code>POST</code> with <code>{"{ action, ...fields }"}</code> does something there. Systems: {SYSTEM_PATHS.map((p) => <code key={p} className="mr-1 break-all">{p}</code>)}
          </p>
          <Code>{`# NIA issues a Ghana Card
curl -X POST ${base}/s/nia ${auth} ${json} -d '{"action":"enrol","firstNames":"Ama","surname":"Owusu","dob":"1994-03-12","gender":"F","region":"Ashanti","town":"Kumasi"}'

# MTN adds SIM stock and authorises a service centre
curl -X POST ${base}/s/telco/mtn ${auth} ${json} -d '{"action":"add_sims","count":10}'
curl -X POST ${base}/s/telco/mtn ${auth} ${json} -d '{"action":"onboard_sim_agent","kind":"service_centre","name":"Adum Service Centre","town":"Kumasi","card":"GHA-…"}'

# The service centre registers a SIM (card + fingerprint are checked with NIA)
curl -X POST ${base}/s/sim-agent/mtn ${auth} ${json} -d '{"action":"register","agent":"MTN-SC-0001","card":"GHA-…","fingerprint":"FP-…"}'

# Read any console
curl ${base}/s/telco/mtn ${auth}
curl ${base}/s/switch ${auth}`}</Code>
          <p>Send an unknown action to a system and the error lists the actions it supports.</p>
        </Section>

        <Section title="2. Phones (USSD)">
          <p>Drive any registered SIM. Start a session by sending the short code; pass the returned <code>sessionId</code> with each reply.</p>
          <Code>{`curl -X POST ${base}/ussd ${auth} ${json} -d '{"msisdn":"024…","input":"*170#"}'
curl -X POST ${base}/ussd ${auth} ${json} -d '{"msisdn":"024…","sessionId":"ussd_…","input":"1"}'`}</Code>
        </Section>

        <Section title="3. Settings">
          <p className="break-words">
            Each institution owns one settings document: {SURFACE_NAMES.map((s) => <code key={s} className="mr-1 break-all">{s}</code>)}. Read it, replace it, or patch it with JSON Patch (<code>add</code>, <code>replace</code>, <code>remove</code>). Every change is validated, recorded and can be undone.
          </p>
          <Code>{`curl ${base}/config/telco.mtn ${auth}
curl -X PATCH ${base}/config/bog ${auth} ${json} -d '{
  "summary": "Raise the minimum-KYC daily limit",
  "operations": [{"op":"replace","path":"/kycTiers/minimum/daily","value":5000}]
}'
curl ${base}/history ${auth}                       # changes, newest first
curl -X POST ${base}/history/{changeId} ${auth}     # undo`}</Code>
        </Section>

        <Section title="4. Merchant API (MTN MoMo Open API shape)">
          <p className="break-words">
            Each network exposes a collection and disbursement API at <code className="break-all">{base}/momo/&#123;mtn|telecel|at&#125;</code>: OAuth-style token, <code>X-Reference-Id</code>, asynchronous status and callbacks. You act as a merchant the telco has onboarded: send its merchant ID in <code>X-Merchant-Id</code>. A Request to Pay appears on the payer&apos;s phone under option 4, where they approve it with their PIN. Telecel and AT use the same shape until their own specifications arrive.
          </p>
          <Code>{`curl -X POST ${base}/momo/mtn/collection/token/ -H "Authorization: Basic ${basic}"

REF=$(uuidgen)
curl -X POST ${base}/momo/mtn/collection/v1_0/requesttopay \\
  -H "Authorization: Bearer $TOKEN" -H "X-Reference-Id: $REF" -H "X-Merchant-Id: 100001" ${json} \\
  -d '{"amount":"25","currency":"GHS","externalId":"order-1","payer":{"partyIdType":"MSISDN","partyId":"233241234567"},"payerMessage":"Order 1"}'
curl ${base}/momo/mtn/collection/v1_0/requesttopay/$REF -H "Authorization: Bearer $TOKEN"

# also: POST disbursement/v1_0/transfer, GET …/account/balance, GET …/accountholder/msisdn/{number}/active`}</Code>
        </Section>

        <Section title="5. Text messages">
          <p>
            A business sends a text to a customer from its own software at <code className="break-all">{base}/sms/&#123;mtn|telecel|at&#125;</code>. As with the merchant API, you act as a merchant that network has onboarded (<code>X-Merchant-Id</code>). The text arrives under the merchant&apos;s registered name, shortened to 11 letters and digits, and the customer cannot reply to it. Texts are at most 480 characters.
          </p>
          <Code>{`curl -X POST ${base}/sms/mtn ${auth} -H "X-Merchant-Id: 100001" ${json} -d '{"to":"0241234567","text":"Your order is ready."}'
# → {"status":"delivered","parts":1,"senderId":"AmasProvisi","to":"0241234567"}   (or "failed" with a reason)
curl ${base}/sms/mtn ${auth} -H "X-Merchant-Id: 100001"      # what this merchant has sent

# A person's phone can also be driven from code
curl -X POST ${base}/s/phone ${auth} ${json} -d '{"action":"sms_send","msisdn":"024…","to":"027…","text":"Hello"}'
curl "${base}/s/phone?msisdn=024…&thread=027…" ${auth}       # that phone's conversations, and one thread
curl ${base}/s/telco/mtn ${auth}                             # includes the network's SMS records under "sms"`}</Code>
        </Section>

        <Section title="6. Save points">
          <Code>{`curl -X POST ${base}/snapshots ${auth} ${json} -d '{"label":"Before changing fees"}'
curl ${base}/snapshots ${auth}
curl -X POST ${base}/snapshots/{id} ${auth}          # roll back
curl -X POST ${base}/world ${auth} ${json} -d '{"action":"reset"}'   # wipe to an empty country`}</Code>
        </Section>
      </main>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 space-y-2">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs leading-relaxed text-gray-100">{children}</pre>;
}
