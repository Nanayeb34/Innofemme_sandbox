import { z } from "zod";

/**
 * The five control surfaces. Everything a team can change lives here as data,
 * validated by these schemas, so neither the AI assistant nor team code ever
 * edits engine code.
 */

export const FACTS = {
  amount: "Transaction amount in GHS",
  type: "Transaction type: p2p | merchant | cashout | to_bank | rtp",
  channel: "ussd | app | api",
  cross_network: "true when the recipient is on a different telco (goes through the national switch)",
  recipient_is_new: "true when the sender has never paid this recipient before and they are not a saved contact",
  recipient_type: "person | merchant | agent | bank",
  recipient_account_age_days: "Days since the recipient wallet was opened",
  recipient_distinct_senders_1h: "Number of different wallets that paid the recipient in the last hour",
  recipient_inbound_count_24h: "Number of payments the recipient received in the last 24 hours",
  recipient_kyc_tier: "minimum | medium | enhanced",
  sender_kyc_tier: "minimum | medium | enhanced",
  sender_balance: "Sender balance in GHS before the transaction",
  amount_to_balance_ratio: "amount / sender balance (0..1)",
  sender_txn_count_1h: "Transactions the sender made in the last hour",
  sender_new_recipients_1h: "Distinct new recipients the sender paid in the last hour",
  sender_account_age_days: "Days since the sender wallet was opened",
  hours_since_sim_swap: "Hours since the sender's SIM was last swapped (99999 if never)",
  new_device: "true when the session comes from a device not seen before on this wallet",
  hour_of_day: "Simulated local hour, 0-23",
  recipient_reported_count: "Number of fraud reports filed against the recipient",
} as const;
export type FactName = keyof typeof FACTS;
export const FACT_NAMES = Object.keys(FACTS) as [FactName, ...FactName[]];

export const OPS = [">", ">=", "<", "<=", "==", "!=", "in"] as const;

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: FactName; op: (typeof OPS)[number]; value: number | string | boolean | (string | number)[] };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema) }).strict(),
    z.object({ any: z.array(ConditionSchema) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z
      .object({
        fact: z.enum(FACT_NAMES),
        op: z.enum(OPS),
        value: z.union([z.number(), z.string(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
      })
      .strict(),
  ]),
);

// ---------- 1. USSD menus ----------

export const USSD_ACTIONS = ["send_money", "check_balance", "cash_out", "pay_merchant", "to_bank", "approvals", "mini_statement", "report_fraud"] as const;
export const INPUT_KINDS = ["msisdn", "amount", "text", "pin", "till", "agent", "account"] as const;

const NodeId = z.string().min(1).max(60);

export const MenuNodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("menu"),
      text: z.string(),
      options: z.array(z.object({ key: z.string().min(1).max(3), label: z.string(), next: NodeId }).strict()).min(1).max(9),
    })
    .strict(),
  z.object({ type: z.literal("input"), text: z.string(), var: z.string().regex(/^[a-z_]+$/), kind: z.enum(INPUT_KINDS), next: NodeId }).strict(),
  z.object({ type: z.literal("branch"), if: ConditionSchema, then: NodeId, else: NodeId }).strict(),
  z.object({ type: z.literal("warning"), text: z.string(), next: NodeId }).strict(),
  z.object({ type: z.literal("set"), vars: z.record(z.string(), z.string()), next: NodeId }).strict(),
  z.object({ type: z.literal("action"), action: z.enum(USSD_ACTIONS) }).strict(),
  z.object({ type: z.literal("message"), text: z.string() }).strict(),
]);
export type MenuNode = z.infer<typeof MenuNodeSchema>;

