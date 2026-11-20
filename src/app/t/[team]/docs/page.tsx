import Link from "next/link";
import { BrandBar } from "@/components/brand";
import { canViewTeam } from "@/server/guard";
import { pageOrigin } from "@/server/qr";
import { SYSTEM_PATHS } from "@/server/systems";
import { teamById } from "@/engine/worlds";
import { SURFACE_NAMES } from "@/engine/config/schemas";
import { DATASET_FILES } from "@/engine/dataset";
import { EVENTS, POINTS, SAMPLES } from "@/engine/integrations";
import { SCENARIOS } from "@/engine/simulate";
import { BANK_IDS } from "@/engine/util";
import NoAccess from "../no-access";

export default async function Docs(props: PageProps<"/t/[team]/docs">) {
  const { team } = await props.params;
  if (!(await canViewTeam(team))) return <NoAccess />;
  const key = teamById(team)?.key ?? "<organiser key>";
  const base = `${await pageOrigin()}/api/w/${team}`;
  const auth = `-H "x-team-key: ${key}"`;
  const json = `-H "content-type: application/json"`;
  const partner = `-u "$CLIENT_ID:$API_KEY"`;

  return (
    <>
      <BrandBar subtitle="Developer API" />
      <main className="mx-auto w-full max-w-4xl px-4 py-6 text-sm leading-relaxed text-gray-800">
        <Link href={`/t/${team}`} className="text-xs text-gray-500 underline">
          ← All systems
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-gray-900">API for coders</h1>
        <p className="mt-1 text-gray-600">There are three kinds of API here, and they are for different jobs.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-700">
          <li>
            <b>Partner APIs</b> (sections 1 to 6) are what an institution gives an outside company, such as a licensed payments or messaging business. You call them with credentials that institution issued, not with your team key. Build a third-party product on these.
          </li>
          <li>
            <b>Plug-in points</b> (section 7) work the other way round: <em>you</em> build an API, and a network or bank plugs it into one of its own steps. It asks your API every time that step happens and does what you answer. Build this when your product is something an institution would
            add to its own system.
          </li>
          <li>
            <b>Console API</b> (sections 8 to 12) does everything the consoles do, with your team key. Use it to set up your world from a script, or when your team is acting as the institution itself.
          </li>
        </ul>

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

        <Section title="1. Getting partner credentials">
          <p>
            Each institution issues its own. Open its console, go to <b>API partners</b>, and give a company access: a network, a bank, the national switch, or NIA. You get a <b>client ID</b> and an <b>API key</b> that work only on that institution&apos;s API. A network can tie the company to a merchant wallet (needed for payments); a bank ties it to an account.
          </p>
          <p>Send them on every call with HTTP Basic, or swap them once for a bearer token at the institution&apos;s token endpoint.</p>
          <Code>{`CLIENT_ID=…   API_KEY=…                               # from the institution's API partners tab

curl ${base}/network/mtn/v1/subscribers/0241234567 ${partner}          # Basic on each call
TOKEN=$(curl -s -X POST ${base}/network/mtn/token ${partner} | jq -r .access_token)
curl ${base}/network/mtn/v1/subscribers/0241234567 -H "Authorization: Bearer $TOKEN"`}</Code>
        </Section>

        <Section title="2. Mobile money API (MTN MoMo Open API shape)">
          <p>
            At <code className="break-all">{base}/momo/&#123;mtn|telecel|at&#125;</code>. Collection takes money from customers; disbursement and remittance pay it out. Each request carries your own <code>X-Reference-Id</code>, returns <code>202</code>, and is finished later: ask for its status, or receive it at your callback address. Telecel and AT use the same shape until their own specifications arrive.
          </p>
          <Code>{`TOKEN=$(curl -s -X POST ${base}/momo/mtn/collection/token/ ${partner} | jq -r .access_token)
B="-H \\"Authorization: Bearer $TOKEN\\""

# Collection
POST collection/v1_0/requesttopay            {amount, currency, externalId, payer:{partyIdType:"MSISDN", partyId}, payerMessage, payeeNote}
GET  collection/v1_0/requesttopay/{ref}      → status PENDING | SUCCESSFUL | FAILED
POST collection/v1_0/requesttopay/{ref}/deliverynotification   {notificationMessage}   a text to the payer after a successful payment
POST collection/v1_0/requesttowithdraw       same body; GET …/requesttowithdraw/{ref}
POST collection/v2_0/preapproval             {payer, payerCurrency, payerMessage, validityTime}   permission to charge without asking each time
GET  collection/v2_0/preapproval/{ref}       DELETE to cancel it
GET  collection/v1_0/account/balance
GET  collection/v1_0/accountholder/msisdn/{number}/active
GET  collection/v1_0/accountholder/msisdn/{number}/basicuserinfo      the name on the wallet

# A customer's full profile, with their consent
POST collection/v1_0/bc-authorize            form: scope=profile&login_hint=ID:{number}/MSISDN  → auth_req_id
POST collection/oauth2/token/                form: grant_type=urn:openid:params:grant-type:ciba&auth_req_id=…  (authorization_pending until they agree)
GET  collection/oauth2/v1_0/userinfo         with that token: name, date of birth, sex, town, KYC tier

# Disbursement (remittance/v1_0/transfer works the same way)
POST disbursement/v1_0/transfer              {amount, currency, externalId, payee:{partyIdType:"MSISDN", partyId}, payerMessage, payeeNote}
POST disbursement/v2_0/deposit               same body
POST disbursement/v1_0/refund                {amount, currency, referenceIdToRefund}   gives back all or part of a payment you collected, with no fee
GET  disbursement/v1_0/{transfer|deposit|refund}/{ref}`}</Code>
          <p>
            A request to pay, a pre-approval and a profile request all appear on the customer&apos;s phone under option 4, where they agree with their PIN or refuse. Once a pre-approval is granted, a request to pay from the same partner to that customer completes without asking.
          </p>
          <p>
            As on MTN&apos;s developer portal, you can also create credentials from code with your team key: <code>POST momo/&#123;telco&#125;/v1_0/apiuser</code> (with <code>X-Reference-Id</code> and <code>X-Merchant-Id</code>), then <code>POST …/apiuser/&#123;id&#125;/apikey</code>.
          </p>
        </Section>

        <Section title="3. Network API: texts, subscriber checks, USSD">
          <p>
            At <code className="break-all">{base}/network/&#123;mtn|telecel|at&#125;</code>. A network answers only for its own numbers.
          </p>
          <Code>{`POST v1/sms/messages            {to, text}                       a text under your registered sender name (first 11 letters and digits of the company name)
GET  v1/sms/messages                                             what you have sent
GET  v1/subscribers/{number}                                     the name the SIM is registered to, its status, and whether it has a wallet
POST v1/sim-swap/check          {phoneNumber, maxAge}            was the SIM replaced in the last maxAge hours? → {swapped}
POST v1/sim-swap/retrieve-date  {phoneNumber}                    → {latestSimChange}
POST v1/kyc-match               {phoneNumber, name, givenName, familyName, birthdate, idDocument, gender}   → "true" | "false" per field sent

curl -X POST ${base}/network/mtn/v1/sim-swap/check ${partner} ${json} -d '{"phoneNumber":"0241234567","maxAge":240}'`}</Code>
          <p>
            Subscriber details and texts are what networks give licensed partners in Ghana today. The SIM-swap and KYC-match checks are offered by MTN in other countries; we could not confirm them for Ghana, so treat them as what a network could offer.
          </p>
          <p>
            <b>Your own USSD service.</b> The NCA console allocates a short code to you with the address of your application, and each network switches it on (back office → API partners). When a subscriber dials the code, the network sends every step to your address as JSON and shows your answer.
          </p>
          <Code>{`# The network POSTs to your address:
{"sessionId":"ussd_…","serviceCode":"*714#","msisdn":"0241234567","network":"mtn","newSession":true,"input":"","text":""}
# "input" is what the subscriber just typed; "text" is everything typed so far, joined with *

# Answer with JSON …
{"message":"Welcome\\n1) Check order\\n2) Exit","continueSession":true}
# … or plain text starting with CON (more to come) or END (finished)
CON Welcome\\n1) Check order\\n2) Exit`}</Code>
          <p>Your application must answer within 3 seconds, or the subscriber is told the service is not responding.</p>
        </Section>

        <Section title="4. Bank API">
          <p>
            At <code className="break-all">{base}/bank/&#123;{BANK_IDS.join("|")}&#125;</code>. Every call acts on the account the bank tied to your credentials.
          </p>
          <Code>{`GET  v1/account                                                  account number, name and balance
GET  v1/account/transactions?limit=50                            statement, newest first
POST v1/name-enquiry        {accountNumber}                      the name on an account at any bank
POST v1/transfers           {toAccountNumber, amount, narration} to any bank account (another bank goes through the switch)
POST v1/wallet-transfers    {msisdn, amount, narration}          to a mobile money wallet on any network
GET  v1/transfers/{id}                                           status of a transfer you made`}</Code>
        </Section>

        <Section title="5. National switch API (GhIPSS)">
          <p>
            At <code className="break-all">{base}/ghipss</code>, for licensed institutions. Payments are not sent here directly: send them through your bank or network, which routes them through the switch.
          </p>
          <Code>{`GET  v1/participants                                             banks and networks on the switch, and whether each is connected
POST v1/name-enquiry        {accountNumber} or {msisdn}          which institution holds it, and the name on it
GET  v1/transactions/{id}                                        status of a routed payment, with the switch's messages`}</Code>
        </Section>

        <Section title="6. NIA identity verification">
          <p>
            At <code className="break-all">{base}/nia</code>, for certified institutions. Every request is on NIA&apos;s log.
          </p>
          <Code>{`POST v1/verify   {cardNumber}                         → {valid}                     is this a valid Ghana Card?
POST v1/verify   {cardNumber, fingerprint, purpose}   → {valid, biometricMatch, person}   a biometric check; the holder's details come back only on a match`}</Code>
        </Section>

        <Section title="7. Plug-in points: your API inside an institution's system" id="plugins">
          <p>
            Put your API online, then open the console of a network, a bank or the national switch, go to <b>Plug-ins</b>, and enter its address and the step it should be asked at. From then on the institution sends a <code>POST</code> with a JSON body to your address every time that step
            happens, waits for your answer (2 seconds by default), and acts on it. The same tab shows every question it asked and what you answered, and has a <b>Send a test</b> button.
          </p>
          <Code>{`# What you receive
{ "point": "pin.set", "institution": "mtn", "world": "${team}", "at": "2026-11-26T10:15:00.000Z", "data": { … } }

# What you answer (status 200, JSON)
{ "decision": "allow" }
{ "decision": "reject", "message": "Shown to the customer. Keep it short: a phone screen holds about 150 characters." }
{ "decision": "warn",   "message": "Shown first. The customer then chooses 1) Continue or 2) Cancel." }
{ "decision": "delay",  "minutes": 10, "message": "The payment is refused now and can be tried again after the pause." }`}</Code>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className="border-b border-gray-200 text-[11px] uppercase tracking-wide text-gray-500">
                  <th className="px-2 py-2 font-medium">Step</th>
                  <th className="px-2 py-2 font-medium">Who asks</th>
                  <th className="px-2 py-2 font-medium">When</th>
                  <th className="px-2 py-2 font-medium">You can answer</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(POINTS).map(([id, p]) => (
                  <tr key={id} className="border-b border-gray-100 align-top">
                    <td className="px-2 py-2 font-mono">{id}</td>
                    <td className="px-2 py-2">{p.who.map((x) => (x === "telco" ? "a network" : x === "bank" ? "a bank" : "the national switch")).join(", ").replace(/^a/, "A")}</td>
                    <td className="px-2 py-2">{p.when}</td>
                    <td className="px-2 py-2">{p.answers.join(", ") || "nothing"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <b>Who is asked.</b> For a payment leaving a wallet, the payer&apos;s network (<code>payment.authorize</code>); for money arriving, the payee&apos;s network or bank (<code>payment.receive</code>); between two institutions, also the national switch. For a
              request to approve a payment, the network of the customer being asked. For a text or a call, the network of the person receiving it. For a bank transfer, the bank the money is leaving.
            </li>
            <li>
              <b>warn</b> is shown where the customer is looking at a screen: before the phone menu opens, on a payment from the phone menu, as a label on a text, and on the incoming call screen. On a payment with nobody there to read it (through an API, or at an
              agent) it counts as allow.
            </li>
            <li>
              <b>delay</b> pauses payments from that payer to that payee. Asked again after the pause, you receive <code>afterDelay: true</code>.
            </li>
            <li>
              <b>If you do not answer</b> in time, or answer with something else, the institution does what its owner chose when plugging you in: carry on as normal, or refuse. Several APIs on one step: the strictest answer wins.
            </li>
            <li>
              <b>events</b> are told to you after the fact, as <code>data.event</code>: {Object.keys(EVENTS).map((e) => <code key={e} className="mr-1 break-all">{e}</code>)}. Your answer is ignored.
            </li>
            <li>Amounts are in cedis. Your API can call anything else it likes while deciding, including the partner APIs above.</li>
          </ul>
          <p>What <code>data</code> holds at each step:</p>
          {Object.entries(SAMPLES).map(([id, sample]) => (
            <details key={id} className="rounded-lg border border-gray-200 px-3 py-2">
              <summary className="cursor-pointer font-mono text-xs">
                {id} <span className="font-sans text-gray-500">· {POINTS[id].when}</span>
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-gray-900 p-3 font-mono text-xs leading-relaxed text-gray-100">{JSON.stringify(sample, null, 2)}</pre>
            </details>
          ))}
          <p>
            A starting point is in the repository: <code>examples/starter-api.mjs</code> answers &quot;allow&quot; to everything and prints what it was sent. Plug an API in from a script:
          </p>
          <Code>{`curl -X POST ${base}/s/telco/mtn ${auth} ${json} -d '{"action":"plugin_add","name":"My API","point":"payment.authorize","url":"https://your-api.example.com/","ifDown":"carry_on"}'`}</Code>
        </Section>

        <Section title="8. Console API: one endpoint per institution">
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

# MTN gives a company API access (the answer carries its client ID and API key)
curl -X POST ${base}/s/telco/mtn ${auth} ${json} -d '{"action":"api_partner_create","name":"PayLink Ghana","till":"100001"}'

# Read any console
curl ${base}/s/telco/mtn ${auth}
curl ${base}/s/switch ${auth}`}</Code>
          <p>Send an unknown action to a system and the error lists the actions it supports.</p>
        </Section>

        <Section title="9. Phones">
          <p>Drive any registered SIM. Start a USSD session by sending the short code; pass the returned <code>sessionId</code> with each reply.</p>
          <Code>{`curl -X POST ${base}/ussd ${auth} ${json} -d '{"msisdn":"024…","input":"*170#"}'
curl -X POST ${base}/ussd ${auth} ${json} -d '{"msisdn":"024…","sessionId":"ussd_…","input":"1"}'
curl -X POST ${base}/s/phone ${auth} ${json} -d '{"action":"sms_send","msisdn":"024…","to":"027…","text":"Hello"}'
curl "${base}/s/phone?msisdn=024…&thread=027…" ${auth}       # that phone's conversations, and one thread`}</Code>
        </Section>

        <Section title="10. Settings">
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

        <Section title="11. Save points">
          <Code>{`curl -X POST ${base}/snapshots ${auth} ${json} -d '{"label":"Before changing fees"}'
curl ${base}/snapshots ${auth}
curl -X POST ${base}/snapshots/{id} ${auth}          # roll back
curl -X POST ${base}/world ${auth} ${json} -d '{"action":"reset"}'   # wipe to an empty country`}</Code>
        </Section>

        <Section title="12. Simulated data" id="dataset">
          <p>
            A world can be filled with a ready-made country and three months of history: people with Ghana Cards, registered numbers, wallets, agents, merchants, bank accounts, calls, texts, complaints, and 100,023 transactions, 22% of them fraud of
            ten kinds. Load it from your team&apos;s home page, or here. It replaces what is in the world; what was there is kept as a save point.
          </p>
          <Code>{`curl -X POST ${base}/world ${auth} ${json} -d '{"action":"simulate"}'     # load it (up to a minute the first time)
curl ${base}/dataset ${auth}                                              # what it holds, the kinds of fraud, and the files
curl ${base}/dataset/transactions.csv ${auth} -o transactions.csv          # every transaction, with is_fraud, fraud_scenario, fraud_role, fraud_case
curl "${base}/dataset/transactions.csv?answers=0" ${auth} -o blind.csv     # the same without those four columns`}</Code>
          <p className="break-words">
            Files: {Object.entries(DATASET_FILES).map(([name, f]) => (
              <span key={name} className="mr-2">
                <code>{name}.csv</code> ({f.about.charAt(0).toLowerCase() + f.about.slice(1)}).
              </span>
            ))}
          </p>
          <p>
            Transactions join to the other files by number: <code>payer_number</code> and <code>payee_number</code> are in <code>wallets.csv</code>, <code>sims.csv</code>, <code>calls.csv</code> and <code>texts.csv</code>; <code>ghana_card</code> links
            a number to its owner in <code>people.csv</code>. Transactions of one fraud case share a <code>fraud_case</code>, and <code>fraud_role</code> says what part each played. The kinds of fraud:
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {Object.entries(SCENARIOS).map(([id, about]) => (
              <li key={id}>
                <code>{id}</code>: {about}.
              </li>
            ))}
          </ul>
          <p>The data is in the live world too: every console shows it, every simulated person&apos;s phone can be opened, and whatever you do next is added on top.</p>
        </Section>
      </main>
    </>
  );
}

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mt-6 scroll-mt-4 space-y-2">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      {children}
    </section>
  );
}

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-lg bg-gray-900 p-3 font-mono text-xs leading-relaxed text-gray-100">{children}</pre>;
}
