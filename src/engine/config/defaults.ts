import { BANK_IDS, PARTICIPANTS, TELCOS, TELCO_INFO, type Telco } from "../util";
import { DEFAULT_ATM, DEFAULT_BILLERS, DEFAULT_BUNDLES } from "../catalogue";
import type { BankConfig, BogConfig, Menu, NcaConfig, SwitchConfig, TelcoConfig } from "./schemas";

/**
 * Starting settings for every institution in a new world. Menu wording approximates each
 * telco's live menu; replace with the trees the telco partners provide.
 */

type EarlierLabels = { title: string; send: string; cashout: string; merchant: string; wallet: string; sendSub: [string, string, string] };

function earlierMenu(shortcode: string, l: EarlierLabels): Menu {
  const transferTail = (prefix: string) => ({
    [`${prefix}_amount`]: { type: "input", text: "Enter amount", var: "amount", kind: "amount", next: `${prefix}_ref` },
    [`${prefix}_ref`]: { type: "input", text: "Enter reference", var: "reference", kind: "text", next: `${prefix}_pin` },
    [`${prefix}_pin`]: {
      type: "input",
      text: "Transfer GHS{{amount}} to {{recipient_name}} {{recipient}}\nFee: GHS{{fee}}\nRef: {{reference}}\nEnter PIN to confirm",
      var: "pin",
      kind: "pin",
      next: "do_send",
    },
  });

  return {
    shortcode,
    start: "main",
    screenCharLimit: 182,
    sessionTimeoutSec: 120,
    nodes: {
      main: {
        type: "menu",
        text: l.title,
        options: [
          { key: "1", label: l.send, next: "send" },
          { key: "2", label: l.merchant, next: "merchant_till" },
          { key: "3", label: "Airtime & Bundles", next: "not_available" },
          { key: "4", label: l.cashout, next: "approvals" },
          { key: "5", label: "Financial Services", next: "not_available" },
          { key: "6", label: l.wallet, next: "wallet" },
        ],
      },
      send: {
        type: "menu",
        text: l.send,
        options: [
          { key: "1", label: l.sendSub[0], next: "onnet_number" },
          { key: "2", label: l.sendSub[1], next: "offnet_number" },
          { key: "3", label: l.sendSub[2], next: "bank_account" },
        ],
      },

      onnet_number: { type: "input", text: "Enter mobile number", var: "recipient", kind: "msisdn", next: "onnet_confirm" },
      onnet_confirm: { type: "input", text: "Confirm number", var: "recipient_confirm", kind: "msisdn", next: "onnet_amount" },
      ...transferTail("onnet"),

      offnet_number: { type: "input", text: "Enter recipient number (any network)", var: "recipient", kind: "msisdn", next: "offnet_confirm" },
      offnet_confirm: { type: "input", text: "Confirm number", var: "recipient_confirm", kind: "msisdn", next: "offnet_amount" },
      ...transferTail("offnet"),

      bank_account: { type: "input", text: "Enter bank account number", var: "account", kind: "account", next: "bank_amount" },
      bank_amount: { type: "input", text: "Enter amount", var: "amount", kind: "amount", next: "bank_pin" },
      bank_pin: { type: "input", text: "Send GHS{{amount}} to {{recipient_name}}\nFee: GHS{{fee}}\nEnter PIN to confirm", var: "pin", kind: "pin", next: "do_bank" },

      merchant_till: { type: "input", text: "Enter merchant ID", var: "till", kind: "till", next: "merchant_amount" },
      merchant_amount: { type: "input", text: "Enter amount", var: "amount", kind: "amount", next: "merchant_pin" },
      merchant_pin: { type: "input", text: "Pay GHS{{amount}} to {{recipient_name}}\nEnter PIN to confirm", var: "pin", kind: "pin", next: "do_merchant" },

      wallet: {
        type: "menu",
        text: l.wallet,
        options: [
          { key: "1", label: "Check Balance", next: "balance_pin" },
          { key: "2", label: "Mini Statement", next: "statement_pin" },
          { key: "3", label: "Change PIN", next: "change_pin" },
          { key: "4", label: "Report a Problem", next: "report_problem" },
        ],
      },
      balance_pin: { type: "input", text: "Enter PIN", var: "pin", kind: "pin", next: "do_balance" },
      statement_pin: { type: "input", text: "Enter PIN", var: "pin", kind: "pin", next: "do_statement" },

      approvals: { type: "action", action: "approvals" },
      change_pin: { type: "action", action: "change_pin" },
      report_problem: { type: "action", action: "report_problem" },
      do_send: { type: "action", action: "send_money" },
      do_bank: { type: "action", action: "to_bank" },
      do_merchant: { type: "action", action: "pay_merchant" },
      do_balance: { type: "action", action: "check_balance" },
      do_statement: { type: "action", action: "mini_statement" },
      not_available: { type: "message", text: "This service is not part of the sandbox." },
    },
  } as Menu;
}

