import type { FraudChecks, Menu, Menus, Notifications, Rules, Scenarios, SurfaceTypes } from "./schemas";

/**
 * Starting configuration for every team world. Menu wording approximates each
 * telco's live menu; replace with the trees the telco partners provide.
 */

type Labels = {
  title: string;
  send: string;
  cashout: string;
  merchant: string;
  wallet: string;
  sendSub: [string, string, string];
};

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
    sessionTimeoutSec: 60,
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
      bank_pin: {
        type: "input",
        text: "Send GHS{{amount}} to {{recipient_name}}\nFee: GHS{{fee}}\nEnter PIN to confirm",
        var: "pin",
        kind: "pin",
        next: "do_bank",
      },

      merchant_till: { type: "input", text: "Enter merchant ID", var: "till", kind: "till", next: "merchant_amount" },
      merchant_amount: { type: "input", text: "Enter amount", var: "amount", kind: "amount", next: "merchant_pin" },
      merchant_pin: {
        type: "input",
        text: "Pay GHS{{amount}} to {{recipient_name}}\nEnter PIN to confirm",
        var: "pin",
        kind: "pin",
        next: "do_merchant",
      },

      wallet: {
        type: "menu",
        text: l.wallet,
        options: [
          { key: "1", label: "Check Balance", next: "balance_pin" },
          { key: "2", label: "Mini Statement", next: "statement_pin" },
          { key: "3", label: "Report Fraud", next: "do_report" },
        ],
      },
      balance_pin: { type: "input", text: "Enter PIN", var: "pin", kind: "pin", next: "do_balance" },
      statement_pin: { type: "input", text: "Enter PIN", var: "pin", kind: "pin", next: "do_statement" },

      approvals: { type: "action", action: "approvals" },
      do_send: { type: "action", action: "send_money" },
      do_bank: { type: "action", action: "to_bank" },
      do_merchant: { type: "action", action: "pay_merchant" },
      do_balance: { type: "action", action: "check_balance" },
      do_statement: { type: "action", action: "mini_statement" },
      do_report: { type: "action", action: "report_fraud" },
      not_available: { type: "message", text: "This service is not part of the sandbox." },
    },
  } as Menu;
}

export const defaultMenus: Menus = {
  mtn: buildMenu("*170#", {
    title: "MTN MoMo",
    send: "Transfer Money",
    merchant: "MoMoPay & Pay Bill",
    cashout: "Allow Cash Out",
    wallet: "My Wallet",
    sendSub: ["MoMo User", "Other Networks", "Bank Account"],
  }),
  telecel: buildMenu("*110#", {
    title: "Telecel Cash",
    send: "Send Money",
    merchant: "Make Payments",
    cashout: "Withdraw Cash",
    wallet: "My Wallet",
    sendSub: ["Telecel Cash User", "Other Networks", "Bank Account"],
  }),
  at: buildMenu("*110#", {
    title: "AT Money",
    send: "Send Money",
    merchant: "Pay Merchant",
    cashout: "Approve Cash Out",
    wallet: "My Account",
    sendSub: ["AT Money User", "Other Networks", "Bank Account"],
  }),
};

const FREE = { bands: [{ upTo: null, pct: 0, flat: 0 }] };

// MTN MoMo tariff (confirmed). AT uses the same schedule.
const mtnFees = {
  p2p_onnet: { bands: [{ upTo: 1000, pct: 0.75, flat: 0 }, { upTo: null, pct: 0, flat: 7.5 }] },
  p2p_offnet: { bands: [{ upTo: 1000, pct: 0.75, flat: 0 }, { upTo: null, pct: 0, flat: 7.5 }] },
  cashout: { bands: [{ upTo: 49.99, pct: 0, flat: 0.5 }, { upTo: 1999.99, pct: 1, flat: 0 }, { upTo: null, pct: 0, flat: 20 }] },
  merchant: FREE,
  to_bank: { bands: [{ upTo: null, pct: 0.75, flat: 0, max: 5 }] },
};

// Telecel Cash tariff (confirmed). Wallet-to-bank is not in the published table, so it follows MTN.
const telecelFees = {
  p2p_onnet: FREE,
  p2p_offnet: { bands: [{ upTo: 100, pct: 0, flat: 0 }, { upTo: 1000, pct: 0.5, flat: 0 }, { upTo: null, pct: 0, flat: 5 }] },
  cashout: { bands: [{ upTo: 50, pct: 0, flat: 0.5 }, { upTo: 2000, pct: 1, flat: 0 }, { upTo: null, pct: 0, flat: 20 }] },
  merchant: FREE,
  to_bank: mtnFees.to_bank,
};

