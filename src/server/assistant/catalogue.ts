import { BANK_IDS, TELCOS } from "@/engine/util";

/**
 * Everything that can be done at each institution's console, written out for the assistant: the action's
 * name, what it does, and the fields it takes. The consoles themselves are the source of truth; a test
 * checks that every action a console supports is listed here and nothing else is, so the two cannot drift.
 * Amounts are in cedis. Numbers are Ghanaian mobile numbers such as 0241234567.
 */

export interface ActionInfo {
  does: string;
  /** Field name → what goes in it. A trailing "?" in the description marks an optional field. */
  fields: Record<string, string>;
  /** Hard to put back: the user is asked before the assistant does it. */
  askFirst?: boolean;
}

const partners: Record<string, ActionInfo> = {
  api_partner_create: { does: "Give an outside company API access. The answer carries its client ID and API key.", fields: { name: "the company's name", till: "a merchant's till number to collect into? (networks)", accountNo: "the account its calls act on? (banks)", callbackUrl: "where to tell it about outcomes?" } },
  api_partner_status: { does: "Suspend a company's API access, or restore it.", fields: { id: "the client ID", status: "suspended | active" } },
  api_partner_rotate: { does: "Issue a new API key for a company. The old one stops working.", fields: { id: "the client ID" }, askFirst: true },
};

const plugins: Record<string, ActionInfo> = {
  plugin_add: { does: "Plug an outside API into one of this institution's steps. It is asked every time the step happens.", fields: { name: "a name for it", point: "the step, for example payment.authorize (see the documentation, section 7)", url: "its address: https://… or bridge://laptop", ifDown: "carry_on | refuse? (what to do if it does not answer; default carry_on)", timeoutMs: "200 to 5000? (default 2000)" } },
  plugin_switch: { does: "Switch a plugged-in API off or back on without removing it.", fields: { id: "the plug-in's id", on: "true | false" } },
  plugin_remove: { does: "Unplug an API.", fields: { id: "the plug-in's id" }, askFirst: true },
  plugin_test: { does: "Send the plugged-in API an example question and report how it answered. Nothing is done for real.", fields: { id: "the plug-in's id" } },
};

const settings: ActionInfo = { does: "Change this institution's settings (fees, limits, menus, rules) with JSON Patch operations. Prefer the settings tools, which also read them.", fields: { operations: "a list of JSON Patch operations", summary: "one line saying what changed?" } };
const txn: ActionInfo = { does: "Show one transaction in full: both sides, fee, and its ledger entries.", fields: { txnId: "the transaction's id (tx_…)" } };

const telco: Record<string, ActionInfo> = {
  add_sims: { does: "Add blank SIM cards to stock.", fields: { count: "1 to 200" } },
  onboard_sim_agent: { does: "Authorise a SIM registration point: a service centre or a registration agent.", fields: { kind: "service_centre | registration_agent", name: "the outlet's name", town: "its town", card: "the Ghana Card of the person who runs it" } },
  sim_agent_status: { does: "Suspend a SIM registration point, or restore it.", fields: { id: "the point's id", status: "suspended | active" } },
  sim_status: { does: "Block, unblock or deactivate a number from the back office.", fields: { msisdn: "the number", status: "blocked | active | deactivated", reason: "why?" } },
  open_momo_agent: { does: "Open a mobile money agent in one go for a person with a Ghana Card: the head office registers a new agent line to them and it becomes an agent, with an optional starting float from the bank.", fields: { card: "the owner's Ghana Card", fingerprint: "their fingerprint code", otp: "the approval code texted to their first number, when they already have one?", name: "the shop's name", town: "its town", pin: "a 4-digit PIN for the agent wallet", float: "starting float in cedis?" } },
  onboard_momo_agent: { does: "Turn a registered line into a mobile money agent with its own agent number.", fields: { msisdn: "the agent's registered line", name: "the shop's name", town: "its town", pin: "a 4-digit PIN for the agent wallet" } },
  momo_agent_status: { does: "Suspend a mobile money agent, or restore it.", fields: { code: "the agent number", status: "suspended | active" } },
  onboard_merchant: { does: "Turn a registered line into a merchant with a till number.", fields: { msisdn: "the merchant's registered line", name: "the business name", category: "what it sells", town: "its town", pin: "a 4-digit PIN for the merchant wallet" } },
  wallet_status: { does: "Freeze a wallet, or make it active again.", fields: { msisdn: "the number", status: "frozen | active", reason: "why?" } },
  upgrade_tier: { does: "Change a wallet's KYC level.", fields: { msisdn: "the number", tier: "minimum | medium | enhanced", proof: "proof of address (needed for enhanced)?" } },
  reverse: { does: "Reverse a payment this network sent, returning the money to the sender.", fields: { txnId: "the transaction's id" } },
  short_code: { does: "Switch a provider's USSD short code on or off for this network's subscribers.", fields: { code: "the short code, for example *714#", on: "true | false" } },
  ...partners,
  ...plugins,
  settings,
  txn,
};