/** The menus every network had before each got its own. Kept only to recognise a world that still has one unchanged. */
export const EARLIER_MENUS: Record<Telco, Menu> = {
  mtn: earlierMenu("*170#", { title: "MTN MoMo", send: "Transfer Money", merchant: "MoMoPay & Pay Bill", cashout: "Allow Cash Out", wallet: "My Wallet", sendSub: ["MoMo User", "Other Networks", "Bank Account"] }),
  telecel: earlierMenu("*110#", { title: "Telecel Cash", send: "Send Money", merchant: "Make Payments", cashout: "Withdraw Cash", wallet: "My Wallet", sendSub: ["Telecel Cash User", "Other Networks", "Bank Account"] }),
  at: earlierMenu("*110#", { title: "AT Money", send: "Send Money", merchant: "Pay Merchant", cashout: "Approve Cash Out", wallet: "My Account", sendSub: ["AT Money User", "Other Networks", "Bank Account"] }),
};

type Nodes = Menu["nodes"];
const input = (text: string, v: string, kind: string, next: string) => ({ type: "input", text, var: v, kind, next }) as Nodes[string];
const set = (v: string, value: string, next: string) => ({ type: "set", var: v, value, next }) as Nodes[string];
const menu = (text: string, options: [string, string][]) => ({ type: "menu", text, options: options.map(([label, next], i) => ({ key: String(i + 1), label, next })) }) as Nodes[string];
const action = (a: string) => ({ type: "action", action: a }) as Nodes[string];
const message = (text: string) => ({ type: "message", text }) as Nodes[string];

/**
 * The parts every network's wallet menu is built from. The networks differ in how the parts are
 * arranged, what they are called, and how cash is withdrawn; the steps inside each part are the same.
 */
