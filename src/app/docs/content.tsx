import Link from "next/link";
import { CopyCode, CopyValue, DocsHeader, DocsNav, ToTop, type ContentsPart } from "./chrome";
import { pageOrigin } from "@/server/qr";
import { KITS, kitSource } from "@/server/starter";
import { SYSTEM_PATHS } from "@/server/systems";
import { getWorld, teamById } from "@/engine/worlds";
import { getConfig } from "@/engine/config/store";
import { defaultTelco } from "@/engine/config/defaults";
import { approvalsPath, approvalsPathIn } from "@/engine/services";
import { sharedServer } from "@/engine/outside";
import { SURFACE_NAMES } from "@/engine/config/schemas";
import { DATASET_FILES } from "@/engine/dataset";
import { FRAUD_KINDS } from "@/engine/fraudsim";
import { EVENTS, POINTS, SAMPLES } from "@/engine/integrations";
import { SCENARIOS } from "@/engine/simulate";
import { BANK_IDS, TELCOS, TELCO_INFO } from "@/engine/util";

/** "team-01" as people say it. (The same as the client helper, which a server page cannot call.) */
const teamName = (team: string) => (team === "organiser" ? "Organiser world" : team.replace("team-", "Team "));

/** What is on the page, in order. The contents column and the drop-down on small screens are made from this. */
const CONTENTS: ContentsPart[] = [
  {
    title: "1 · Start here",
    items: [["start", "What the sandbox is"], ["first", "Your first 15 minutes"], ["words", "Words you will see"], ["systems", "What each screen is"], ["assistant", "The assistant"]],
  },
  {
    title: "2 · Build",
    items: [["products", "Two ways to build"], ["developer", "Developer console"], ["kits", "Starter kits"], ["kit-plugin", "Run a plug-in API"], ["kit-app", "Run an application"], ["reach", "Where your API has to be"], ["bridge", "The bridge"]],
  },
  {
    title: "3 · API reference",
    items: [
      ["reference", "Which API is for what"], ["credentials", "1. Partner credentials"], ["momo", "2. Mobile money API"], ["network", "3. Network API"], ["bank", "4. Bank API"], ["switch", "5. National switch API"], ["nia", "6. NIA verification"],
      ["plugins", "7. Plug-in points"], ["console", "8. Console API"], ["phones", "9. Phones"], ["settings", "10. Settings"], ["savepoints", "11. Save points"], ["dataset", "12. Simulated data"], ["fraud", "13. Fraud API"],
    ],
  },
  { title: "4 · Help", items: [["problems", "When something goes wrong"]] },
];

const KIT_ABOUT = {
  plugin: "An API that an institution plugs into its own steps. Answers \"allow\" to everything and prints what it was sent.",
  app: "An application of your own that signs in to a network and makes one call of each kind.",
  bridge: "Lets the sandbox reach an API running on your laptop. Run it beside your API, in whatever language that is written.",
} as const;

/**
 * The documentation: a guide to getting started, the starter kits, the full API reference and what to do
 * when something goes wrong. One page, shown two ways. Inside a team's area it carries that team's own
 * address and key in every example and reads the menus as the team has them. Opened by anyone at /docs,
 * it carries placeholders instead, so participants can read it before they have a team link.
 */