export const MenuSchema = z
  .object({
    shortcode: z.string().regex(/^\*\d+(\*\d+)*#$/),
    start: NodeId,
    screenCharLimit: z.number().int().min(80).max(400),
    sessionTimeoutSec: z.number().int().min(10).max(600),
    nodes: z.record(NodeId, MenuNodeSchema),
  })
  .strict()
  .superRefine((menu, ctx) => {
    const ids = new Set(Object.keys(menu.nodes));
    if (!ids.has(menu.start)) ctx.addIssue({ code: "custom", message: `start node "${menu.start}" does not exist` });
    for (const [id, node] of Object.entries(menu.nodes)) {
      const targets: string[] = [];
      if (node.type === "menu") targets.push(...node.options.map((o) => o.next));
      if (node.type === "input" || node.type === "warning" || node.type === "set") targets.push(node.next);
      if (node.type === "branch") targets.push(node.then, node.else);
      for (const t of targets) if (!ids.has(t)) ctx.addIssue({ code: "custom", message: `node "${id}" points to missing node "${t}"` });
    }
  });
export type Menu = z.infer<typeof MenuSchema>;

export const MenusSchema = z.object({ mtn: MenuSchema, telecel: MenuSchema, at: MenuSchema }).strict();
export type Menus = z.infer<typeof MenusSchema>;

// ---------- 2. Rules and limits ----------

const Tier = z.object({ maxBalance: z.number().positive(), daily: z.number().positive(), monthly: z.number().positive().nullable() }).strict();
/**
 * A fee schedule as amount bands (GHS). The first band whose upTo covers the amount applies;
 * upTo null is the open-ended top band. Fee = flat + pct% of the amount, capped at max when set.
 */
const FeeBand = z
  .object({ upTo: z.number().positive().nullable(), pct: z.number().min(0).max(20), flat: z.number().min(0), max: z.number().min(0).optional() })
  .strict();
const Fee = z
  .object({ bands: z.array(FeeBand).min(1) })
  .strict()
  .superRefine((fee, ctx) => {
    const ups = fee.bands.map((b) => b.upTo);
    if (ups.slice(0, -1).some((u) => u === null)) ctx.addIssue({ code: "custom", message: "only the last band may have upTo: null" });
    for (let i = 1; i < ups.length; i++) {
      const prev = ups[i - 1];
      const cur = ups[i];
      if (prev !== null && cur !== null && cur <= prev) ctx.addIssue({ code: "custom", message: "bands must be in increasing order of upTo" });
    }
  });
const TelcoFees = z.object({ p2p_onnet: Fee, p2p_offnet: Fee, cashout: Fee, merchant: Fee, to_bank: Fee }).strict();

export const RulesSchema = z
  .object({
    kycTiers: z.object({ minimum: Tier, medium: Tier, enhanced: Tier }).strict(),
    fees: z.object({ mtn: TelcoFees, telecel: TelcoFees, at: TelcoFees }).strict(),
    secondFactor: z.object({ method: z.enum(["sms_otp", "ghana_card_selfie"]), friction_seconds: z.number().min(0).max(600) }).strict(),
    pinAttemptsBeforeLock: z.number().int().min(1).max(10),
    victimCanReverseHeldFunds: z.boolean(),
  })
  .strict();
export type Rules = z.infer<typeof RulesSchema>;
export type FeeKind = keyof z.infer<typeof TelcoFees>;

// ---------- 3. Notifications ----------

export const NOTIFICATION_EVENTS = {
  transfer_sent: "Sender, after a successful transfer",
  transfer_received: "Recipient, after money arrives",
  cashout: "Customer, after a cash-out",
  merchant_payment: "Payer, after paying a merchant",
  held: "Sender, when a transfer is put on hold",
  blocked: "Sender, when a transfer is blocked",
  warned: "Sender, after they continue past a warning",
  sim_swap: "Wallet owner, when their SIM is swapped",
  new_device: "Wallet owner, when their wallet is used from a new device",
  rtp_prompt: "Payer, when a merchant requests a payment",
  large_inbound: "Recipient, when they receive more than GHS 1,000",
} as const;
export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;

export const NotificationsSchema = z
  .object({
    rules: z.array(
      z
        .object({
          id: z.string().min(1),
          event: z.enum(Object.keys(NOTIFICATION_EVENTS) as [NotificationEvent, ...NotificationEvent[]]),
          enabled: z.boolean(),
          template: z.string().min(1).max(320),
        })
        .strict(),
    ),
  })
  .strict();
export type Notifications = z.infer<typeof NotificationsSchema>;

// ---------- 4. Fraud checks ----------

export const CHECK_ACTIONS = ["block", "hold", "warn", "require_second_factor", "flag"] as const;
export type CheckAction = (typeof CHECK_ACTIONS)[number];
export const TXN_TYPES = ["p2p", "merchant", "cashout", "to_bank", "rtp"] as const;

export const FraudChecksSchema = z
  .object({
    checks: z.array(
      z
        .object({
          id: z.string().min(1).max(60),
          name: z.string().min(1).max(120),
          enabled: z.boolean(),
          appliesTo: z.array(z.enum(TXN_TYPES)).min(1),
          when: ConditionSchema,
          action: z.enum(CHECK_ACTIONS),
          holdMinutes: z.number().int().min(1).max(10080).optional(),
          message: z.string().max(300).optional(),
        })
        .strict(),
    ),
    webhook: z
      .object({ enabled: z.boolean(), url: z.string(), timeoutMs: z.number().int().min(50).max(3000), failOpen: z.boolean() })
      .strict(),
  })
  .strict();
export type FraudChecks = z.infer<typeof FraudChecksSchema>;

// ---------- 5. Scenarios ----------

export const SCENARIOS = {
  reversal_scam: "\"Sent to you by mistake\" reversal scam",
  pin_phishing: "Fake MoMo staff call or SMS to phish the PIN",
  sim_swap: "SIM swap leading to account takeover",
  agent_fraud: "Agent float and cash-out fraud",
  mule_chain: "Mule account chains across networks and banks",
  fake_promo: "Fake promotion or lottery SMS",
  rtp_abuse: "Abuse of payment approval prompts (Request to Pay)",
  fake_merchant_qr: "Fake merchant or payment QR code",
  relative_impersonation: "Impersonation of a relative in distress",
  limit_splitting: "Splitting transfers to stay under KYC limits",
} as const;
export type ScenarioId = keyof typeof SCENARIOS;
export const SCENARIO_IDS = Object.keys(SCENARIOS) as [ScenarioId, ...ScenarioId[]];

export const ScenariosSchema = z
  .object({
    scenarios: z.array(z.object({ id: z.enum(SCENARIO_IDS), enabled: z.boolean(), perDay: z.number().min(0).max(500) }).strict()),
    legitTxnsPerDay: z.number().int().min(0).max(20000),
  })
  .strict();
export type Scenarios = z.infer<typeof ScenariosSchema>;

// ---------- registry ----------

export const SURFACES = {
  menus: { schema: MenusSchema, label: "USSD menus" },
  rules: { schema: RulesSchema, label: "Rules and limits" },
  notifications: { schema: NotificationsSchema, label: "Notifications" },
  fraudChecks: { schema: FraudChecksSchema, label: "Fraud checks" },
  scenarios: { schema: ScenariosSchema, label: "Scenarios" },
} as const;
export type Surface = keyof typeof SURFACES;
export const SURFACE_NAMES = Object.keys(SURFACES) as [Surface, ...Surface[]];

export interface SurfaceTypes {
  menus: Menus;
  rules: Rules;
  notifications: Notifications;
  fraudChecks: FraudChecks;
  scenarios: Scenarios;
}