function parts(brand: { wallet: string; name: string }, o: { confirmNumber: boolean }): Nodes {
  // Sending to a wallet: the number (typed twice on MTN), the amount, a reference, then the PIN against the recipient's name.
  const transfer = (prefix: string, ask: string): Nodes => ({
    [`${prefix}_number`]: input(ask, "recipient", "msisdn", o.confirmNumber ? `${prefix}_confirm` : `${prefix}_amount`),
    ...(o.confirmNumber ? { [`${prefix}_confirm`]: input("Confirm number", "recipient_confirm", "msisdn", `${prefix}_amount`) } : {}),
    [`${prefix}_amount`]: input("Enter amount", "amount", "amount", `${prefix}_ref`),
    [`${prefix}_ref`]: input("Enter reference", "reference", "text", `${prefix}_pin`),
    [`${prefix}_pin`]: input("Transfer GHS{{amount}} to {{recipient_name}} {{recipient}}\nFee: GHS{{fee}}\nRef: {{reference}}\nEnter PIN to confirm", "pin", "pin", "do_send"),
  });
  const bundles = DEFAULT_BUNDLES.map((b) => [`${b.name} GHS${b.price}`, `bundle_${b.id}`] as [string, string]);
  const billers = DEFAULT_BILLERS.map((b) => [b.name, `biller_${b.id}`] as [string, string]);
  return {
    ...transfer("onnet", "Enter mobile number"),
    ...transfer("offnet", "Enter recipient number (any network)"),

    bank_account: input("Enter bank account number", "account", "account", "bank_amount"),
    bank_amount: input("Enter amount", "amount", "amount", "bank_pin"),
    bank_pin: input("Send GHS{{amount}} to {{recipient_name}}\nFee: GHS{{fee}}\nEnter PIN to confirm", "pin", "pin", "do_bank"),

    merchant_till: input("Enter merchant ID", "till", "till", "merchant_amount"),
    merchant_amount: input("Enter amount", "amount", "amount", "merchant_pin"),
    merchant_pin: input("Pay GHS{{amount}} to {{recipient_name}}\nEnter PIN to confirm", "pin", "pin", "do_merchant"),

    // Withdrawing at an agent, started by the customer: the agent's number, the amount, the PIN.
    withdraw_agent: set("service", "withdraw", "withdraw_agent_no"),
    withdraw_agent_no: input("Enter agent number", "agent", "agent", "withdraw_amount"),
    withdraw_amount: input("Enter amount", "amount", "amount", "withdraw_pin"),
    withdraw_pin: input("Withdraw GHS{{amount}} from {{agent_name}}\nFee: GHS{{fee}}\nEnter PIN to confirm", "pin", "pin", "do_withdraw"),
    // Withdrawing at a cash machine: a voucher, used at the machine with the phone number.
    withdraw_atm: set("service", "atm", "atm_amount"),
    atm_amount: input("Enter amount (multiples of GHS 10)", "amount", "amount", "atm_pin"),
    atm_pin: input("Voucher for GHS{{amount}} at a cash machine\nFee: GHS{{fee}}\nEnter PIN to confirm", "pin", "pin", "do_atm"),

    airtime: menu("Airtime & Bundles", [["Buy Airtime", "airtime_who"], ["Buy Data Bundle", "bundle_pick"], ["Check Airtime & Data", "do_airtime_balance"]]),
    airtime_who: menu("Buy Airtime", [["For my number", "airtime_self"], ["For another number", "airtime_other"]]),
    airtime_self: set("service", "airtime", "airtime_amount"),
    airtime_other: set("service", "airtime", "airtime_number"),
    airtime_number: input(`Enter ${brand.name} number`, "airtime_to", "msisdn", "airtime_amount"),
    airtime_amount: input("Enter amount", "amount", "amount", "airtime_pin"),
    airtime_pin: input("Buy GHS{{amount}} airtime for {{top_up_to}}\nEnter PIN to confirm", "pin", "pin", "do_airtime"),
    bundle_pick: menu("Buy Data Bundle", bundles),
    ...Object.fromEntries(DEFAULT_BUNDLES.map((b) => [`bundle_${b.id}`, set("bundle", b.id, "bundle_pin")])),
    bundle_pin: input("Buy {{bundle_name}} for GHS{{amount}}\nEnter PIN to confirm", "pin", "pin", "do_bundle"),

    bills: menu("Pay Bill", billers),
    ...Object.fromEntries(DEFAULT_BILLERS.map((b) => [`biller_${b.id}`, set("biller", b.id, "bill_service")])),
    bill_service: set("service", "bill", "bill_ref"),
    bill_ref: input("{{biller_ask}}", "ref", "biller_ref", "bill_amount"),
    bill_amount: input("Enter amount", "amount", "amount", "bill_pin"),
    bill_pin: input("Pay GHS{{amount}} to {{biller_name}} for {{ref}}\nFee: GHS{{fee}}\nEnter PIN to confirm", "pin", "pin", "do_bill"),

    financial: menu("Financial Services", [["Bank Services", "bank_services"], ["Savings", "partner_product"], ["Loans", "partner_product"], ["Insurance", "partner_product"]]),
    bank_services: menu("Bank Services", [["Wallet to Bank", "bank_account"], ["Bank to Wallet", "frombank"]]),
    frombank: set("service", "frombank", "frombank_amount"),
    frombank_amount: input("Move money from {{bank_name}} to your wallet\nEnter amount", "amount", "amount", "frombank_pin"),
    frombank_pin: input("Move GHS{{amount}} from {{bank_name}} to your wallet\nEnter PIN to confirm", "pin", "pin", "do_frombank"),
    partner_product: message(`This product is run by a partner of ${brand.name} and is not part of the sandbox.`),

    verify_agent: input("Enter the agent number to check", "agent_check", "text", "do_verify_agent"),
    balance_pin: input("Enter PIN", "pin", "pin", "do_balance"),
    statement_pin: input("Enter PIN", "pin", "pin", "do_statement"),

    approvals: action("approvals"),
    change_pin: action("change_pin"),
    report_problem: action("report_problem"),
    do_send: action("send_money"),
    do_bank: action("to_bank"),
    do_merchant: action("pay_merchant"),
    do_balance: action("check_balance"),
    do_statement: action("mini_statement"),
    do_withdraw: action("withdraw_at_agent"),
    do_atm: action("atm_voucher"),
    do_airtime: action("buy_airtime"),
    do_bundle: action("buy_bundle"),
    do_bill: action("pay_bill"),
    do_frombank: action("from_bank"),
    do_verify_agent: action("verify_agent"),
    do_airtime_balance: action("airtime_balance"),
  };
}