export async function DocsContent({ team }: { team?: string }) {
  const origin = await pageOrigin();
  const key = team ? (teamById(team)?.key ?? "<organiser key>") : "YOUR-TEAM-KEY";
  const worldName = team ?? "YOUR-TEAM";
  const base = `${origin}/api/w/${worldName}`;
  const home = team ? `/t/${team}` : undefined;
  const auth = `-H "x-team-key: ${key}"`;
  const json = `-H "content-type: application/json"`;
  const partner = `-u "$CLIENT_ID:$API_KEY"`;
  const shared = sharedServer();
  // Where each network's menu keeps requests waiting for the customer's answer: as this team has it now, or as it starts out.
  const world = team ? getWorld(team) : undefined;
  const approvals = TELCOS.map((t) => {
    const menu = world ? getConfig(world.db, `telco.${t}`).menu : defaultTelco(t).menu;
    return { name: TELCO_INFO[t].name, wallet: TELCO_INFO[t].wallet, code: menu.shortcode, path: world ? approvalsPath(world, t) : approvalsPathIn(menu) };
  });
  const kits = KITS.map((k) => ({ ...k, source: kitSource(k.file) ?? "" }));
  /** A link to one of the team's screens, or just its name where there is no team. */
  const screen = (path: string, label: string) =>
    home ? (
      <Link className="underline" href={`${home}${path}`}>
        {label}
      </Link>
    ) : (
      <b>{label}</b>
    );

  return (
    <div className="flex min-h-full flex-1 flex-col bg-white">
      <DocsHeader back={home ? { href: home, label: `Back to ${teamName(team!)}` } : { href: "/", label: "Back to home" }} teamLabel={team ? teamName(team) : undefined} />
      <div className="mx-auto w-full max-w-7xl px-4 pb-24 pt-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12 lg:pt-10">
        <DocsNav parts={CONTENTS} />

        <main className="docs-prose min-w-0">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">Documentation</h1>
          <p className="mt-3 max-w-3xl text-lg leading-8 text-gray-600">
            Everything about the mobile money sandbox: what it is, how to try it in a few minutes, how to build on it, and every API in full. You do not need to be a programmer to read the first part.
          </p>

          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <a href="#start" className="group rounded-2xl border border-gray-200 bg-gradient-to-br from-[#f6f2fc] to-white p-5 no-underline hover:border-[#3b1f6e]/40 hover:shadow-md">
              <div className="text-xs font-semibold uppercase tracking-wider text-[#3b1f6e]">New here? No coding needed</div>
              <div className="mt-1 text-lg font-semibold text-gray-900">Start here →</div>
              <p className="mt-1 text-sm leading-6 text-gray-600">What the sandbox is, a 15-minute walk-through with test customers and a real payment, and the words you will meet along the way.</p>
            </a>
            <a href="#products" className="group rounded-2xl border border-gray-200 bg-gradient-to-br from-slate-50 to-white p-5 no-underline hover:border-slate-400 hover:shadow-md">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-600">Building something? For developers</div>
              <div className="mt-1 text-lg font-semibold text-gray-900">Build and API reference →</div>
              <p className="mt-1 text-sm leading-6 text-gray-600">Write a plug-in in the Developer console, run a starter kit, and look up every endpoint, with examples ready to copy.</p>
            </a>
          </div>

          {team ? (
            <div className="mt-6 rounded-2xl border border-gray-200 bg-gray-50 p-4">
              <div className="text-sm font-semibold text-gray-900">Your team&apos;s address and key</div>
              <p className="mt-0.5 text-sm text-gray-600">Already filled into every example on this page. Keep the key inside your team: anyone who has it can change your world.</p>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                <CopyValue label="Base URL" value={base} />
                <CopyValue label="Team key" value={key} />
              </div>
            </div>
          ) : (
            <Callout tone="info" title="This is the public copy">
              The examples use the placeholders <code>YOUR-TEAM</code> and <code>YOUR-TEAM-KEY</code>. Once you have your team link, open <b>Documentation</b> from your team&apos;s home page: the same page, with your own address and key filled into every
              example.
            </Callout>
          )}

          <Part n={1} title="Start here" about="For everyone. No coding needed." />

          <Section title="What the sandbox is" id="start">
            <p>
              A working copy of Ghana&apos;s mobile money system, made for building and testing ideas against fraud. Every institution is here, each with its own screen:
            </p>
            <div className="my-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(
                [
                  ["NIA", "Issues Ghana Cards: who a person is."],
                  ["MTN, Telecel and AT", "Register SIMs and run the wallets: MTN MoMo, Telecel Cash, AT Money."],
                  ["Agents and merchants", "Agents swap cash for e-money. Merchants take payments."],
                  ["Banks", "Hold accounts, and send money to and from wallets."],
                  ["National switch", "Carries money between networks and banks."],
                  ["Bank of Ghana and NCA", "Set the rules: wallet limits, SIM registration."],
                ] as const
              ).map(([t, d]) => (
                <div key={t} className="rounded-xl border border-gray-200 p-3">
                  <div className="text-sm font-semibold text-gray-900">{t}</div>
                  <div className="text-sm leading-6 text-gray-600">{d}</div>
                </div>
              ))}
            </div>
            <p>
              The phones work too: you dial the wallet code, send money, get texts and take calls, on screen or on a real phone. Every team has its own copy, called a <b>world</b>. Nothing you do reaches another team, you can save your world and roll it back at any
              time, and nothing here touches real money or real people.
            </p>
          </Section>

          <Section title="Your first 15 minutes" id="first">
            <p>A short walk-through. Each step takes a minute or two, and you need nothing installed.</p>
            <Steps
              steps={[
                <>
                  <b>Open your team&apos;s link.</b> It is on your team card, as a link and as a QR code. You land on {home ? screen("", "your team's home page") : "your team's home page"}, with every system in the purple bar at the top.
                </>,
                <>
                  <b>Choose what your world starts with.</b> It starts empty. To fill it with thousands of people, wallets, agents and three months of history (part of it fraud), press <b>Load the simulated country</b> on the home page. Do this first if you
                  want it: it replaces what is in the world, and keeps the old world as a save point.
                </>,
                <>
                  <b>Create two test customers.</b> On the home page, choose a network and press <b>Create a test customer</b>, twice. Each gets a number, a wallet with GHS 500 and a PIN you are shown once. Write the PINs down.
                </>,
                <>
                  <b>Send money.</b> Press <b>Open this phone</b> beside the first customer. Dial the wallet code, choose to send money, enter the second customer&apos;s number and an amount, and confirm with the PIN. The wallet codes:{" "}
                  {approvals.map((a, i) => (
                    <span key={a.name}>
                      {i > 0 && ", "}
                      <code>{a.code}</code> for {a.wallet}
                    </span>
                  ))}
                  .
                </>,
                <>
                  <b>See it from the other side.</b> Open the network from <b>Telcos</b> in the top bar, then its back office, and look under <b>Transactions</b>: the payment is there, with its fee. Between two networks, it is also on the national switch.
                </>,
                <>
                  <b>Try a fraud check.</b> Open <b>Developer</b>, create a plug-in from <b>New-payee warning</b>, and plug it into the network. Send money to someone new: the phone warns you first. See <a href="#developer">Developer console</a>.
                </>,
              ]}
            />
            <Callout tone="tip" title="Use a real phone">
              Scan the <b>customer phone</b> QR code on the home page with your phone. It then works as that customer&apos;s phone, while your laptop keeps the consoles. Both must be on the same network as the sandbox, or it must be on the internet.
            </Callout>
          </Section>

          <Section title="Words you will see" id="words">
            <dl className="my-2 grid gap-x-8 gap-y-3 md:grid-cols-2">
              {(
                [
                  ["World", "Your team's own copy of the whole system. Save it, roll it back, or wipe it from the home page."],
                  ["Wallet", "A mobile money account tied to a phone number, such as MTN MoMo."],
                  ["Ghana Card", "The national ID card. NIA issues it; it is needed to register a SIM or open a wallet."],
                  ["Fingerprint code", "Stands in for a person's fingerprints wherever a biometric check is done (e.g. FP-7KQ2XA)."],
                  ["KYC level", "How well a customer has been identified: minimum, medium or enhanced. Higher levels allow larger balances and payments."],
                  ["Short code (USSD)", "What you dial for a menu, such as *170#. The menu then appears on the phone's screen."],
                  ["Agent", "A shop that gives cash for e-money and e-money for cash, and opens wallets for customers."],
                  ["Float", "The e-money an agent holds to serve customers. Agents buy it from a bank."],
                  ["Merchant", "A business that accepts wallet payments, identified by a merchant (till) number."],
                  ["SIM swap", "Moving a number to a new SIM card. Fraudsters use it to take over accounts."],
                  ["National switch", "The system (GhIPSS) that carries money between different networks and banks."],
                  ["Plug-in", "Code that an institution asks at one of its steps, such as just before a payment. It can allow, warn, delay or refuse."],
                  ["API", "A way for programs to talk to each other. Every institution here has one."],
                  ["Team key", "Your team's password for the sandbox's own API. Keep it inside your team."],
                ] as const
              ).map(([t, d]) => (
                <div key={t} className="border-b border-gray-100 pb-3">
                  <dt className="font-semibold text-gray-900">{t}</dt>
                  <dd className="text-[14px] leading-6 text-gray-600">{d}</dd>
                </div>
              ))}
            </dl>
          </Section>

          <Section title="What each screen is" id="systems">
            <p>Every screen is one click away in the purple bar at the top of your team&apos;s home page.</p>
            <div className="mt-3 overflow-hidden rounded-xl border border-gray-200">
              <table className="w-full text-left">
                <tbody className="divide-y divide-gray-100">
                  {(
                    [
                      ["", "Team home", "Where everything starts: test customers, the simulated country, phone QR codes, recent activity, save points."],
                      ["/developer", "Developer console", "Write your own plug-ins in JavaScript or Python. The sandbox runs them for you."],
                      ["/telcos/mtn", "A network's page", "Everything one network runs, in one place. One each for MTN, Telecel and AT."],
                      ["/telco/mtn", "A network's back office", "SIM stock, wallets, agents, merchants, transactions, calls and texts, fees and menus, API partners, plug-ins."],
                      ["/sim-agent/mtn", "SIM registration point", "Registers a SIM against a Ghana Card, replaces a SIM, resets a PIN, raises KYC. Each network's head office is open from the start."],
                      ["/momo-agent/mtn", "Mobile money agent", "Open an agent from the owner's Ghana Card, then cash in, cash out and open wallets for customers."],
                      ["/care/mtn", "Customer care", "A network's call centre: complaints, disputes, holds and returning money."],
                      ["/phone", "Phone", "Any registered number: dial codes, messages, calls, the wallet."],
                      ["/nia", "NIA", "The Ghana Card register, and every identity check made."],
                      ["/nca", "NCA", "SIM registration rules and the central register of numbers."],
                      ["/bog", "Bank of Ghana", "Wallet limits, and whether each network's e-money is fully backed."],
                      ["/bank/gcb", "A bank", "Accounts, the counter, transfers, agent float, API partners, plug-ins."],
                      ["/switch", "National switch", "Payments between networks and banks, what each owes, settlement."],
                      ["/fraud", "Fraud console", "Plays fraud incidents against what you built and counts how many were stopped."],
                      ["/assistant", "Assistant", "Tell it what you want done in plain words, and it does it."],
                    ] as const
                  ).map(([path, name, about]) => (
                    <tr key={name} className="align-top">
                      <td className="w-56 whitespace-nowrap px-4 py-2.5 font-medium text-gray-900">{home ? <Link href={`${home}${path}`}>{name}</Link> : name}</td>
                      <td className="px-4 py-2.5 text-gray-600">{about}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="The assistant" id="assistant">
            <p>
              You can also tell the sandbox what you want in plain words. The assistant is a small team of AI agents that works in your world: it does the job step by step, shows each step, and tells you what happened. Open it with the <b>Assistant</b> button
              {home ? <> on {screen("/assistant", "your team's home page")}</> : " on your team's home page"}. If it is not there, the organisers have not switched it on.
            </p>
            <ul>
              <li>
                <b>Ask for anything you could do on the screens:</b> &quot;create two test customers on MTN and send GHS 20 from one to the other&quot;, &quot;set up an agent on Telecel with GHS 5,000 of float&quot;, &quot;how many payments failed yesterday, and why?&quot;
              </li>
              <li>
                <b>It asks first</b> before wiping your world, rolling it back, or removing anything, and waits for you to approve.
              </li>
              <li>
                <b>It stays in your world.</b> It never shows a wallet PIN, except for a customer it created for you, and it does not suggest what to build: that is yours to decide.
              </li>
              <li>
                <b>Check its work.</b> It can be wrong, as any assistant can. Everything it does shows on the screens.
              </li>
            </ul>
            <Callout tone="note">
              What you say to the assistant, and what it reads from your world to answer, is sent to the AI service that runs it. Your team key is not. From a script: <code>POST {"{base}"}/assistant</code> with <code>{`{"text": "…"}`}</code> and your team key.
            </Callout>
          </Section>

          <Part n={2} title="Build" about="For developers: plug-ins, starter kits, and where your code runs." />

          <Section title="Two ways to build" id="products">
            <div className="my-3 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-gray-200 p-4">
                <div className="text-base font-semibold text-gray-900">A plug-in an institution asks</div>
                <p className="mt-1 text-[14px] leading-6">
                  A network, a bank or the national switch asks your code at one of its own steps (a PIN being chosen, a payment about to leave, a SIM about to be replaced) and does what it answers. Write it in the <a href="#developer">Developer console</a>, or run
                  it yourself (<a href="#kit-plugin">plug-in kit</a>).
                </p>
              </div>
              <div className="rounded-xl border border-gray-200 p-4">
                <div className="text-base font-semibold text-gray-900">An application of your own</div>
                <p className="mt-1 text-[14px] leading-6">
                  An app or service outside the institutions that uses what they give outside companies: their partner APIs, with credentials each one issues to you. See <a href="#credentials">sections 1 to 6</a> and the <a href="#kit-app">application kit</a>.
                </p>
              </div>
            </div>
            <p>
              Either way, the <b>Fraud console</b> tests what you built: it plays fraud incidents through your world and counts how many were stopped (<a href="#fraud">section 13</a>). For work on data, the simulated country comes with every transaction labelled (
              <a href="#dataset">section 12</a>).
            </p>
          </Section>

          <Section title="Developer console" id="developer">
            <p>
              The quickest way to build a plug-in: write it in your browser, in <b>JavaScript</b> or <b>Python</b>, and the sandbox runs it for you. No server, no bridge, nothing to install. Open it with the <b>Developer</b> button
              {home ? <> on {screen("/developer", "your team's home page")}</> : " on your team's home page"}.
            </p>
            <Steps
              steps={[
                <>
                  Press <b>+ New plug-in</b>. Give it a name, pick the language, and start from <b>Blank</b> or a ready example such as <b>New-payee warning</b>.
                </>,
                <>
                  Write your rules in <code>decide(point, data, ctx)</code> and press <b>Save and run</b> (or ⌘S / Ctrl+S). A mistake shows straight away.
                </>,
                <>
                  Under <b>Try it</b>, send it the example a network would send at a step, and see its answer. Nothing happens for real.
                </>,
                <>
                  Under <b>Plug it in</b>, choose a network, bank or the switch, and the step. From then on that step asks your code. Its <code>print()</code> / <code>console.log()</code> output and every question it was asked appear under <b>Output</b>.
                </>,
              ]}
            />
            <div className="grid gap-3 xl:grid-cols-2">
              <CopyCode label="plugin.py">{`def decide(point, data, ctx):
    # point: the step, e.g. "payment.authorize"
    # data:  what is about to happen (try a step to see it)
    # ctx:   ctx.store.get/set/delete keeps things between questions
    if point == "payment.authorize" and data["amount"] > 1000:
        return {"decision": "warn",
                "message": "This is a large payment. Is it genuine?"}
    return {"decision": "allow"}`}</CopyCode>
              <CopyCode label="plugin.mjs">{`export function decide(point, data, ctx) {
  // point: the step, e.g. "payment.authorize"
  // data:  what is about to happen (try a step to see it)
  // ctx:   ctx.store.get/set/delete keeps things between questions
  if (point === "payment.authorize" && data.amount > 1000) {
    return { decision: "warn",
             message: "This is a large payment. Is it genuine?" };
  }
  return { decision: "allow" };
}`}</CopyCode>
            </div>

            <h3 className="pt-4 text-lg font-semibold text-gray-900">How decide() works</h3>
            <p>
              Think of it as a question the institution asks your code at one moment, such as just before a payment leaves a wallet: <i>&quot;this is about to happen, shall I go ahead?&quot;</i>. Your function gets three things and gives back one answer.
            </p>
            <div className="my-4 overflow-hidden rounded-xl border border-gray-200">
              <table className="w-full text-left">
                <thead className="bg-gray-50 text-xs font-semibold tracking-wide text-gray-500 uppercase">
                  <tr>
                    <th className="w-36 px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">What it is</th>
                    <th className="hidden px-4 py-2.5 md:table-cell">Example</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 align-top">
                  <tr>
                    <td className="px-4 py-3">
                      <code>point</code>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <b>Which moment it is</b>: the step you plugged the code into. One plug-in can be plugged in at several steps, and <code>point</code> tells you which one is asking now. <code>events</code> is the odd one out: it reports things that have already
                      happened, and your answer is ignored.
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <code>&quot;payment.authorize&quot;</code>
                      <br />
                      <code>&quot;sim.swap&quot;</code>
                      <br />
                      <code>&quot;events&quot;</code>
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3">
                      <code>data</code>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <b>The facts about what is about to happen</b>, as an object (a dict in Python). What is in it depends on the step: for a payment, the amount, who is paying, who is being paid and how often they have paid them before. The{" "}
                      <b>Test</b> tab in the console shows the real example for every step, and <a href="#plugins">section 7</a> lists them all.
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <code>data.amount</code>
                      <br />
                      <code>data.payer.msisdn</code>
                      <br />
                      <code>data.payee.name</code>
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3">
                      <code>ctx</code>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <b>Your toolbox</b> (short for context). <code>ctx.store</code> is a small memory that survives between questions and restarts: <code>get(key)</code>, <code>set(key, value)</code>, <code>delete(key)</code>. <code>ctx.institution</code> says who is
                      asking (e.g. <code>mtn</code>), <code>ctx.world</code> which team&apos;s world, and <code>ctx.log(…)</code> writes to the Output panel.
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <code>ctx.store.get(&quot;seen&quot;)</code>
                      <br />
                      <code>ctx.institution</code>
                    </td>
                  </tr>
                  <tr>
                    <td className="px-4 py-3">
                      <b>The answer</b>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      What the institution should do, with an optional <code>message</code> shown to the customer: <code>allow</code> (go ahead), <code>warn</code> (show the message; the customer chooses to continue or cancel), <code>delay</code> (refuse for now,
                      with <code>minutes</code> before it may be tried again) or <code>reject</code> (refuse). Return nothing and it counts as <code>allow</code>.
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <code>{`{ "decision": "warn", "message": "…" }`}</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              Here is the <code>data</code> a network sends at <code>payment.authorize</code>, just before money leaves a customer&apos;s wallet:
            </p>
            <CopyCode label="data at payment.authorize">{JSON.stringify(SAMPLES["payment.authorize"], null, 2)}</CopyCode>
            <Callout tone="tip" title="Not sure what a step sends?">
              Write <code>print(data)</code> (Python) or <code>console.log(data)</code> (JavaScript) in your function, save, and press <b>Send a test</b> on the <b>Test</b> tab. The full example appears under <b>Output</b>.
            </Callout>
            <ul>
              <li>
                <b>Answers:</b> <code>allow</code>, <code>warn</code> (the customer sees your message and chooses), <code>delay</code> (with <code>minutes</code>) or <code>reject</code>. Each step accepts only some of them; the console tells you which.
              </li>
              <li>
                <b>Remembering things:</b> <code>ctx.store</code> keeps values between questions and restarts. Plug the same code in at <code>events</code> to learn from payments that went through.
              </li>
              <li>
                <b>Limits:</b> the language&apos;s own standard library only, about 2 seconds to answer, and only its own folder on disk. A plug-in that is idle for 20 minutes is paused and starts again with the next question.
              </li>
              <li>
                <b>Its address</b> looks like <code>code://code_…</code>. It also works in any institution&apos;s <b>Plug-ins</b> tab. What each step sends is in <a href="#plugins">section 7</a>.
              </li>
            </ul>
          </Section>

          <Section title="Starter kits" id="kits">
            <p>
              Small working files to copy and change. They do the plumbing (receiving a question, signing in, sending an answer in the right shape) and nothing else: what to build is yours. None needs anything installed beyond Python or Node.js itself.
              The last two are not something to build on: the bridge is a helper you run as it is.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {kits.map((k) => (
                <div key={k.file} className="card flex flex-col p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-mono text-sm font-semibold text-gray-900">{k.file}</h3>
                    <span className="text-xs text-gray-500">{k.language}</span>
                  </div>
                  <p className="mt-1 flex-1">{KIT_ABOUT[k.kind]}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <a className="btn btn-dark !py-1.5 !text-xs" href={`/docs/starter/${k.file}`} download={k.file}>
                      Download
                    </a>
                    <code className="text-xs text-gray-600">{k.run}</code>
                  </div>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-gray-600">Read the code</summary>
                    <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-gray-900 p-3 font-mono text-xs leading-relaxed text-gray-100">{k.source}</pre>
                  </details>
                </div>
              ))}
            </div>
            <p className="text-[14px] text-gray-600">The same files are in the <code>examples</code> folder of the sandbox&apos;s repository.</p>
          </Section>

          <Section title="Run a plug-in API" id="kit-plugin">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Download <code>plugin_api.py</code> or <code>plugin-api.mjs</code> and run it: <code>python3 plugin_api.py</code> or <code>node plugin-api.mjs</code> (on Windows, <code>python</code> in place of <code>python3</code>). It listens on port 4010 and prints{" "}
                <code>Listening on port 4010</code>.
              </li>
              <li>
                Make sure the sandbox can reach it: see <a href="#reach">where your API has to be</a>. From a laptop, that means starting <a href="#bridge">the bridge</a> and using <code>bridge://laptop</code> as the address.
              </li>
              <li>
                Open the console of the institution that should ask it, for example {screen("/telco/mtn", "the MTN back office")}, and go to <b>Plug-ins</b>. Under <b>Plug in an API</b>, give it a name, choose the step, and enter its address.
              </li>
              <li>
                Press <b>Send a test</b>. The kit prints the example question it was sent, and the console shows that it answered &quot;allow&quot;.
              </li>
              <li>
                Now do the real thing: with a plug-in on <code>payment.authorize</code>, send money from a test customer&apos;s phone and watch the question arrive. Change <code>decide()</code> to answer something else and try again.
              </li>
            </ol>
            <Code>{`# What decide() can return
{ "decision": "allow" }
{ "decision": "reject", "message": "Shown to the customer." }
{ "decision": "warn",   "message": "Shown first. The customer chooses whether to continue." }
{ "decision": "delay",  "minutes": 10, "message": "Refused now; can be tried again after the pause." }`}</Code>
            <p>
              Which answers each step accepts, and exactly what it sends you, is in <a href="#plugins">section 7</a>. While it is deciding, your API can ask the sandbox anything it likes, such as whether a SIM was replaced lately
              (<a href="#network">section 3</a>).
            </p>
          </Section>

          <Section title="Run an application" id="kit-app">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Get credentials. Open {screen("/telco/mtn", "the MTN back office")}, go to <b>API partners</b> and give a company access. To collect payments, tie it to one of the network&apos;s merchants. You are shown a <b>client ID</b> and an <b>API key</b>.
                They work on that network only.
              </li>
              <li>
                Pick a customer on that network: a test customer you created, or anyone listed on the Phone screen.
              </li>
              <li>Download <code>app.py</code> or <code>app.mjs</code> and run it with those details:</li>
            </ol>
            <Code>{`python3 app.py --sandbox ${base} --client-id … --api-key … --number 024…
node app.mjs --sandbox ${base} --client-id … --api-key … --number 024…

# add --amount 5 to also ask that customer for GHS 5 and wait for their answer
# add --network telecel or --network at for the other networks
# on Windows, type python in place of python3`}</Code>
            <p>
              It signs in, looks up who the number is registered to, asks whether its SIM was replaced lately, and reads the name on the wallet. With <code>--amount</code> it also sends the customer a request to pay, then waits while they approve or refuse on their
              phone: {approvals.map((a, i) => (
                <span key={a.name}>
                  {i > 0 && "; "}on {a.name}, dial <code>{a.code}</code> and {a.path}
                </span>
              ))}
              .
            </p>
            <p>
              An application that should be <em>sent</em> fraud incidents by the Fraud API receives them in the same format as a plug-in API, so start that part from the plug-in kit and connect it as <a href="#fraud">section 13</a> describes.
            </p>
          </Section>

          <Section title="Where your API has to be" id="reach">
            <p>This matters for anything the sandbox calls: a plug-in API, an application the Fraud API sends incidents to, a USSD application, a callback address.</p>
            {shared ? (
              <>
                <p>
                  <b>This sandbox is shared by every team and runs on the internet, so it cannot call your laptop.</b> An address like <code>http://localhost:4010</code> means &quot;this same machine&quot;, which for the sandbox is its own server, and it refuses addresses
                  like it. You have three ways to connect your API:
                </p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>
                    <b>The bridge (simplest).</b> Keep your API on your laptop and run the bridge beside it. Nothing to install, no account, and the address never changes. See <a href="#bridge">the next section</a>.
                  </li>
                  <li>
                    <b>Host it.</b> Put the API on any hosting service that gives it a public <code>https://</code> address, and use that address. This does not depend on a laptop staying awake, so it is the steadiest choice for a final demonstration.
                  </li>
                  <li>
                    <b>A tunnel.</b> A tunnel tool gives your laptop a temporary public address, for example <code>cloudflared tunnel --url http://localhost:4010</code> or <code>ngrok http 4010</code>. The address changes each time you start it.
                  </li>
                </ol>
              </>
            ) : (
              <p>
                <b>This sandbox is running on your own machine or in a Codespace, so an address on the same machine works as it is:</b> with a kit running on port 4010, use <code>http://localhost:4010/</code>. On a sandbox shared by every team it is different: that
                one cannot call your laptop, so there you run <a href="#bridge">the bridge</a>, host the API at a public <code>https://</code> address, or open a tunnel. The bridge works here too, if you want to practise with it.
              </p>
            )}
            <p>
              The other direction needs nothing: your own code, wherever it runs, can always call the sandbox. That includes a web page calling it straight from the browser, as long as the key or credentials are sent in a header.
            </p>
          </Section>

          <Section title="The bridge: an API on your laptop" id="bridge">
            <p>
              The sandbox cannot call your laptop, but your laptop can call the sandbox. The bridge is a small program that does that and stays on the line. Whatever the sandbox has for your API arrives on that call, is passed to your API on the laptop, and the
              answer goes back the same way. Your API stays an ordinary API, in any language: nothing in it changes, and the same code runs unchanged once it is hosted.
            </p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>Start your API on your laptop, for example a plug-in kit on port 4010.</li>
              <li>
                Download <code>bridge.py</code> or <code>bridge.mjs</code> (<a href="#kits">above</a>) and start it beside your API. It does not matter which one you use, whatever your API is written in:
              </li>
            </ol>
            <Code>{`python3 bridge.py --sandbox ${base} --key ${key}
node bridge.mjs --sandbox ${base} --key ${key}

# add --to http://localhost:5000 if your API is not at http://localhost:4010
# add --name ama to call the bridge something other than "laptop" (each laptop needs its own name)
# on Windows, type python in place of python3`}</Code>
            <ol className="list-decimal space-y-2 pl-5" start={3}>
              <li>
                It prints <code>Connected to the sandbox as &quot;laptop&quot;</code>. From then on, wherever the sandbox asks for your API&apos;s address (the Plug-ins tab, the Fraud console, a USSD short code, a callback address), type{" "}
                <code>bridge://laptop</code>. A path is passed on as well: <code>bridge://laptop/check</code> reaches <code>http://localhost:4010/check</code>.
              </li>
              <li>
                Press <b>Send a test</b> on the Plug-ins tab. The bridge prints a line for every request it passes on, and the tab shows whether the laptop is connected.
              </li>
            </ol>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b>Leave it running.</b> If the bridge stops, or the laptop sleeps or loses its connection, the sandbox treats your API as not answering and does what was chosen under <b>If the API does not answer</b>. Start the bridge again and it carries on;
                nothing needs to be plugged in again.
              </li>
              <li>
                <b>One name, one laptop.</b> If a second bridge starts under the same name, it takes over and the first one stops. Teammates who each run an API give their bridges different names.
              </li>
              <li>
                <b>Only your team.</b> A bridge is opened with your team key and can only be used from your own team&apos;s world.
              </li>
              <li>
                <b>From a script.</b> <code>curl {"{base}"}/bridge {auth}</code> lists your team&apos;s bridges and whether each is connected.
              </li>
            </ul>
          </Section>

          <Part n={3} title="API reference" about="Every endpoint, with examples ready to copy. Amounts are in cedis." />

          <Section title="Which API is for what" id="reference">
            <div className="my-3 grid gap-3 md:grid-cols-2">
              {(
                [
                  ["Partner APIs", "Sections 1 to 6", "What an institution gives an outside company. You call them with credentials that institution issued, not your team key."],
                  ["Plug-in points", "Section 7", "The other way round: an institution asks your code at one of its steps, and does what you answer."],
                  ["Console API", "Sections 8 to 12", "Everything the screens do, with your team key. Use it to set up your world from a script."],
                  ["Fraud API", "Section 13", "Tests what you built: plays fraud incidents and counts how many were stopped."],
                ] as const
              ).map(([t, where, d]) => (
                <div key={t} className="rounded-xl border border-gray-200 p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-gray-900">{t}</span>
                    <span className="text-xs text-gray-500">{where}</span>
                  </div>
                  <p className="mt-1 text-[14px] leading-6 text-gray-600">{d}</p>
                </div>
              ))}
            </div>
            <div className="max-w-3xl">
              <CopyValue label="Base URL" value={base} />
            </div>
            <p className="text-[14px] text-gray-600">Your own web page can call any of this straight from the browser, with the key or the credentials in a header.</p>
          </Section>

          <Section title="1. Getting partner credentials" id="credentials">
            <p>
              Each institution issues its own. Open its console, go to <b>API partners</b>, and give a company access: a network, a bank, the national switch, or NIA. You get a <b>client ID</b> and an <b>API key</b> that work only on that institution&apos;s API. A network can tie the company to a merchant wallet (needed for payments); a bank ties it to an account.
            </p>
            <p>Send them on every call with HTTP Basic, or swap them once for a bearer token at the institution&apos;s token endpoint.</p>
            <Code>{`CLIENT_ID=…   API_KEY=…                               # from the institution's API partners tab

curl ${base}/network/mtn/v1/subscribers/0241234567 ${partner}          # Basic on each call
curl ${base}/network/telecel/v1/subscribers/0201234567 ${partner}      # the same on Telecel, with Telecel's credentials
curl ${base}/network/at/v1/subscribers/0261234567 ${partner}           # and on AT, with AT's
TOKEN=$(curl -s -X POST ${base}/network/mtn/token ${partner} | jq -r .access_token)
curl ${base}/network/mtn/v1/subscribers/0241234567 -H "Authorization: Bearer $TOKEN"`}</Code>
          </Section>

          <Section title="2. Mobile money API: MTN MoMo, Telecel Cash and AT Money" id="momo">
            <p>
              <b>Every network has this API</b>, at its own address. The calls are the same on all three; only the network&apos;s name in the address changes, and each network issues its own credentials (its back office → <b>API partners</b>).
            </p>
            <NetworkAddresses base={base} api="momo" />
            <p>
              The examples below use <code>mtn</code>: put <code>telecel</code> or <code>at</code> in its place for the others. Telecel and AT do not publish their own API documents, so all three follow the layout of MTN&apos;s published MoMo API.
            </p>
            <p>
              Collection takes money from customers; disbursement and remittance pay it out. Each request carries your own <code>X-Reference-Id</code>, returns <code>202</code>, and is finished later: ask for its status, or receive it at your callback address.
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
              A request to pay, a pre-approval and a profile request all appear on the customer&apos;s phone, where they agree with their PIN or refuse. Each network keeps them in its own place on its menu:{" "}
              {approvals.map((a, i) => (
                <span key={a.name}>
                  {i > 0 && "; "}on {a.name}, dial <code>{a.code}</code> and {a.path}
                </span>
              ))}
              . Once a pre-approval is granted, a request to pay from the same partner to that customer completes without asking.
            </p>
            <p>
              As on MTN&apos;s developer portal, you can also create credentials from code with your team key: <code>POST momo/&#123;telco&#125;/v1_0/apiuser</code> (with <code>X-Reference-Id</code> and <code>X-Merchant-Id</code>), then <code>POST …/apiuser/&#123;id&#125;/apikey</code>.
            </p>
          </Section>

          <Section title="3. Network API: texts, subscriber checks, USSD" id="network">
            <p>
              <b>Every network has this API too</b>, at its own address, with the same credentials as its mobile money API. A network answers only for its own numbers, so ask the network the number belongs to.
            </p>
            <NetworkAddresses base={base} api="network" />
            <p>
              The example uses <code>mtn</code>: put <code>telecel</code> or <code>at</code> in its place for the others.
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

          <Section title="4. Bank API" id="bank">
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

          <Section title="5. National switch API (GhIPSS)" id="switch">
            <p>
              At <code className="break-all">{base}/ghipss</code>, for licensed institutions. Payments are not sent here directly: send them through your bank or network, which routes them through the switch.
            </p>
            <Code>{`GET  v1/participants                                             banks and networks on the switch, and whether each is connected
POST v1/name-enquiry        {accountNumber} or {msisdn}          which institution holds it, and the name on it
GET  v1/transactions/{id}                                        status of a routed payment, with the switch's messages`}</Code>
          </Section>

          <Section title="6. NIA identity verification" id="nia">
            <p>
              At <code className="break-all">{base}/nia</code>, for certified institutions. Every request is on NIA&apos;s log.
            </p>
            <Code>{`POST v1/verify   {cardNumber}                         → {valid}                     is this a valid Ghana Card?
POST v1/verify   {cardNumber, fingerprint, purpose}   → {valid, biometricMatch, person}   a biometric check; the holder's details come back only on a match`}</Code>
          </Section>

          <Section title="7. Plug-in points: your API inside an institution's system" id="plugins">
            <p>
              Put your API where the sandbox can reach it (see <a href="#reach">where your API has to be</a>)
              , then open the console of a network, a bank or the national switch, go to <b>Plug-ins</b>, and enter its address and the step it should be asked at. From then on the institution sends a <code>POST</code> with a JSON body to your address every time that step
              happens, waits for your answer (2 seconds by default), and acts on it. The same tab shows every question it asked and what you answered, and has a <b>Send a test</b> button.
            </p>
            <Code>{`# What you receive
{ "point": "pin.set", "institution": "mtn", "world": "${worldName}", "at": "2026-11-26T10:15:00.000Z", "data": { … } }

# What you answer (status 200, JSON)
{ "decision": "allow" }
{ "decision": "reject", "message": "Shown to the customer. Keep it short: a phone screen holds about 150 characters." }
{ "decision": "warn",   "message": "Shown first. The customer then chooses 1) Continue or 2) Cancel." }
{ "decision": "delay",  "minutes": 10, "message": "The payment is refused now and can be tried again after the pause." }`}</Code>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
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
              The <a href="#kits">starter kits</a> <code>plugin_api.py</code> and <code>plugin-api.mjs</code> answer &quot;allow&quot; to everything and print what they were sent. Plug an API in from a script:
            </p>
            <Code>{`curl -X POST ${base}/s/telco/mtn ${auth} ${json} -d '{"action":"plugin_add","name":"My API","point":"payment.authorize","url":"https://your-api.example.com/","ifDown":"carry_on"}'`}</Code>
          </Section>

          <Section title="8. Console API: one endpoint per institution" id="console">
            <p className="break-words">
              <code>GET {"{base}"}/s/{"{system}"}</code> returns what that institution&apos;s console shows. <code>POST</code> with <code>{"{ action, ...fields }"}</code> does something there. Systems: {SYSTEM_PATHS.map((p) => <code key={p} className="mr-1 break-all">{p}</code>)}
            </p>
            <Code>{`# NIA issues a Ghana Card
curl -X POST ${base}/s/nia ${auth} ${json} -d '{"action":"enrol","firstNames":"Ama","surname":"Owusu","dob":"1994-03-12","gender":"F","region":"Ashanti","town":"Kumasi"}'

# MTN's head office registers a SIM straight away (card + fingerprint are checked with NIA; it keeps its own blank SIMs)
curl -X POST ${base}/s/sim-agent/mtn ${auth} ${json} -d '{"action":"register","agent":"MTN-HQ","card":"GHA-…","fingerprint":"FP-…"}'

# Optional: MTN adds SIM stock and authorises a service centre of its own
curl -X POST ${base}/s/telco/mtn ${auth} ${json} -d '{"action":"add_sims","count":10}'
curl -X POST ${base}/s/telco/mtn ${auth} ${json} -d '{"action":"onboard_sim_agent","kind":"service_centre","name":"Adum Service Centre","town":"Kumasi","card":"GHA-…"}'

# MTN opens a mobile money agent from the owner's Ghana Card: a new agent line, an agent number, and GHS 1,000 of float
curl -X POST ${base}/s/telco/mtn ${auth} ${json} -d '{"action":"open_momo_agent","card":"GHA-…","fingerprint":"FP-…","name":"Yaw Mobile Money Centre","town":"Suame","pin":"4826","float":1000}'

# MTN gives a company API access (the answer carries its client ID and API key)
curl -X POST ${base}/s/telco/mtn ${auth} ${json} -d '{"action":"api_partner_create","name":"PayLink Ghana","till":"100001"}'

# A customer ready to use: a person, a registered number, a wallet with GHS 500. The answer carries the number and the wallet PIN.
curl -X POST ${base}/s/hub ${auth} ${json} -d '{"action":"test_customer","network":"mtn"}'

# Read any console
curl ${base}/s/telco/mtn ${auth}
curl ${base}/s/switch ${auth}`}</Code>
            <p>Send an unknown action to a system and the error lists the actions it supports.</p>
          </Section>

          <Section title="9. Phones" id="phones">
            <p>Drive any registered SIM. Start a USSD session by sending the short code; pass the returned <code>sessionId</code> with each reply.</p>
            <Code>{`curl -X POST ${base}/ussd ${auth} ${json} -d '{"msisdn":"024…","input":"*170#"}'
curl -X POST ${base}/ussd ${auth} ${json} -d '{"msisdn":"024…","sessionId":"ussd_…","input":"1"}'
curl -X POST ${base}/s/phone ${auth} ${json} -d '{"action":"sms_send","msisdn":"024…","to":"027…","text":"Hello"}'
curl "${base}/s/phone?msisdn=024…&thread=027…" ${auth}       # that phone's conversations, and one thread`}</Code>
          </Section>

          <Section title="10. Settings" id="settings">
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

          <Section title="11. Save points" id="savepoints">
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

          <Section title="13. Fraud API: test what you have built" id="fraud">
            <p>
              The fraud simulator plays fraud incidents of the kind you choose, live, through the sandbox: the fraudster gets a line, reaches the victim, the money leaves, moves on and is withdrawn. At each step your service is asked, and what it answers decides whether the
              incident goes on. Honest activity is played alongside. It needs people to act as victims, so load the simulated country first (section 12).
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b>If you built an API and plugged it into an institution</b> (section 7): just start a run. Your API is asked at its own step, as it is for any other activity.
              </li>
              <li>
                <b>If you built a standalone application</b>: connect it with its address and the kinds of fraud it is built to stop. During a run it is sent <em>every</em> step of each incident, in the same format a plugged-in API receives (section 7), and answers{" "}
                <code>allow</code>, <code>warn</code>, <code>delay</code> or <code>reject</code>. It should answer <code>allow</code> to steps it has no view on.
              </li>
            </ul>
            <Code>{`curl ${base}/fraud-simulator ${auth}                                          # the kinds of fraud, connected applications, whether a run is going

# start a run against the APIs plugged into the institutions
curl -X POST ${base}/fraud-simulator ${auth} ${json} -d '{"kinds":"sim_swap","incidents":20}'
curl -X POST ${base}/fraud-simulator ${auth} ${json} -d '{"kinds":["reversal_scam","fake_promo"],"incidents":40,"ordinary":40}'
curl -X POST ${base}/fraud-simulator ${auth} ${json} -d '{"kinds":"all","incidents":55}'

# a standalone application connects itself, then is sent incidents of the kinds it named
curl -X POST ${base}/fraud-simulator ${auth} ${json} -d '{"action":"connect","name":"Swap Alert","url":"https://my-app.example.com/fraud","kinds":["sim_swap"]}'
curl -X POST ${base}/fraud-simulator ${auth} ${json} -d '{"application":"Swap Alert","incidents":20}'

curl -X POST ${base}/fraud-simulator ${auth} ${json} -d '{"action":"stop"}'           # stop the run in progress
curl -X POST ${base}/fraud-simulator ${auth} ${json} -d '{"action":"disconnect","id":"app_…"}'`}</Code>
            <p>
              A run starts in the background and the call returns at once. <b>The results are not returned by this API and are never sent to your service</b>: nothing your service receives says which requests were fraud. How many incidents it stopped, at which step, and how much
              honest activity it stopped by mistake, are shown in your team&apos;s console, on the{" "}
              {team ? (
                <Link className="underline" href={`/t/${team}/fraud`}>
                  Fraud console
                </Link>
              ) : (
                "Fraud console"
              )}{" "}
              page under <b>Fraud API results</b>.
            </p>
            <p>The kinds of fraud that can be sent:</p>
            <ul className="list-disc space-y-1 pl-5">
              {Object.entries(FRAUD_KINDS).map(([id, about]) => (
                <li key={id}>
                  <code>{id}</code>: {about}.
                </li>
              ))}
            </ul>
            <p>
              An incident counts as <b>stopped</b> if the victim lost nothing, <b>held before cash-out</b> if the victim&apos;s money left but was blocked before it could be withdrawn (so it can be returned), and <b>got through</b> if it was withdrawn as cash. A warning does not
              stop an incident by itself: the simulated victim heeds it some of the time, and a fraudster never does. The console states the rates used.
            </p>
          </Section>

          <Part n={4} title="Help" about="What an error means, and what to do about it." />

          <Section title="When something goes wrong" id="problems">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-[11px] uppercase tracking-wide text-gray-500">
                    <th className="px-2 py-2 font-medium">What you see</th>
                    <th className="px-2 py-2 font-medium">What it means and what to do</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["401: Team key required", "The call needs your team key. Send it in the x-team-key header. In a browser, open the sandbox from your team link first."],
                      ["401: API credentials required", "A partner API (sections 1 to 6) wants the client ID and API key that institution issued, from its API partners tab. The team key does not work there, and one institution's credentials do not work on another's API."],
                      ["\"That address is on the sandbox's own machine or private network\"", "A shared sandbox cannot call your laptop. Run the bridge and use bridge://laptop as the address. See \"Where your API has to be\"."],
                      ["A plug-in's log shows \"The bridge … is not connected\"", "The bridge program is not running on the laptop, or the laptop has lost its connection. Start it again; nothing needs to be plugged in again."],
                      ["A plug-in's log shows \"Nothing is answering at http://localhost:4010\"", "The bridge is running but your API is not, or it is on another port. Start the API, or start the bridge with --to set to where the API is."],
                      ["A plug-in's log shows \"error: no answer within 2000 ms\"", "Your API did not answer in time, or could not be reached. Check it is running and that the address is right with Send a test. The institution then did what was chosen under \"If the API does not answer\": carried on, or refused."],
                      ["A plug-in's log shows \"answered …, but this step accepts: …\"", "That step does not take that answer: only payments can be delayed, for example. The table in section 7 lists what each step accepts."],
                      ["My API is never asked", "Check it is plugged into the right institution and step, and switched on. For a payment, the payer's network is asked; for money arriving, the payee's network or bank. Section 7 says who is asked when."],
                      ["Wrong PIN, on a person from the simulated country", "Their PINs are not shown to you, as in real life. Create a test customer on your team's home page, or reset that person's PIN at a SIM registration point (a service centre), which texts a temporary PIN to their phone."],
                      ["The wallet is locked", "Too many wrong PINs. Reset the PIN at a SIM registration point, or create another test customer."],
                      ["A payment is refused because of a limit", "Wallets have balance and daily limits by KYC level, set at the Bank of Ghana. Raise the wallet's KYC at a SIM registration point, or change the limits on the Bank of Ghana's Settings tab."],
                      ["A request to pay stays PENDING", "The customer has not answered. They approve or refuse on their phone, in the part of their network's menu that holds requests (see section 2)."],
                      ["My laptop shows a phone instead of the consoles", "That browser was opened with a phone QR code. Use the link \"Use this device for the consoles\" on the phone screen, or open your team link again."],
                      ["The Fraud console says it is not ready", "It needs people to act as victims and agents to cash out at. Load the simulated country first (section 12)."],
                      ["We broke our world", "On your team's home page: roll back to a save point, load the simulated country again, or wipe the world to empty. Take a save point before trying anything risky."],
                    ] as const
                  ).map(([see, means]) => (
                    <tr key={see} className="border-b border-gray-100 align-top">
                      <td className="w-2/5 px-2 py-2 font-medium text-gray-900">{see}</td>
                      <td className="px-2 py-2">{means}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </main>
      </div>
      <ToTop />
    </div>
  );
}

/** The address of one kind of API on each of the three networks, so nobody has to work it out from a pattern. */
function NetworkAddresses({ base, api }: { base: string; api: "momo" | "network" }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-[11px] uppercase tracking-wide text-gray-500">
            <th className="px-2 py-2 font-medium">Network</th>
            <th className="px-2 py-2 font-medium">Wallet</th>
            <th className="px-2 py-2 font-medium">Address</th>
          </tr>
        </thead>
        <tbody>
          {TELCOS.map((t) => (
            <tr key={t} className="border-b border-gray-100">
              <td className="px-2 py-2 font-medium text-gray-900">{TELCO_INFO[t].name}</td>
              <td className="px-2 py-2">{TELCO_INFO[t].wallet}</td>
              <td className="break-all px-2 py-2 font-mono">
                {base}/{api}/{t}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Part({ n, title, about }: { n: number; title: string; about: string }) {
  return (
    <div className="mt-16 mb-2 flex items-end gap-4 border-b-2 border-gray-900 pb-3">
      <span className="text-4xl font-bold leading-none text-[#3b1f6e]/25">{String(n).padStart(2, "0")}</span>
      <div>
        <div className="text-2xl font-bold tracking-tight text-gray-900">{title}</div>
        <div className="text-sm text-gray-500">{about}</div>
      </div>
    </div>
  );
}

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="group mt-10 scroll-mt-24 space-y-3">
      <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-gray-900">
        {title}
        {id && (
          <a href={`#${id}`} aria-label={`Link to ${title}`} className="text-base font-normal text-gray-300 no-underline opacity-0 group-hover:opacity-100">
            #
          </a>
        )}
      </h2>
      {children}
    </section>
  );
}

function Code({ children, label }: { children: string; label?: string }) {
  return <CopyCode label={label}>{children}</CopyCode>;
}

/** Numbered steps, easy to follow one at a time. */
function Steps({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="!my-4 !list-none !space-y-3 !pl-0">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#3b1f6e] text-sm font-semibold text-white">{i + 1}</span>
          <div className="min-w-0 flex-1">{s}</div>
        </li>
      ))}
    </ol>
  );
}

const TONES = {
  note: { box: "border-gray-200 bg-gray-50", head: "text-gray-900", icon: "ℹ" },
  info: { box: "border-[#d9cdee] bg-[#f6f2fc]", head: "text-[#3b1f6e]", icon: "ℹ" },
  tip: { box: "border-emerald-200 bg-emerald-50", head: "text-emerald-900", icon: "✓" },
  warn: { box: "border-amber-200 bg-amber-50", head: "text-amber-900", icon: "!" },
} as const;

/** A note set apart from the text: a tip, a warning, or something worth knowing. */
function Callout({ tone = "note", title, children }: { tone?: keyof typeof TONES; title?: string; children: React.ReactNode }) {
  const t = TONES[tone];
  return (
    <div className={`my-4 max-w-3xl rounded-xl border px-4 py-3 text-[14px] leading-6 ${t.box}`}>
      {title && (
        <div className={`mb-0.5 font-semibold ${t.head}`}>
          <span aria-hidden className="mr-1.5">
            {t.icon}
          </span>
          {title}
        </div>
      )}
      <div className="text-gray-700">{children}</div>
    </div>
  );
}
