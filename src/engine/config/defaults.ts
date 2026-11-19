import { BANK_IDS, PARTICIPANTS, TELCOS, TELCO_INFO, type Telco } from "../util";
import type { BankConfig, BogConfig, Menu, NcaConfig, SwitchConfig, TelcoConfig } from "./schemas";

/**
 * Starting settings for every institution in a new world. Menu wording approximates each
 * telco's live menu; replace with the trees the telco partners provide.
 */

type Labels = { title: string; send: string; cashout: string; merchant: string; wallet: string; sendSub: [string, string, string] };

function buildMenu(shortcode: string, l: Labels): Menu {
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

const MENUS: Record<Telco, Menu> = {
  mtn: buildMenu("*170#", { title: "MTN MoMo", send: "Transfer Money", merchant: "MoMoPay & Pay Bill", cashout: "Allow Cash Out", wallet: "My Wallet", sendSub: ["MoMo User", "Other Networks", "Bank Account"] }),
  telecel: buildMenu("*110#", { title: "Telecel Cash", send: "Send Money", merchant: "Make Payments", cashout: "Withdraw Cash", wallet: "My Wallet", sendSub: ["Telecel Cash User", "Other Networks", "Bank Account"] }),
  at: buildMenu("*110#", { title: "AT Money", send: "Send Money", merchant: "Pay Merchant", cashout: "Approve Cash Out", wallet: "My Account", sendSub: ["AT Money User", "Other Networks", "Bank Account"] }),
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
    approval_prompt: on(`{{counterparty_name}} is requesting GHS {{amount}} from your wallet ({{reason}}). Dial ${brand.shortcode} and choose option 4 to approve or reject. Approving SENDS money from your wallet.`),
    reversal: on("Transaction {{txn_id}} of GHS {{amount}} has been reversed. Balance: GHS {{balance}}."),
    ticket_opened: on(`${brand.name} customer care has opened ticket {{ticket}} for you: {{category}}. We will update you by SMS. Call ${brand.careLine} for help.`),
    ticket_closed: on("Ticket {{ticket}} is closed: {{outcome}}."),
    dispute_hold: on(`GHS {{amount}} you received from {{counterparty}} is on hold while a wrong-transfer claim is checked. Ticket {{ticket}}. Call ${brand.careLine} for help.`),
    dispute_consent: on(`{{counterparty_name}} {{counterparty}} says GHS {{amount}} was sent to you by mistake. Dial ${brand.shortcode}, choose option 4, and agree to return it or refuse. Ticket {{ticket}}.`),
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
    // Telecel Cash is opened at an agent or shop; MTN and AT subscribers can also register from the phone.
    selfRegistration: telco !== "telecel",
    ownBankAccountFree: true,
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