const frame = (shortcode: string, nodes: Nodes): Menu => ({ shortcode, start: "main", screenCharLimit: 182, sessionTimeoutSec: 120, nodes }) as Menu;

/**
 * MTN MoMo, *170#. Cash is withdrawn the MTN way: the agent sends the request and the customer
 * allows it under option 4.
 */
const mtnMenu = (): Menu =>
  frame("*170#", {
    main: menu("MTN MoMo", [["Transfer Money", "send"], ["MoMoPay & Pay Bill", "momopay"], ["Airtime & Bundles", "airtime"], ["Allow Cash Out", "approvals"], ["Financial Services", "financial"], ["My Wallet", "wallet"]]),
    send: menu("Transfer Money", [["MoMo User", "onnet_number"], ["Other Networks", "offnet_number"], ["Bank Account", "bank_account"]]),
    momopay: menu("MoMoPay & Pay Bill", [["MoMoPay", "merchant_till"], ["Pay Bill", "bills"]]),
    wallet: menu("My Wallet", [["Check Balance", "balance_pin"], ["Mini Statement", "statement_pin"], ["Change PIN", "change_pin"], ["Report a Problem", "report_problem"], ["My Approvals", "approvals"], ["Verify an Agent", "verify_agent"]]),
    ...parts(TELCO_INFO.mtn, { confirmNumber: true }),
  });

/**
 * Telecel Cash, *110#. The customer starts a withdrawal on their own phone: at an agent with the
 * agent's number, or at a cash machine with a voucher. Requests to approve are under My Wallet.
 */
const telecelMenu = (): Menu =>
  frame("*110#", {
    main: menu("Telecel Cash", [["Send Money", "send"], ["Withdraw Cash", "withdraw"], ["Airtime & Bundles", "airtime"], ["Make Payments", "payments"], ["Financial Services", "financial"], ["My Wallet", "wallet"], ["Self Service", "self_service"]]),
    send: menu("Send Money", [["To Telecel Cash Number", "onnet_number"], ["To Other Networks", "offnet_number"], ["To Bank Account", "bank_account"]]),
    withdraw: menu("Withdraw Cash", [["From Agent", "withdraw_agent"], ["From ATM", "withdraw_atm"]]),
    payments: menu("Make Payments", [["Buy Goods", "merchant_till"], ["Pay Bill", "bills"], ["Approve a Payment Request", "approvals"]]),
    wallet: menu("My Wallet", [["Check Balance", "balance_pin"], ["Mini Statement", "statement_pin"], ["Change PIN", "change_pin"], ["My Approvals", "approvals"]]),
    self_service: menu("Self Service", [["Verify an Agent", "verify_agent"], ["Report a Problem", "report_problem"]]),
    ...parts(TELCO_INFO.telecel, { confirmNumber: false }),
  });

/**
 * AT Money, *110#. As on Telecel, the customer starts a withdrawal on their own phone. Paying a
 * bill and buying goods each have their own place on the first screen.
 */
const atMenu = (): Menu =>
  frame("*110#", {
    main: menu("AT Money", [["Send Money", "send"], ["Cash Out", "withdraw"], ["Airtime & Bundles", "airtime"], ["Pay Bill", "bills"], ["Buy Goods", "merchant_till"], ["Financial Services", "financial"], ["My Wallet", "wallet"]]),
    send: menu("Send Money", [["AT Money Subscriber", "onnet_number"], ["Other Networks", "offnet_number"], ["Bank Account", "bank_account"]]),
    withdraw: menu("Cash Out", [["From Agent", "withdraw_agent"], ["From ATM", "withdraw_atm"]]),
    wallet: menu("My Wallet", [["Check Balance", "balance_pin"], ["Mini Statement", "statement_pin"], ["Change PIN", "change_pin"], ["My Approvals", "approvals"], ["Verify an Agent", "verify_agent"], ["Report a Problem", "report_problem"]]),
    ...parts(TELCO_INFO.at, { confirmNumber: false }),
  });

const MENUS: Record<Telco, Menu> = { mtn: mtnMenu(), telecel: telecelMenu(), at: atMenu() };