const care: Record<string, ActionInfo> = {
  open_ticket: { does: "Open a complaint for a customer who has passed the security questions.", fields: { msisdn: "the customer's number", category: "wrong_transfer | unauthorised | agent_complaint | sim_network | wallet_access | other", description: "what happened", txnId: "the transaction it is about?", verified: "yes (the caller answered the security questions)" } },
  note: { does: "Add a note to a ticket.", fields: { ticket: "the ticket id", text: "the note" } },
  hold: { does: "Put what the recipient still has of the disputed amount on hold.", fields: { ticket: "the ticket id" } },
  ask_recipient: { does: "Ask the recipient, by SMS, to agree to return the money.", fields: { ticket: "the ticket id" } },
  return_funds: { does: "Return held money to the sender.", fields: { ticket: "the ticket id" } },
  forward: { does: "Send the dispute to the recipient's network through the national switch.", fields: { ticket: "the ticket id" } },
  reverse_agent: { does: "Reverse a disputed cash-out in full, including the agent's till and commission.", fields: { ticket: "the ticket id" } },
  close: { does: "Close a ticket.", fields: { ticket: "the ticket id", outcome: "resolved | rejected", resolution: "what was decided" } },
  block_sim: { does: "Block a number reported lost or stolen.", fields: { msisdn: "the number", reason: "why?" } },
  freeze_wallet: { does: "Freeze a wallet.", fields: { msisdn: "the number", reason: "why?" } },
  txn,
};

const simAgent: Record<string, ActionInfo> = {
  register: { does: "Register a SIM to a person: their Ghana Card and fingerprint are checked with NIA and the number is switched on.", fields: { agent: "the registration point's id (the network's head office, e.g. MTN-HQ, is always open)", card: "the person's Ghana Card number", fingerprint: "their fingerprint code", msisdn: "a particular number from stock?", otp: "the approval code texted to their first number, when they already have one?" } },
  swap: { does: "Move a number to a replacement SIM card for its owner.", fields: { agent: "the registration point's id", msisdn: "the number", card: "the owner's Ghana Card", fingerprint: "the owner's fingerprint code" } },
  block: { does: "Block a number.", fields: { agent: "the registration point's id", msisdn: "the number", reason: "why?" } },
  unblock: { does: "Unblock a number for its owner.", fields: { agent: "the registration point's id", msisdn: "the number", card: "the owner's Ghana Card", fingerprint: "the owner's fingerprint code" } },
  deactivate: { does: "Disconnect a number for good, at its owner's request.", fields: { agent: "the registration point's id", msisdn: "the number", card: "the owner's Ghana Card", fingerprint: "the owner's fingerprint code" }, askFirst: true },
  pin_reset: { does: "Reset a wallet PIN for its owner. A temporary PIN is texted to the phone and must be replaced at the next dial.", fields: { agent: "the registration point's id", msisdn: "the number", card: "the owner's Ghana Card", fingerprint: "the owner's fingerprint code" } },
  upgrade_enhanced: { does: "Raise a wallet to enhanced KYC at a service centre.", fields: { agent: "a service centre's id", msisdn: "the number", card: "the owner's Ghana Card", fingerprint: "the owner's fingerprint code", proof: "proof of address" } },
  lookup: { does: "Look a number up at the counter: its status and who it is registered to.", fields: { agent: "the registration point's id", msisdn: "the number" } },
};

