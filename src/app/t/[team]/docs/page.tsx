import Link from "next/link";
import { BrandBar } from "@/components/brand";
import { canViewTeam } from "@/server/guard";
import { pageOrigin } from "@/server/qr";
import { SYSTEM_PATHS } from "@/server/systems";
import { teamById } from "@/engine/worlds";
import { SURFACE_NAMES } from "@/engine/config/schemas";
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
        <p className="mt-1 text-gray-600">There are two kinds of API here, and they are for different jobs.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-700">
          <li>
            <b>Partner APIs</b> (sections 1 to 6) are what an institution gives an outside company, such as a licensed payments or messaging business. You call them with credentials that institution issued, not with your team key. Build a third-party product on these.
          </li>
          <li>
            <b>Console API</b> (sections 7 to 10) does everything the consoles do, with your team key. Use it to set up your world from a script, or when your team is acting as the institution itself.
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

        <Section title="7. Console API: one endpoint per institution">
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

        <Section title="8. Phones">
          <p>Drive any registered SIM. Start a USSD session by sending the short code; pass the returned <code>sessionId</code> with each reply.</p>
          <Code>{`curl -X POST ${base}/ussd ${auth} ${json} -d '{"msisdn":"024…","input":"*170#"}'
curl -X POST ${base}/ussd ${auth} ${json} -d '{"msisdn":"024…","sessionId":"ussd_…","input":"1"}'
curl -X POST ${base}/s/phone ${auth} ${json} -d '{"action":"sms_send","msisdn":"024…","to":"027…","text":"Hello"}'
curl "${base}/s/phone?msisdn=024…&thread=027…" ${auth}       # that phone's conversations, and one thread`}</Code>
        </Section>

        <Section title="9. Settings">
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

        <Section title="10. Save points">
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
