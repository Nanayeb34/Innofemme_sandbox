import Link from "next/link";
import { BrandBar } from "@/components/brand";
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

/** What is on the page, in order. The list on the left and the one at the top are made from this. */
const CONTENTS: { title: string; items: [id: string, label: string][] }[] = [
  {
    title: "Start here",
    items: [["start", "What the sandbox is"], ["products", "Two ways to build"], ["first", "Your first 15 minutes"], ["assistant", "The assistant"], ["systems", "What each screen is"]],
  },
  {
    title: "Starter kits",
    items: [["kits", "The kits"], ["kit-plugin", "Run a plug-in API"], ["kit-app", "Run an application"], ["reach", "Where your API has to be"], ["bridge", "The bridge: an API on your laptop"]],
  },
  {
    title: "Reference",
    items: [
      ["credentials", "1. Partner credentials"], ["momo", "2. Mobile money API (all networks)"], ["network", "3. Network API (all networks)"], ["bank", "4. Bank API"], ["switch", "5. National switch API"], ["nia", "6. NIA verification"],
      ["plugins", "7. Plug-in points"], ["console", "8. Console API"], ["phones", "9. Phones"], ["settings", "10. Settings"], ["savepoints", "11. Save points"], ["dataset", "12. Simulated data"], ["fraud", "13. Fraud API"],
    ],
  },
  { title: "Help", items: [["problems", "When something goes wrong"]] },
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
    <>
      <BrandBar subtitle="Documentation" />
      <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
        <nav aria-label="On this page" className="hidden text-sm lg:block">
          <div className="sticky top-4 max-h-[calc(100vh-2rem)] overflow-y-auto pb-6 pr-2">
            <Contents />
          </div>
        </nav>

        <main className="min-w-0 text-sm leading-relaxed text-gray-800">
          <Link href={home ?? "/"} className="text-xs text-gray-500 underline">
            ← {home ? "All systems" : "Home"}
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-gray-900">Documentation</h1>
          <p className="mt-1 text-gray-600">How to get started, starter kits to copy, every API in full, and what to do when something goes wrong.</p>

          {team ? (
            <div className="card mt-4 grid gap-1 break-all p-4 font-mono text-xs">
              <div>
                <span className="text-gray-500">Base URL </span>
                {base}
              </div>
              <div>
                <span className="text-gray-500">Team key </span>
                {key}
              </div>
              <div className="mt-1 font-sans text-gray-600">These are your team&apos;s own. They are already filled into every example on this page. Keep the key inside your team: anyone who has it can change your world.</div>
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-[#d9cdee] bg-[#f3effa] p-4 text-gray-800">
              <b>This is the public copy.</b> The examples use the placeholders <code>YOUR-TEAM</code> and <code>YOUR-TEAM-KEY</code>. Once you have your team link, open <b>Documentation</b> from your team&apos;s home page: the same page, with your own address and key filled
              into every example, ready to copy.
            </div>
          )}

          <details className="card mt-4 p-4 lg:hidden">
            <summary className="cursor-pointer font-semibold text-gray-900">On this page</summary>
            <div className="mt-3">
              <Contents />
            </div>
          </details>

          <Part>Start here</Part>

          <Section title="What the sandbox is" id="start">
            <p>
              A working copy of Ghana&apos;s mobile money system. The National Identification Authority issues Ghana Cards. Three networks (MTN, Telecel and AT) register SIMs and run wallets. Agents take cash in and pay it out. Banks hold accounts. The national
              switch (GhIPSS) carries payments between them. The Bank of Ghana and the NCA set the rules. Each has its own screen, and the phones work: you dial the wallet code, send money, get texts and take calls.
            </p>
            <p>
              Every team has its own copy, called a <b>world</b>. Nothing you do reaches another team, and you can save your world, roll it back or wipe it whenever you like. Nothing here touches real money or real people.
            </p>
          </Section>

          <Section title="Two ways to build" id="products">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="card p-4">
                <h3 className="font-semibold text-gray-900">An API an institution plugs in</h3>
                <p className="mt-1">
                  You build an API. A network, a bank or the national switch calls it at one of its own steps (when a PIN is chosen, when a payment is about to leave, when a SIM is about to be replaced) and does what your API answers.
                </p>
                <p className="mt-2 text-xs text-gray-600">
                  Read <a className="underline" href="#plugins">section 7</a>. Start from <a className="underline" href="#kit-plugin">the plug-in kit</a>.
                </p>
              </div>
              <div className="card p-4">
                <h3 className="font-semibold text-gray-900">An application of your own</h3>
                <p className="mt-1">
                  You build an app or a service that stands outside the institutions and uses what they give an outside company: their partner APIs, with credentials each institution issues to you. All three networks (MTN, Telecel and AT), every bank, the national switch and NIA have one.
                </p>
                <p className="mt-2 text-xs text-gray-600">
                  Read <a className="underline" href="#credentials">sections 1 to 6</a>. Start from <a className="underline" href="#kit-app">the application kit</a>.
                </p>
              </div>
            </div>
            <p>
              Either way, the <b>Fraud console</b> tests what you built: it plays fraud incidents through your world, or sends them straight to your application, and counts how many were stopped (<a className="underline" href="#fraud">section 13</a>). If your
              work is on data rather than a live service, the simulated country comes with every transaction labelled (<a className="underline" href="#dataset">section 12</a>).
            </p>
          </Section>

          <Section title="Your first 15 minutes" id="first">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                <b>Open your team&apos;s link.</b> It is on your team card, as a link and as a QR code. You land on {home ? screen("", "your team's home page") : "your team's home page"}, which lists every system.
              </li>
              <li>
                <b>Decide what your world starts with.</b> It starts empty. On the home page, <b>Load the simulated country</b> fills it with thousands of people, their numbers, wallets, agents, merchants, bank accounts and three months of history, part of it fraud.
                Do this first if you want it: loading replaces what is in the world (what was there is kept as a save point).
              </li>
              <li>
                <b>Create two test customers.</b> On the home page, under <b>A ready test customer</b>, choose a network and press <b>Create a test customer</b>, twice. Each gets a number, a wallet with GHS 500 and a PIN that you are shown. Write the PINs down.
                (People in the simulated country have PINs too, but you are not told them, as in real life.)
              </li>
              <li>
                <b>Make a payment.</b> Press <b>Open this phone</b> beside the first customer. On the phone, dial the wallet code, choose to send money, enter the second customer&apos;s number and an amount, and confirm with the PIN.
                The wallet codes: {approvals.map((a, i) => (
                  <span key={a.name}>
                    {i > 0 && ", "}
                    <code>{a.code}</code> for {a.wallet}
                  </span>
                ))}
                .
              </li>
              <li>
                <b>See it from the other side.</b> Open that network&apos;s back office and look under <b>Transactions</b>: the payment is there, with its fee. If the two customers are on different networks, it is also on the national switch under <b>Routed payments</b>.
              </li>
              <li>
                <b>Get a starter kit running</b> (<a className="underline" href="#kits">below</a>), so you have something of your own answering before you write a line of your idea.
              </li>
              <li>
                <b>Run the Fraud console</b> once with nothing built, to see what gets through today. It needs the simulated country loaded.
              </li>
            </ol>
            <p>
              To use a real phone as a customer&apos;s phone, scan the phone QR code on the home page with it. That phone then shows only the phone, while your laptop keeps the consoles.
            </p>
          </Section>

          <Section title="The assistant" id="assistant">
            <p>
              You can also tell the sandbox what you want in plain words. The assistant is a small team of AI agents that works in your world on your instructions: it does the work step by step, shows each step as it happens, and tells you what happened. Open it with
              the <b>Assistant</b> button in the corner of any page, or on its own page from {home ? screen("/assistant", "your team's home") : "your team's home page"}. If the button is not there, the organisers have not switched the assistant on.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <b>What you can ask for.</b> Anything that can be done at the consoles or on a phone: &quot;create two test customers on MTN and send GHS 20 from one to the other&quot;, &quot;set up a mobile money agent on Telecel with GHS 5,000 of float&quot;, &quot;raise the
                daily limit for minimum KYC wallets&quot;, &quot;plug my API at bridge://laptop into payments on MTN and test it&quot;, &quot;run 10 SIM swap incidents and tell me what got through&quot;, &quot;how many failed payments were there yesterday, by reason&quot;, &quot;how does my
                application ask a customer for a payment&quot;.
              </li>
              <li>
                <b>Who does the work.</b> The assistant hands each job to a specialist: a builder for setting things up, an operator who uses phones and counters, an integrator for your API and the fraud simulator, an analyst for the data, and a guide who
                answers from this documentation. You see who is working and each step they take.
              </li>
              <li>
                <b>It asks first.</b> Before wiping your world, rolling it back, or removing something, it shows you what it wants to do and waits for <b>Approve</b> or <b>Decline</b>.
              </li>
              <li>
                <b>What it will not do.</b> It works only in your own team&apos;s world. It never shows a wallet PIN, except for a customer it created for you. It does not suggest what to build: that is yours to decide.
              </li>
              <li>
                <b>Check its work.</b> It reports what its tools returned, and it can be wrong, as any assistant can. Everything it does is on the consoles for you to see.
              </li>
            </ul>
            <p className="text-xs text-gray-600">
              What you say to the assistant, and what it reads from your world to answer, is sent to the AI service that runs it. Your team key is not. From a script: <code>POST {"{base}"}/assistant</code> with <code>{`{"text": "…"}`}</code> and your team key; the
              answer comes back as a stream of events.
            </p>
          </Section>

          <Section title="What each screen is" id="systems">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <tbody>
                  {(
                    [
                      ["", "Team home", "Where everything starts: every system, the QR codes for phones, test customers, the simulated country, save points."],
                      ["/nia", "NIA", "The Ghana Card register. Enrols people; shows every identity check institutions have made."],
                      ["/nca", "NCA", "SIM registration rules, the central register of every number against its Ghana Card, USSD short codes."],
                      ["/bog", "Bank of Ghana", "KYC limits for wallets, and whether each network's e-money is fully backed."],
                      ["/telco/mtn", "A network's back office", "SIM stock, registration points, wallets, agents, merchants, transactions, calls, texts, services, fees and menus, API partners, Plug-ins. One each for MTN, Telecel and AT."],
                      ["/care/mtn", "Customer care", "A network's call centre: complaints, disputes, holds and returning money."],
                      ["/sim-agent/mtn", "SIM registration point", "Registers a SIM against a Ghana Card and fingerprint, replaces a SIM, resets a wallet PIN, raises KYC."],
                      ["/momo-agent/mtn", "Mobile money agent", "Opens wallets in person, takes cash in, pays cash out."],
                      ["/phone", "Phone", "Any registered number: dial codes, messages, calls, the wallet."],
                      ["/bank/gcb", "A bank", "Accounts, the counter, transfers, agent float, the cash machine, API partners, Plug-ins."],
                      ["/switch", "National switch", "Payments between networks and banks, what each owes, settlement, Plug-ins."],
                      ["/fraud", "Fraud console", "Plays fraud incidents against what you built and shows the results."],
                      ["/assistant", "Assistant", "Tell it what you want done in your world, in plain words, and it does it."],
                    ] as const
                  ).map(([path, name, about]) => (
                    <tr key={name} className="border-b border-gray-100 align-top">
                      <td className="whitespace-nowrap px-2 py-2 font-medium text-gray-900">{home ? <Link className="underline" href={`${home}${path}`}>{name}</Link> : name}</td>
                      <td className="px-2 py-2">{about}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Part>Starter kits</Part>

          <Section title="The kits" id="kits">
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
            <p className="text-xs text-gray-600">The same files are in the <code>examples</code> folder of the sandbox&apos;s repository.</p>
          </Section>

          <Section title="Run a plug-in API" id="kit-plugin">
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Download <code>plugin_api.py</code> or <code>plugin-api.mjs</code> and run it: <code>python3 plugin_api.py</code> or <code>node plugin-api.mjs</code> (on Windows, <code>python</code> in place of <code>python3</code>). It listens on port 4010 and prints{" "}
                <code>Listening on port 4010</code>.
              </li>
              <li>
                Make sure the sandbox can reach it: see <a className="underline" href="#reach">where your API has to be</a>. From a laptop, that means starting <a className="underline" href="#bridge">the bridge</a> and using <code>bridge://laptop</code> as the address.
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
              Which answers each step accepts, and exactly what it sends you, is in <a className="underline" href="#plugins">section 7</a>. While it is deciding, your API can ask the sandbox anything it likes, such as whether a SIM was replaced lately
              (<a className="underline" href="#network">section 3</a>).
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
              An application that should be <em>sent</em> fraud incidents by the Fraud API receives them in the same format as a plug-in API, so start that part from the plug-in kit and connect it as <a className="underline" href="#fraud">section 13</a> describes.
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
                    <b>The bridge (simplest).</b> Keep your API on your laptop and run the bridge beside it. Nothing to install, no account, and the address never changes. See <a className="underline" href="#bridge">the next section</a>.
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
                one cannot call your laptop, so there you run <a className="underline" href="#bridge">the bridge</a>, host the API at a public <code>https://</code> address, or open a tunnel. The bridge works here too, if you want to practise with it.
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
                Download <code>bridge.py</code> or <code>bridge.mjs</code> (<a className="underline" href="#kits">above</a>) and start it beside your API. It does not matter which one you use, whatever your API is written in:
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

          <Part>Reference</Part>
          <p className="mt-2 text-gray-600">There are four kinds of API here, and they are for different jobs.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-gray-700">
            <li>
              <b>Partner APIs</b> (sections 1 to 6) are what an institution gives an outside company, such as a licensed payments or messaging business. You call them with credentials that institution issued, not with your team key.
            </li>
            <li>
              <b>Plug-in points</b> (section 7) work the other way round: <em>you</em> build an API, and a network, a bank or the national switch plugs it into one of its own steps. It asks your API every time that step happens and does what you answer.
            </li>
            <li>
              <b>Console API</b> (sections 8 to 12) does everything the consoles do, with your team key. Use it to set up your world from a script, or when your team is acting as the institution itself.
            </li>
            <li>
              <b>Fraud API</b> (section 13) tests what you have built: it plays fraud incidents through the sandbox, or sends them straight to your application, and your team&apos;s console shows how many were stopped.
            </li>
          </ul>
          <p className="mt-2 text-xs text-gray-600">
            Base URL: <code className="break-all">{base}</code>. Amounts are in cedis. Your own web page can call any of this straight from the browser, wherever the page is served from, with the key or the credentials in a header; a page on another site cannot use a
            console sign-in.
          </p>

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
              Put your API where the sandbox can reach it (see <a className="underline" href="#reach">where your API has to be</a>)
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
              The <a className="underline" href="#kits">starter kits</a> <code>plugin_api.py</code> and <code>plugin-api.mjs</code> answer &quot;allow&quot; to everything and print what they were sent. Plug an API in from a script:
            </p>
            <Code>{`curl -X POST ${base}/s/telco/mtn ${auth} ${json} -d '{"action":"plugin_add","name":"My API","point":"payment.authorize","url":"https://your-api.example.com/","ifDown":"carry_on"}'`}</Code>
          </Section>

          <Section title="8. Console API: one endpoint per institution" id="console">
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

          <Part>Help</Part>

          <Section title="When something goes wrong" id="problems">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs">
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
    </>
  );
}

/** The address of one kind of API on each of the three networks, so nobody has to work it out from a pattern. */
function NetworkAddresses({ base, api }: { base: string; api: "momo" | "network" }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-xs">
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

function Contents() {
  return (
    <div className="space-y-4">
      {CONTENTS.map((part) => (
        <div key={part.title}>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{part.title}</div>
          <ul className="mt-1 space-y-1">
            {part.items.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="text-gray-700 hover:text-[#3b1f6e] hover:underline">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Part({ children }: { children: React.ReactNode }) {
  return <div className="mt-10 border-b border-gray-200 pb-1 text-xs font-semibold uppercase tracking-[0.15em] text-[#3b1f6e]">{children}</div>;
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