/** Where on each network's menu a customer answers a request (a cash-out, a payment request, a claim to return money). */
export const APPROVALS_PATH: Record<Telco, string> = {
  mtn: "choose option 4",
  telecel: "choose 6 (My Wallet), then 4 (My Approvals)",
  at: "choose 7 (My Wallet), then 4 (My Approvals)",
};

const FREE = { bands: [{ upTo: null, pct: 0, flat: 0 }] };

// MTN MoMo tariff (confirmed by the organisers). AT uses the same schedule.
const mtnFees = {
  p2p_onnet: { bands: [{ upTo: 1000, pct: 0.75, flat: 0 }, { upTo: null, pct: 0, flat: 7.5 }] },
  p2p_offnet: { bands: [{ upTo: 1000, pct: 0.75, flat: 0 }, { upTo: null, pct: 0, flat: 7.5 }] },
  cashout: { bands: [{ upTo: 49.99, pct: 0, flat: 0.5 }, { upTo: 1999.99, pct: 1, flat: 0 }, { upTo: null, pct: 0, flat: 20 }] },
  merchant: FREE,
  to_bank: { bands: [{ upTo: null, pct: 0.75, flat: 0, max: 5 }] },
};

// Telecel Cash tariff (confirmed by the organisers). Wallet-to-bank uses MTN's rate, as agreed.
const telecelFees = {
  p2p_onnet: FREE,
  p2p_offnet: { bands: [{ upTo: 100, pct: 0, flat: 0 }, { upTo: 1000, pct: 0.5, flat: 0 }, { upTo: null, pct: 0, flat: 5 }] },
  cashout: { bands: [{ upTo: 50, pct: 0, flat: 0.5 }, { upTo: 2000, pct: 1, flat: 0 }, { upTo: null, pct: 0, flat: 20 }] },
  merchant: FREE,
  to_bank: mtnFees.to_bank,
};

export function notifications(telco: Telco): Required<TelcoConfig["notifications"]> {
  const brand = TELCO_INFO[telco];
  const on = (template: string) => ({ enabled: true, template });
  return {
    sim_registered: on(`Welcome to ${brand.name}. Your number {{msisdn}} is registered to {{name}} with Ghana Card {{ghana_card}}. Dial ${brand.shortcode} for ${brand.wallet}.`),
    sim_swapped: on(`Your number {{msisdn}} has been moved to a new SIM card. If this was not you, call ${brand.careLine} immediately.`),
    wallet_opened: on(`Your ${brand.wallet} wallet is open. Never share your PIN with anyone, including staff. Dial ${brand.shortcode} to start.`),
    kyc_upgraded: on(`Your ${brand.wallet} wallet has been upgraded to {{tier}} KYC. Your new daily limit is GHS {{daily}}.`),
    pin_reset: on(`Your ${brand.wallet} PIN has been reset. Your temporary PIN is {{pin}}. Dial ${brand.shortcode} and change it now.`),
    transfer_sent: on("Payment made for GHS {{amount}} to {{counterparty_name}} {{counterparty}}. Fee: GHS {{fee}}. Balance: GHS {{balance}}. Ref: {{reference}}. Trans ID: {{txn_id}}"),
    transfer_received: on("Payment received for GHS {{amount}} from {{counterparty_name}} {{counterparty}}. Balance: GHS {{balance}}. Ref: {{reference}}. Trans ID: {{txn_id}}"),
    cashin: on("Cash in of GHS {{amount}} received from {{counterparty_name}}. Balance: GHS {{balance}}. Trans ID: {{txn_id}}"),
    cashout: on("Cash out of GHS {{amount}} made at {{counterparty_name}}. Fee: GHS {{fee}}. Balance: GHS {{balance}}. Trans ID: {{txn_id}}"),
    agent_cashin: on("You deposited GHS {{amount}} for {{counterparty_name}} {{counterparty}}. Commission: GHS {{commission}}. Float balance: GHS {{balance}}. Trans ID: {{txn_id}}"),
    agent_cashout: on("Cash out of GHS {{amount}} approved by {{counterparty_name}} {{counterparty}}. Pay the customer. Commission: GHS {{commission}}. Float balance: GHS {{balance}}. Trans ID: {{txn_id}}"),
    merchant_payment: on("You paid GHS {{amount}} to {{counterparty_name}}. Balance: GHS {{balance}}. Trans ID: {{txn_id}}"),
    approval_prompt: on(`{{counterparty_name}} is requesting GHS {{amount}} from your wallet ({{reason}}). Dial ${brand.shortcode} and ${APPROVALS_PATH[telco]} to approve or reject. Approving SENDS money from your wallet.`),
    reversal: on("Transaction {{txn_id}} of GHS {{amount}} has been reversed. Balance: GHS {{balance}}."),
    ticket_opened: on(`${brand.name} customer care has opened ticket {{ticket}} for you: {{category}}. We will update you by SMS. Call ${brand.careLine} for help.`),
    ticket_closed: on("Ticket {{ticket}} is closed: {{outcome}}."),
    dispute_hold: on(`GHS {{amount}} you received from {{counterparty}} is on hold while a wrong-transfer claim is checked. Ticket {{ticket}}. Call ${brand.careLine} for help.`),
    dispute_consent: on(`{{counterparty_name}} {{counterparty}} says GHS {{amount}} was sent to you by mistake. Dial ${brand.shortcode}, ${APPROVALS_PATH[telco]}, and agree to return it or refuse. Ticket {{ticket}}.`),
  };
}