const momoAgent: Record<string, ActionInfo> = {
  register_customer: { does: "Open a wallet for a customer in person, on medium KYC.", fields: { agent: "the agent number", msisdn: "the customer's registered number", card: "their Ghana Card", fingerprint: "their fingerprint code", pin: "the PIN the customer chooses? (left out where the network texts a starting PIN)" } },
  cash_in: { does: "Take cash from a customer and put it in their wallet.", fields: { agent: "the agent number", msisdn: "the customer's number", amount: "cedis", pin: "the agent's PIN" } },
  cash_out: { does: "Ask a customer to approve a cash withdrawal (on networks where the agent starts it). The customer approves on their phone.", fields: { agent: "the agent number", msisdn: "the customer's number", amount: "cedis", card: "the customer's Ghana Card, checked at the counter" } },
  send_float: { does: "Send float to another agent.", fields: { agent: "the agent number", toCode: "the other agent's number", amount: "cedis", pin: "the agent's PIN" } },
  till: { does: "Put cash into the agent's till, or take it out.", fields: { agent: "the agent number", amount: "cedis", direction: "in | out" } },
  txn,
};

const bank: Record<string, ActionInfo> = {
  open_account: { does: "Open a personal bank account for a person.", fields: { card: "their Ghana Card", fingerprint: "their fingerprint code" } },
  deposit: { does: "Pay cash into an account over the counter.", fields: { account: "the account number", amount: "cedis" } },
  withdraw: { does: "Pay cash out of an account over the counter.", fields: { account: "the account number", amount: "cedis" } },
  transfer: { does: "Transfer to a bank account at any bank.", fields: { account: "the account to pay from", toAccountNo: "the account to pay", amount: "cedis", reference: "a reference?" } },
  to_wallet: { does: "Send money from the bank to a mobile money wallet (this is how an agent buys float).", fields: { msisdn: "the wallet's number", amount: "cedis", account: "the account to pay from? (left out: cash over the counter)", reference: "a reference?" } },
  atm_withdraw: { does: "Pay out at the cash machine against a voucher made on a phone.", fields: { msisdn: "the customer's number", code: "the voucher code" } },
  account_status: { does: "Freeze an account, or make it active again.", fields: { account: "the account number", status: "frozen | active" } },
  ...partners,
  ...plugins,
  settings,
  txn,
};

