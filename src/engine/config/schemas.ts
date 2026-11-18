import { z } from "zod";
import { BANK_IDS, PARTICIPANTS, TELCOS } from "../util";

/**
 * Every institution's settings. Each institution owns one "surface": a JSON document,
 * validated by these schemas, that its console (or the API) can change. Changes are
 * recorded and can be undone.
 */

// ---------- condition language used by USSD menu branches ----------

export const FACTS = {
  amount: "Amount entered so far, in GHS",
  cross_network: "true when the recipient is on a different network",
  recipient_registered: "true when the recipient number has a mobile money wallet",
  recipient_type: "person | merchant | agent | bank",
  sender_kyc_tier: "minimum | medium | enhanced",
  sender_balance: "Sender balance in GHS",
  hour_of_day: "Hour of day, 0-23 (GMT, Ghana time)",
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

// ---------- USSD menu ----------

export const USSD_ACTIONS = ["send_money", "pay_merchant", "to_bank", "check_balance", "mini_statement", "approvals", "change_pin"] as const;
export const INPUT_KINDS = ["msisdn", "amount", "text", "pin", "till", "account"] as const;

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
      if (node.type === "input" || node.type === "warning") targets.push(node.next);
      if (node.type === "branch") targets.push(node.then, node.else);
      for (const t of targets) if (!ids.has(t)) ctx.addIssue({ code: "custom", message: `node "${id}" points to missing node "${t}"` });
    }
  });
export type Menu = z.infer<typeof MenuSchema>;

// ---------- fees ----------

/**
 * A fee schedule as amount bands (GHS). The first band whose upTo covers the amount applies;
 * upTo null is the open-ended top band. Fee = flat + pct% of the amount, capped at max when set.
 */
const FeeBand = z
  .object({ upTo: z.number().positive().nullable(), pct: z.number().min(0).max(20), flat: z.number().min(0), max: z.number().min(0).optional() })
  .strict();
export const FeeSchema = z
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
export type Fee = z.infer<typeof FeeSchema>;

// ---------- telco ----------

export const NOTIFICATION_EVENTS = {
  sim_registered: "Subscriber, when their SIM is registered and activated",
  sim_swapped: "Subscriber, when their number is moved to a replacement SIM",
  wallet_opened: "Customer, when their mobile money wallet is opened",
  kyc_upgraded: "Customer, when their wallet moves to a higher KYC tier",
  pin_reset: "Customer, when their wallet PIN is reset",
  transfer_sent: "Sender, after a successful transfer",
  transfer_received: "Recipient, after money arrives",
  cashin: "Customer, after an agent deposits cash into their wallet",
  cashout: "Customer, after a cash-out",
  agent_cashin: "Agent, after depositing for a customer",
  agent_cashout: "Agent, after a customer's cash-out is approved",
  merchant_payment: "Payer, after paying a merchant",
  approval_prompt: "Payer, when an agent or merchant asks them to approve a payment",
  reversal: "Both sides, when a payment is reversed",
} as const;
export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;
const EVENT_NAMES = Object.keys(NOTIFICATION_EVENTS) as [NotificationEvent, ...NotificationEvent[]];

const TelcoFees = z.object({ p2p_onnet: FeeSchema, p2p_offnet: FeeSchema, cashout: FeeSchema, merchant: FeeSchema, to_bank: FeeSchema }).strict();
export type FeeKind = keyof z.infer<typeof TelcoFees>;

export const TelcoSchema = z
  .object({
    menu: MenuSchema,
    fees: TelcoFees,
    /** What the telco pays its agents for each deposit and withdrawal they handle, as amount bands. */
    agentCommission: z.object({ cashin: FeeSchema, cashout: FeeSchema }).strict(),
    notifications: z.record(z.enum(EVENT_NAMES), z.object({ enabled: z.boolean(), template: z.string().min(1).max(320) }).strict()),
    pinAttemptsBeforeLock: z.number().int().min(1).max(10),
    /** How long a customer has to approve a cash-out or payment request. */
    approvalMinutes: z.number().int().min(1).max(60),
    /** After a SIM swap the wallet cannot send money for this many hours. 0 switches the hold off. */
    simSwapMomoHoldHours: z.number().int().min(0).max(168),
    /** Whether subscribers can open a wallet themselves by dialling the short code. */
    selfRegistration: z.boolean(),
    /** No wallet-to-bank fee when the bank account belongs to the wallet's owner. On unless set to false. */
    ownBankAccountFree: z.boolean().optional(),
  })
  .strict();
export type TelcoConfig = z.infer<typeof TelcoSchema>;

// ---------- bank ----------

export const BankSchema = z.object({ fees: z.object({ toWallet: FeeSchema, interbank: FeeSchema }).strict() }).strict();
export type BankConfig = z.infer<typeof BankSchema>;

// ---------- Bank of Ghana ----------

const Tier = z.object({ maxBalance: z.number().positive(), daily: z.number().positive(), monthly: z.number().positive().nullable() }).strict();
export const TIERS = ["minimum", "medium", "enhanced"] as const;
export type KycTier = (typeof TIERS)[number];
export const BogSchema = z.object({ kycTiers: z.object({ minimum: Tier, medium: Tier, enhanced: Tier }).strict() }).strict();
export type BogConfig = z.infer<typeof BogSchema>;

// ---------- National Communications Authority ----------

export const NcaSchema = z
  .object({
    /** Across all networks. */
    maxSimsPerCard: z.number().int().min(1).max(50),
    minimumAge: z.number().int().min(0).max(21),
    /** A second or later SIM on a Ghana Card needs a code sent to the holder's first (primary) number. */
    primaryNumberApproval: z.boolean(),
  })
  .strict();
export type NcaConfig = z.infer<typeof NcaSchema>;

// ---------- national switch ----------

export const SwitchSchema = z
  .object({
    participants: z.object(Object.fromEntries(PARTICIPANTS.map((p) => [p, z.object({ connected: z.boolean() }).strict()]))).strict(),
    /** Billed by the switch to the sending institution for each transaction it routes (GHS). */
    feePerTxn: z.number().min(0).max(10),
    /** Largest single payment the switch will route (GHS). */
    maxAmount: z.number().positive(),
  })
  .strict();
export type SwitchConfig = { participants: Record<string, { connected: boolean }>; feePerTxn: number; maxAmount: number };

// ---------- registry ----------

export type SurfaceOf<S extends string> = S extends "bog"
  ? BogConfig
  : S extends "nca"
    ? NcaConfig
    : S extends "switch"
      ? SwitchConfig
      : S extends `telco.${string}`
        ? TelcoConfig
        : S extends `bank.${string}`
          ? BankConfig
          : never;

export const SURFACE_NAMES: string[] = ["bog", "nca", "switch", ...TELCOS.map((t) => `telco.${t}`), ...BANK_IDS.map((b) => `bank.${b}`)];

export function schemaFor(surface: string): z.ZodType | undefined {
  if (!SURFACE_NAMES.includes(surface)) return undefined;
  if (surface === "bog") return BogSchema;
  if (surface === "nca") return NcaSchema;
  if (surface === "switch") return SwitchSchema;
  return surface.startsWith("telco.") ? TelcoSchema : BankSchema;
}

/** Which institution's console a surface belongs to, for the audit trail. */
export const surfaceOwner = (surface: string) => surface.replace(/^(telco|bank)\./, "");