export function defaultTelco(telco: Telco): TelcoConfig {
  return {
    menu: MENUS[telco],
    fees: telco === "telecel" ? telecelFees : mtnFees,
    // Starting values based on commonly reported MTN agent rates; the telcos publish no official rate card.
    agentCommission: {
      cashin: { bands: [{ upTo: 49.99, pct: 0, flat: 0.2 }, { upTo: 2000, pct: 0.4, flat: 0 }, { upTo: null, pct: 0, flat: 8 }] },
      cashout: { bands: [{ upTo: 49.99, pct: 0, flat: 0.2 }, { upTo: 2000, pct: 0.4, flat: 0 }, { upTo: null, pct: 0, flat: 8 }] },
    },
    notifications: notifications(telco),
    pinAttemptsBeforeLock: 3,
    approvalMinutes: 5,
    simSwapMomoHoldHours: 24,
    // A subscriber can open a wallet from the phone: on MTN and AT from the wallet's own code, on Telecel from *558#.
    selfRegistration: true,
    ownBankAccountFree: true,
    // On MTN the agent asks and the customer allows it; on Telecel and AT the customer starts it with the agent's number.
    cashOut: telco === "mtn" ? "agent_requests" : "customer_starts",
    // An AT agent never sets the PIN: a starting PIN is texted and the customer replaces it on first use.
    registration: telco === "telecel" ? { code: "*558#" } : telco === "at" ? { pinBySms: true } : {},
    bundles: DEFAULT_BUNDLES,
    billers: DEFAULT_BILLERS,
    atm: DEFAULT_ATM,
  };
}

// Sandbox starting values; each bank publishes its own tariff.
export const defaultBank: BankConfig = {
  fees: {
    toWallet: { bands: [{ upTo: null, pct: 0, flat: 0 }] },
    interbank: { bands: [{ upTo: null, pct: 0.5, flat: 0, max: 10 }] },
  },
};

// KYC tiers as revised by the Bank of Ghana, effective 1 March 2024.
export const defaultBog: BogConfig = {
  kycTiers: {
    minimum: { maxBalance: 5000, daily: 3000, monthly: 10000 },
    medium: { maxBalance: 40000, daily: 15000, monthly: null },
    enhanced: { maxBalance: 75000, daily: 25000, monthly: null },
  },
};

// 10 SIMs per person across all networks (NCA). Under-18s need a guardian, which the sandbox does not model.
export const defaultNca: NcaConfig = { maxSimsPerCard: 10, minimumAge: 18, primaryNumberApproval: true };

export const defaultSwitch: SwitchConfig = {
  participants: Object.fromEntries(PARTICIPANTS.map((p) => [p, { connected: true }])),
  feePerTxn: 0.1,
  maxAmount: 50000,
};

export function defaultsFor(surface: string): unknown {
  if (surface === "bog") return defaultBog;
  if (surface === "nca") return defaultNca;
  if (surface === "switch") return defaultSwitch;
  if (surface.startsWith("telco.")) return defaultTelco(surface.slice(6) as Telco);
  if (surface.startsWith("bank.") && BANK_IDS.includes(surface.slice(5))) return defaultBank;
  throw new Error(`unknown surface ${surface}`);
}

export const ALL_SURFACES = ["bog", "nca", "switch", ...TELCOS.map((t) => `telco.${t}`), ...BANK_IDS.map((b) => `bank.${b}`)];