/** Each console the assistant can read and act at, by the path the console API uses. */
export const CATALOGUE: Record<string, { what: string; actions: Record<string, ActionInfo> }> = {
  hub: { what: "The team's home: counts of everything, the steps to build a world, recent activity.", actions: { txn, test_customer: { does: "Make a customer ready to use: a new person, a registered number, a wallet on medium KYC with a known PIN and money in it.", fields: { network: "mtn | telecel | at", amount: "starting balance in cedis? (default 500)" } } } },
  fraud: {
    what: "The Fraud console: plays fraud incidents against what the team built and shows how many were stopped.",
    actions: {
      run: { does: "Start a run of fraud incidents. It carries on in the background; read this console for results.", fields: { kinds: "a kind of fraud, a list of kinds, or all", incidents: "how many incidents?", ordinary: "how many pieces of honest activity alongside?", app: "the id of a connected application to send them to? (left out: the APIs plugged into the institutions)" } },
      stop: { does: "Stop the run in progress after the current incident.", fields: {} },
      connect_app: { does: "Connect a standalone application so incidents can be sent straight to it.", fields: { name: "its name", url: "its address: https://… or bridge://laptop", kinds: "the kinds of fraud it is built to stop, or all" } },
      disconnect_app: { does: "Disconnect an application.", fields: { id: "the application's id" }, askFirst: true },
    },
  },
  nia: {
    what: "The National Identification Authority: the Ghana Card register and the log of identity checks.",
    actions: {
      enrol: { does: "Enrol a person and issue their Ghana Card. The answer carries the card number and fingerprint code.", fields: { firstNames: "first names", surname: "surname", dob: "date of birth, YYYY-MM-DD", gender: "F | M", region: "a region of Ghana, for example Ashanti", town: "a town", nationality: "nationality? (default Ghanaian)" } },
      card_status: { does: "Suspend a Ghana Card, or restore it.", fields: { card: "the card number", status: "suspended | active" } },
      ...partners,
    },
  },
  ...Object.fromEntries(TELCOS.map((t) => [`telco/${t}`, { what: `The ${t.toUpperCase()} back office: SIMs, registration points, wallets, agents, merchants, transactions, calls, texts, services, API partners, plug-ins.`, actions: telco }])),
  ...Object.fromEntries(TELCOS.map((t) => [`care/${t}`, { what: `${t.toUpperCase()} customer care: complaints, disputes, holds and returning money.`, actions: care }])),
  ...Object.fromEntries(TELCOS.map((t) => [`sim-agent/${t}`, { what: `A ${t.toUpperCase()} SIM registration point: registers and replaces SIMs, resets PINs, raises KYC.`, actions: simAgent }])),
  ...Object.fromEntries(TELCOS.map((t) => [`momo-agent/${t}`, { what: `A ${t.toUpperCase()} mobile money agent's counter: opens wallets, cash in, cash out, float.`, actions: momoAgent }])),
  ...Object.fromEntries(BANK_IDS.map((b) => [`bank/${b}`, { what: `The bank ${b}: accounts, the counter, transfers, agent float, the cash machine, API partners, plug-ins.`, actions: bank }])),
  switch: {
    what: "The national switch (GhIPSS): payments between networks and banks, what each owes, settlement.",
    actions: {
      connect: { does: "Connect a participant to the switch, or disconnect it.", fields: { participant: "a network or bank id", connected: "true | false" } },
      settle: { does: "Run net settlement now: every participant's position is settled through the Bank of Ghana.", fields: {} },
      ...partners,
      ...plugins,
      settings,
      txn,
    },
  },
  bog: { what: "The Bank of Ghana: KYC limits for wallets, and whether each network's e-money is fully backed.", actions: { settings } },
  nca: {
    what: "The National Communications Authority: SIM registration rules, the central register, USSD short codes.",
    actions: {
      allocate_code: { does: "Allocate a USSD short code to a provider, with the address of their application. Each network then switches it on.", fields: { code: "the short code, for example *714#", owner: "the provider's name", url: "the application's address: https://… or bridge://laptop" } },
      revoke_code: { does: "Take a short code back from its provider.", fields: { code: "the short code" }, askFirst: true },
      order_block: { does: "Order a number blocked on the regulator's directive.", fields: { msisdn: "the number", reason: "why?" } },
      settings,
    },
  },
};

/** The same, as text the assistant reads. */
export function describeActions(system?: string): string {
  const pick = system ? Object.entries(CATALOGUE).filter(([path]) => path === system || path.startsWith(`${system}/`)) : Object.entries(CATALOGUE);
  if (!pick.length) return `There is no system called "${system}". The systems are: ${Object.keys(CATALOGUE).join(", ")}.`;
  // One network's or one bank's console stands for the others: they take the same actions.
  const seen = new Set<Record<string, ActionInfo>>();
  const out: string[] = [];
  for (const [path, info] of pick) {
    if (seen.has(info.actions) && !system) {
      out.push(`${path}: the same actions as the first of its kind above.`);
      continue;
    }
    seen.add(info.actions);
    out.push(`${path}: ${info.what}`);
    for (const [name, a] of Object.entries(info.actions)) {
      const fields = Object.entries(a.fields).map(([f, d]) => `${f} (${d})`).join("; ");
      out.push(`  - ${name}: ${a.does}${fields ? ` Fields: ${fields}.` : ""}${a.askFirst ? " The user is asked to approve this first." : ""}`);
    }
  }
  return out.join("\n");
}