// KYC tiers confirmed by Bank of Ghana revision effective 1 March 2024.
export const defaultRules: Rules = {
  kycTiers: {
    minimum: { maxBalance: 5000, daily: 3000, monthly: 10000 },
    medium: { maxBalance: 40000, daily: 15000, monthly: null },
    enhanced: { maxBalance: 75000, daily: 25000, monthly: null },
  },
  fees: { mtn: mtnFees, telecel: telecelFees, at: mtnFees },
  secondFactor: { method: "sms_otp", friction_seconds: 25 },
  pinAttemptsBeforeLock: 3,
  victimCanReverseHeldFunds: true,
};

export const defaultNotifications: Notifications = {
  rules: [
    {
      id: "sent",
      event: "transfer_sent",
      enabled: true,
      template: "Payment made for GHS {{amount}} to {{counterparty_name}} {{counterparty}}. Fee: GHS {{fee}}. Balance: GHS {{balance}}. Ref: {{reference}}. Trans ID: {{txn_id}}",
    },
    {
      id: "received",
      event: "transfer_received",
      enabled: true,
      template: "Payment received for GHS {{amount}} from {{counterparty_name}} {{counterparty}}. Balance: GHS {{balance}}. Ref: {{reference}}. Trans ID: {{txn_id}}",
    },
    { id: "cashout", event: "cashout", enabled: true, template: "Cash out of GHS {{amount}} at {{counterparty_name}}. Fee: GHS {{fee}}. Balance: GHS {{balance}}. Trans ID: {{txn_id}}" },
    { id: "merchant", event: "merchant_payment", enabled: true, template: "You paid GHS {{amount}} to {{counterparty_name}}. Balance: GHS {{balance}}. Trans ID: {{txn_id}}" },
    { id: "held", event: "held", enabled: true, template: "Your transfer of GHS {{amount}} to {{counterparty}} is on hold until {{release_time}}. Dial the menu and choose Report Fraud if you did not intend it." },
    { id: "blocked", event: "blocked", enabled: true, template: "Your transfer of GHS {{amount}} to {{counterparty}} was blocked for your safety." },
    { id: "rtp", event: "rtp_prompt", enabled: true, template: "{{counterparty_name}} has requested GHS {{amount}}. Dial the menu and choose Allow Cash Out to approve. Approving SENDS money from your wallet." },
    { id: "simswap", event: "sim_swap", enabled: false, template: "Your SIM was replaced at {{time}}. If this was not you, call 100 immediately." },
    { id: "newdevice", event: "new_device", enabled: false, template: "Your wallet was accessed from a new device at {{time}}. If this was not you, call 100 immediately." },
    { id: "large", event: "large_inbound", enabled: false, template: "You received GHS {{amount}} from {{counterparty}}. Never send money back to anyone who calls claiming it was a mistake." },
    { id: "warned", event: "warned", enabled: false, template: "You continued a transfer of GHS {{amount}} to {{counterparty}} after a fraud warning." },
  ],
};

export const defaultFraudChecks: FraudChecks = {
  checks: [
    {
      id: "blacklist_recipient",
      name: "Block payments to wallets with 3+ fraud reports",
      enabled: true,
      appliesTo: ["p2p", "merchant", "rtp"],
      when: { fact: "recipient_reported_count", op: ">=", value: 3 },
      action: "block",
    },
  ],
  webhook: { enabled: false, url: "", timeoutMs: 500, failOpen: true },
};

export const defaultScenarios: Scenarios = {
  legitTxnsPerDay: 2500,
  scenarios: [
    { id: "reversal_scam", enabled: true, perDay: 30 },
    { id: "pin_phishing", enabled: true, perDay: 14 },
    { id: "sim_swap", enabled: true, perDay: 6 },
    { id: "agent_fraud", enabled: true, perDay: 8 },
    { id: "mule_chain", enabled: true, perDay: 6 },
    { id: "fake_promo", enabled: true, perDay: 25 },
    { id: "rtp_abuse", enabled: true, perDay: 14 },
    { id: "fake_merchant_qr", enabled: true, perDay: 8 },
    { id: "relative_impersonation", enabled: true, perDay: 20 },
    { id: "limit_splitting", enabled: true, perDay: 3 },
  ],
};

export const DEFAULTS: SurfaceTypes = {
  menus: defaultMenus,
  rules: defaultRules,
  notifications: defaultNotifications,
  fraudChecks: defaultFraudChecks,
  scenarios: defaultScenarios,
};
