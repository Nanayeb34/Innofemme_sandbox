import { approvalView, pendingFor } from "@/engine/approvals";
import { answerCall, callLog, callSeconds, careEndpoint, careQueue, endCall, pollCall, startCall, type CallRow } from "@/engine/calls";
import * as care from "@/engine/care";
import { openAccount, setAccountStatus } from "@/engine/bank";
import { getConfig } from "@/engine/config/store";
import { TIERS, type KycTier } from "@/engine/config/schemas";
import { count } from "@/engine/db";
import { balanceOf, getTxn, getWallet, walletByMsisdn } from "@/engine/ledger";
import { enrol, fullName, normalizeCard, personById, setCardStatus, verify } from "@/engine/nia";
import { bankCash, bankToWallet, bankTransfer, reverse } from "@/engine/payments";
import { conversations, sendText, smsRecords, thread } from "@/engine/sms";
import { positions, settle, trustAccount } from "@/engine/switch";
import * as telcoOps from "@/engine/telco";
import { LINKED_SIMS_CODE, OWN_NUMBER_CODE, REGISTRATION_CHECK_CODE, ussd } from "@/engine/ussd";
import { BANKS, BANK_IDS, PARTICIPANTS, SimError, TELCOS, TELCO_INFO, TRUST_BANK, amountOf, bankName, isTelco, need, normalizeMsisdn, participantName, type Telco } from "@/engine/util";
import { applyPatch, setConfig } from "@/engine/config/store";
import { audit, type World } from "@/engine/world";
import { telcoLogo } from "./logos";

/**
 * One entry per institution's console: `view` returns what its screen shows, and `actions`
 * are the things its staff can do. The HTTP layer (/api/w/{team}/s/...) dispatches here.
 */

type Body = Record<string, unknown>;
export interface System {
  view(w: World, q: URLSearchParams): unknown;
  actions: Record<string, (w: World, b: Body) => unknown>;
}

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
const ok = (message: string, extra: Record<string, unknown> = {}) => ({ ok: true, message, ...extra });
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const money = (p: number) => p / 100;
const sum = (w: World, sql: string, ...args: (string | number)[]) => count(w.db, sql, ...args);

// ---------- shared pieces ----------

function txnFeed(w: World, where: string, args: (string | number)[], limit = 100) {
  const rows = w.db
    .prepare(
      `SELECT t.*, fw.msisdn AS f_msisdn, fw.display_name AS f_name, tw.msisdn AS t_msisdn, tw.display_name AS t_name,
        fa.account_no AS f_acct, fa.name AS f_acct_name, ta.account_no AS t_acct, ta.name AS t_acct_name
       FROM txns t
       LEFT JOIN wallets fw ON fw.id = t.from_wallet LEFT JOIN wallets tw ON tw.id = t.to_wallet
       LEFT JOIN bank_accounts fa ON fa.id = t.from_account LEFT JOIN bank_accounts ta ON ta.id = t.to_account
       ${where ? `WHERE ${where}` : ""} ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`,
    )
    .all(...args, limit) as Record<string, string | number | null>[];
  return rows.map((r) => ({
    id: r.id,
    ref: String(r.id).slice(3, 13).toUpperCase(),
    at: iso(r.created_at as number),
    type: r.type,
    channel: r.channel,
    rail: r.rail,
    amount: money(r.amount as number),
    fee: money(r.fee as number),
    commission: money(r.commission as number),
    status: r.status,
    reason: r.reason,
    reference: r.reference,
    from: r.f_msisdn ? `${r.f_name} (${r.f_msisdn})` : r.f_acct ? `${r.f_acct_name} (${bankName(String(r.from_party))} ${r.f_acct})` : r.type === "deposit" || r.type === "bank_to_wallet" ? "Cash" : "",
    to: r.t_msisdn ? `${r.t_name} (${r.t_msisdn})` : r.t_acct ? `${r.t_acct_name} (${bankName(String(r.to_party))} ${r.t_acct})` : r.type === "withdrawal" ? "Cash" : "",
    fromParty: r.from_party,
    toParty: r.to_party,
  }));
}

function auditFeed(w: World, system?: string, limit = 60) {
  const rows = (system
    ? w.db.prepare("SELECT * FROM audit WHERE system = ? ORDER BY id DESC LIMIT ?").all(system, limit)
    : w.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit)) as { id: number; at: number; system: string; action: string; summary: string }[];
  return rows.map((r) => ({ id: r.id, at: iso(r.at), system: r.system, systemName: systemName(r.system), action: r.action, summary: r.summary }));
}

const systemName = (s: string) => (s === "nia" ? "NIA" : s === "bog" ? "Bank of Ghana" : s === "nca" ? "NCA" : s === "switch" ? "National switch" : isTelco(s) ? TELCO_INFO[s].name : bankName(s));

function postings(w: World, txnId: string) {
  return w.db.prepare("SELECT account, amount FROM postings WHERE txn_id = ? ORDER BY id").all(txnId) as { account: string; amount: number }[];
}

/** Any console can open a transaction to see its ledger postings and switch messages. */
function txnDetail(w: World, b: Body) {
  const t = getTxn(w, String(need(str(b.txnId), "Transaction")));
  if (!t) throw new SimError("Transaction not found");
  return {
    ok: true,
    txn: txnFeed(w, "t.id = ?", [t.id], 1)[0],
    postings: postings(w, t.id).map((p) => ({ account: p.account, amount: money(p.amount) })),
    switchLog: (w.db.prepare("SELECT step, from_party, to_party, detail, at FROM switch_log WHERE txn_id = ? ORDER BY id").all(t.id) as { step: string; from_party: string; to_party: string; detail: string; at: number }[]).map((s) => ({ ...s, at: iso(s.at) })),
  };
}

function saveSettings(surface: string) {
  return (w: World, b: Body) => {
    const ops = b.operations;
    if (!Array.isArray(ops)) throw new SimError("operations must be a list of changes");
    const id = setConfig(w.db, surface, applyPatch(getConfig(w.db, surface), ops), String(b.summary ?? `Changed ${surface} settings`), "console");
    return ok("Settings saved.", { changeId: id });
  };
}

// ---------- hub ----------

const hub: System = {
  view(w) {
    const n = (sql: string) => sum(w, sql);
    const c = {
      persons: n("SELECT COUNT(*) AS n FROM persons"),
      simAgents: n("SELECT COUNT(*) AS n FROM sim_agents"),
      simsInStock: n("SELECT COUNT(*) AS n FROM sims WHERE status = 'in_stock'"),
      simsRegistered: n("SELECT COUNT(*) AS n FROM sims WHERE status IN ('active','blocked')"),
      wallets: n("SELECT COUNT(*) AS n FROM wallets WHERE owner_type = 'person'"),
      momoAgents: n("SELECT COUNT(*) AS n FROM momo_agents"),
      merchants: n("SELECT COUNT(*) AS n FROM merchants"),
      bankAccounts: n("SELECT COUNT(*) AS n FROM bank_accounts WHERE kind = 'personal'"),
      payments: n("SELECT COUNT(*) AS n FROM txns WHERE status = 'success' AND type NOT IN ('settlement','reversal')"),
      crossNetwork: n("SELECT COUNT(*) AS n FROM txns WHERE status = 'success' AND rail = 'switch' AND type != 'settlement'"),
      settlements: n("SELECT COUNT(*) AS n FROM settlements"),
      agentFloat: n("SELECT COALESCE(SUM(w.balance),0) AS n FROM wallets w WHERE w.owner_type = 'agent'"),
      cashIns: n("SELECT COUNT(*) AS n FROM txns WHERE status = 'success' AND type = 'cashin'"),
    };
    return {
      world: w.id,
      counts: c,
      steps: [
        { system: "nia", title: "Issue Ghana Cards", detail: "NIA enrols each person and issues their card.", done: c.persons > 0 },
        { system: "telco", title: "Add SIM stock and authorise a SIM registration point", detail: "Each telco adds blank SIMs and authorises a service centre or registration agent.", done: c.simAgents > 0 && c.simsInStock + c.simsRegistered > 0 },
        { system: "sim-agent", title: "Register a SIM", detail: "The registration agent checks the Ghana Card and fingerprint with NIA and activates the number.", done: c.simsRegistered > 0 },
        { system: "telco", title: "Onboard a mobile money agent", detail: "The telco turns a registered business line into an agent with its own agent number.", done: c.momoAgents > 0 },
        { system: "bank", title: "Open a bank account and buy float", detail: "The agent opens an account, deposits cash and the bank sends float to the agent line.", done: c.agentFloat > 0 || c.cashIns > 0 },
        { system: "phone", title: "Open a wallet", detail: "From the phone (dial the short code) or in person at a mobile money agent.", done: c.wallets > 0 },
        { system: "momo-agent", title: "Cash in and transact", detail: "Deposit at the agent, then send money, pay a merchant or cash out from the phone.", done: c.payments > 0 },
        { system: "switch", title: "Send across networks and settle", detail: "Cross-network and bank payments go through the national switch, which settles the net positions.", done: c.settlements > 0 },
      ],
      activity: auditFeed(w, undefined, 40),
    };
  },
  actions: { txn: txnDetail },
};

// ---------- NIA ----------

const nia: System = {
  view(w) {
    const people = w.db.prepare("SELECT * FROM persons ORDER BY issued_at DESC LIMIT 500").all() as unknown as import("@/engine/nia").Person[];
    const log = w.db.prepare("SELECT * FROM nia_log ORDER BY id DESC LIMIT 150").all() as { id: number; at: number; requester: string; purpose: string; ghana_card: string; biometric: number; result: string }[];
    return {
      stats: {
        cards: sum(w, "SELECT COUNT(*) AS n FROM persons"),
        suspended: sum(w, "SELECT COUNT(*) AS n FROM persons WHERE status != 'active'"),
        checks: sum(w, "SELECT COUNT(*) AS n FROM nia_log"),
        failed: sum(w, "SELECT COUNT(*) AS n FROM nia_log WHERE result != 'MATCH'"),
      },
      people: people.map((p) => ({ ...p, name: fullName(p), issued_at: iso(p.issued_at), sims: sum(w, "SELECT COUNT(*) AS n FROM sims WHERE person_id = ? AND status IN ('active','blocked')", p.id) })),
      log: log.map((l) => ({ ...l, at: iso(l.at), requesterName: systemName(l.requester), biometric: !!l.biometric })),
    };
  },
  actions: {
    enrol(w, b) {
      const p = enrol(w, { surname: str(b.surname), firstNames: str(b.firstNames), dob: str(b.dob), gender: str(b.gender), nationality: str(b.nationality), region: str(b.region), town: str(b.town) });
      return ok(`Ghana Card ${p.ghana_card} issued to ${fullName(p)}. Fingerprint code: ${p.fingerprint}`, { card: p.ghana_card, fingerprint: p.fingerprint });
    },
    card_status(w, b) {
      setCardStatus(w, String(need(str(b.card), "Ghana Card number")), b.status === "suspended" ? "suspended" : "active");
      return ok("Card updated.");
    },
  },
};

// ---------- telcos ----------

function telcoSystem(t: Telco): System {
  const brand = TELCO_INFO[t];
  return {
    view(w) {
      const trust = trustAccount(w, t);
      const sims = w.db
        .prepare(
          `SELECT s.*, p.first_names, p.surname, p.ghana_card, (SELECT 1 FROM wallets w WHERE w.msisdn = s.msisdn) AS has_wallet
           FROM sims s LEFT JOIN persons p ON p.id = s.person_id WHERE s.telco = ? AND s.status != 'in_stock' ORDER BY s.registered_at DESC LIMIT 400`,
        )
        .all(t) as Record<string, string | number | null>[];
      const wallets = w.db.prepare("SELECT w.*, p.ghana_card FROM wallets w JOIN persons p ON p.id = w.person_id WHERE w.telco = ? ORDER BY w.created_at DESC LIMIT 400").all(t) as Record<string, string | number>[];
      return {
        telco: t,
        brand: { ...brand, logo: telcoLogo(t) },
        stats: {
          simsInStock: sum(w, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'in_stock'", t),
          simsActive: sum(w, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'active'", t),
          simsBlocked: sum(w, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'blocked'", t),
          wallets: sum(w, "SELECT COUNT(*) AS n FROM wallets WHERE telco = ? AND owner_type = 'person'", t),
          agents: sum(w, "SELECT COUNT(*) AS n FROM momo_agents a JOIN wallets w ON w.id = a.wallet_id WHERE w.telco = ?", t),
          merchants: sum(w, "SELECT COUNT(*) AS n FROM merchants m JOIN wallets w ON w.id = m.wallet_id WHERE w.telco = ?", t),
          eMoney: money(sum(w, "SELECT COALESCE(SUM(balance),0) AS n FROM wallets WHERE telco = ?", t)),
          revenue: money(balanceOf(w, `fee:${t}`)),
          onHold: money(balanceOf(w, `hold:${t}`)),
          openTickets: sum(w, "SELECT COUNT(*) AS n FROM tickets WHERE telco = ? AND status NOT IN ('resolved','rejected')", t),
          trustBalance: money(trust?.balance ?? 0),
          trustBank: bankName(TRUST_BANK[t]),
          switchPosition: money(balanceOf(w, `switch:${t}`)),
        },
        stock: (w.db.prepare("SELECT msisdn, iccid FROM sims WHERE telco = ? AND status = 'in_stock' ORDER BY created_at, msisdn LIMIT 60").all(t) as { msisdn: string; iccid: string }[]),
        sims: sims.map((s) => ({
          msisdn: s.msisdn, iccid: s.iccid, status: s.status, owner: s.surname ? `${s.first_names} ${s.surname}` : "", card: s.ghana_card, registeredAt: iso(s.registered_at as number), registeredBy: s.registered_by,
          lastSwapAt: iso(s.last_swap_at as number), blockReason: s.block_reason, hasWallet: !!s.has_wallet,
        })),
        simAgents: w.db.prepare("SELECT a.*, p.first_names || ' ' || p.surname AS owner, (SELECT COUNT(*) FROM sims s WHERE s.registered_by = a.id) AS registered FROM sim_agents a JOIN persons p ON p.id = a.person_id WHERE a.telco = ? ORDER BY a.created_at").all(t),
        wallets: wallets.map((x) => ({ msisdn: x.msisdn, name: x.display_name, type: x.owner_type, tier: x.kyc_tier, status: x.status, balance: money(x.balance as number), card: x.ghana_card, openedAt: iso(x.created_at as number) })),
        momoAgents: (w.db.prepare("SELECT a.*, w.msisdn, w.balance FROM momo_agents a JOIN wallets w ON w.id = a.wallet_id WHERE w.telco = ? ORDER BY a.created_at").all(t) as Record<string, string | number>[]).map((a) => ({
          code: a.code, name: a.name, town: a.town, msisdn: a.msisdn, float: money(a.balance as number), cash: money(a.cash as number), commission: money(a.commission as number), status: a.status,
        })),
        merchants: w.db.prepare("SELECT m.till, m.name, m.category, m.town, w.msisdn, w.balance / 100.0 AS balance FROM merchants m JOIN wallets w ON w.id = m.wallet_id WHERE w.telco = ? ORDER BY m.created_at").all(t),
        txns: txnFeed(w, "t.from_party = ? OR t.to_party = ?", [t, t], 150),
        calls: (w.db.prepare("SELECT * FROM calls WHERE from_telco = ? OR to_telco = ? ORDER BY started_at DESC, rowid DESC LIMIT 150").all(t, t) as unknown as CallRow[]).map((c) => ({
          id: c.id, at: iso(c.started_at), from: c.from_msisdn, to: c.to_msisdn, fromNetwork: TELCO_INFO[c.from_telco].name, toNetwork: c.to_telco ? TELCO_INFO[c.to_telco].name : "", status: c.status, reason: c.reason, seconds: callSeconds(c),
        })),
        sms: smsRecords(w, t),
        simEvents: (w.db.prepare("SELECT e.* FROM sim_events e JOIN sims s ON s.msisdn = e.msisdn WHERE s.telco = ? ORDER BY e.id DESC LIMIT 80").all(t) as { id: number; msisdn: string; at: number; kind: string; by: string; detail: string }[]).map((e) => ({ ...e, at: iso(e.at) })),
        activity: auditFeed(w, t),
        config: getConfig(w.db, `telco.${t}`),
        limits: getConfig(w.db, "bog").kycTiers,
      };
    },
    actions: {
      add_sims(w, b) {
        const made = telcoOps.generateSims(w, t, Number(b.count ?? 10));
        return ok(`${made.length} blank SIM(s) added to ${brand.name} stock.`, { numbers: made });
      },
      onboard_sim_agent(w, b) {
        const a = telcoOps.onboardSimAgent(w, t, { card: str(b.card), name: str(b.name), kind: str(b.kind), town: str(b.town) });
        return ok(`${a.name} authorised. ID: ${a.id}`);
      },
      sim_agent_status(w, b) {
        telcoOps.setSimAgentStatus(w, t, String(b.id), b.status === "suspended" ? "suspended" : "active");
        return ok("Updated.");
      },
      sim_status(w, b) {
        const status = b.status === "blocked" ? "blocked" : b.status === "deactivated" ? "deactivated" : "active";
        telcoOps.setSimStatus(w, t, `${brand.name} back office`, b.msisdn, status, str(b.reason));
        return ok(`Number ${status === "active" ? "unblocked" : status}.`);
      },
      onboard_momo_agent(w, b) {
        const a = telcoOps.onboardMomoAgent(w, t, { msisdn: str(b.msisdn), name: str(b.name), town: str(b.town), pin: str(b.pin) });
        return ok(`${a.name} is now a ${brand.wallet} agent. Agent number: ${a.code}`);
      },
      momo_agent_status(w, b) {
        telcoOps.setMomoAgentStatus(w, t, String(b.code), b.status === "suspended" ? "suspended" : "active");
        return ok("Updated.");
      },
      onboard_merchant(w, b) {
        const m = telcoOps.onboardMerchant(w, t, { msisdn: str(b.msisdn), name: str(b.name), category: str(b.category), town: str(b.town), pin: str(b.pin) });
        return ok(`${m.name} is now a merchant. Merchant ID: ${m.till}`);
      },
      wallet_status(w, b) {
        telcoOps.setWalletStatus(w, t, b.msisdn, b.status === "frozen" ? "frozen" : "active", str(b.reason));
        return ok(b.status === "frozen" ? "Wallet frozen." : "Wallet active again.");
      },
      upgrade_tier(w, b) {
        if (!(TIERS as readonly string[]).includes(String(b.tier))) throw new SimError("Choose a KYC tier");
        const x = telcoOps.upgradeTier(w, t, b.msisdn, b.tier as KycTier, `${brand.name} back office`, str(b.proof));
        return ok(`${x.display_name} is now on ${x.kyc_tier} KYC.`);
      },
      reverse(w, b) {
        return ok(reverse(w, t, String(need(str(b.txnId), "Transaction"))).message);
      },
      settings: saveSettings(`telco.${t}`),
      txn: txnDetail,
    },
  };
}

// ---------- SIM registration and troubleshooting point ----------

function simAgentSystem(t: Telco): System {
  const brand = TELCO_INFO[t];
  const who = (w: World, b: Body) => telcoOps.simAgent(w, t, b.agent);
  const person = (b: Body) => ({ msisdn: str(b.msisdn), card: str(b.card), fingerprint: str(b.fingerprint) });
  /** Confirms the person at the counter owns the number before a sensitive change. */
  const ownerCheck = (w: World, agentId: string, b: Body, purpose: string) => {
    const sim = telcoOps.getSim(w, normalizeMsisdn(String(need(str(b.msisdn), "Mobile number"))));
    if (!sim || sim.telco !== t) throw new SimError(`Not a ${brand.name} number`);
    const p = verify(w, { requester: t, purpose: `${purpose} at ${agentId}`, card: str(b.card), fingerprint: str(b.fingerprint), biometric: true });
    if (p.id !== sim.person_id) throw new SimError("This Ghana Card does not belong to the registered owner of the number");
  };
  return {
    view(w, q) {
      const agents = w.db.prepare("SELECT id, name, kind, town, status FROM sim_agents WHERE telco = ? ORDER BY created_at").all(t) as { id: string; name: string; kind: string; town: string; status: string }[];
      const agent = agents.find((a) => a.id === q.get("agent") && a.status === "active") ?? agents.find((a) => a.status === "active");
      return {
        telco: t,
        brand: { ...brand, logo: telcoLogo(t) },
        agents,
        current: agent?.id ?? null,
        stockCount: sum(w, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'in_stock'", t),
        stock: (w.db.prepare("SELECT msisdn FROM sims WHERE telco = ? AND status = 'in_stock' ORDER BY created_at, msisdn LIMIT 12").all(t) as { msisdn: string }[]).map((s) => s.msisdn),
        events: agent
          ? (w.db.prepare("SELECT * FROM sim_events WHERE by = ? ORDER BY id DESC LIMIT 40").all(agent.id) as { id: number; msisdn: string; at: number; kind: string; detail: string }[]).map((e) => ({ ...e, at: iso(e.at) }))
          : [],
        rules: getConfig(w.db, "nca"),
      };
    },
    actions: {
      register(w, b) {
        const r = telcoOps.registerSim(w, t, b.agent, { card: str(b.card), fingerprint: str(b.fingerprint), msisdn: str(b.msisdn) || undefined, otp: str(b.otp) });
        return ok(`${r.sim.msisdn} is registered to ${fullName(r.person)} and active. Hand over the SIM card.`, { msisdn: r.sim.msisdn });
      },
      swap(w, b) {
        const s = telcoOps.swapSim(w, t, b.agent, person(b));
        return ok(`${s.msisdn} moved to a new SIM card (serial ${s.iccid}).`);
      },
      block(w, b) {
        const a = who(w, b);
        telcoOps.setSimStatus(w, t, a.id, b.msisdn, "blocked", str(b.reason) || "Reported lost or stolen");
        return ok("Number blocked. It cannot make calls or use mobile money until it is unblocked or replaced.");
      },
      unblock(w, b) {
        const a = who(w, b);
        ownerCheck(w, a.id, b, "SIM unblock");
        telcoOps.setSimStatus(w, t, a.id, b.msisdn, "active");
        return ok("Number unblocked.");
      },
      deactivate(w, b) {
        const a = who(w, b);
        ownerCheck(w, a.id, b, "Number disconnection");
        telcoOps.setSimStatus(w, t, a.id, b.msisdn, "deactivated", "Requested by owner");
        return ok("Number disconnected permanently.");
      },
      pin_reset(w, b) {
        const a = who(w, b);
        telcoOps.resetPin(w, t, a.id, person(b));
        return ok("PIN reset. A temporary PIN was sent to the customer by SMS.");
      },
      upgrade_enhanced(w, b) {
        const a = who(w, b);
        if (a.kind !== "service_centre") throw new SimError("Enhanced KYC is done at a service centre, not at a registration agent");
        ownerCheck(w, a.id, b, "Enhanced KYC");
        const x = telcoOps.upgradeTier(w, t, b.msisdn, "enhanced", a.id, str(b.proof));
        return ok(`${x.display_name} is now on enhanced KYC.`);
      },
      lookup(w, b) {
        who(w, b);
        const sim = telcoOps.getSim(w, normalizeMsisdn(String(need(str(b.msisdn), "Mobile number"))));
        if (!sim || sim.telco !== t) throw new SimError(`Not a ${brand.name} number`);
        const p = sim.person_id ? personById(w, sim.person_id) : undefined;
        const wallet = walletByMsisdn(w, sim.msisdn);
        return ok(
          sim.status === "in_stock"
            ? `${sim.msisdn} is a blank SIM in stock.`
            : `${sim.msisdn}: ${sim.status}. Registered to ${p ? fullName(p) : "nobody"}. ${wallet ? `${brand.wallet} wallet: ${wallet.status}, ${wallet.kyc_tier} KYC.` : `No ${brand.wallet} wallet.`}${sim.last_swap_at ? ` Last SIM replacement: ${iso(sim.last_swap_at)!.slice(0, 16).replace("T", " ")}.` : ""}`,
        );
      },
    },
  };
}

// ---------- mobile money agent point ----------

function momoAgentSystem(t: Telco): System {
  const brand = TELCO_INFO[t];
  return {
    view(w, q) {
      const agents = (w.db.prepare("SELECT a.code, a.name, a.town, a.status, a.cash, a.commission, a.wallet_id, w.msisdn, w.balance FROM momo_agents a JOIN wallets w ON w.id = a.wallet_id WHERE w.telco = ? ORDER BY a.created_at").all(t) as Record<string, string | number>[]);
      const a = agents.find((x) => x.code === q.get("agent") && x.status === "active") ?? agents.find((x) => x.status === "active");
      return {
        telco: t,
        brand: { ...brand, logo: telcoLogo(t) },
        agents: agents.map((x) => ({ code: x.code, name: x.name, town: x.town, status: x.status })),
        agent: a
          ? {
              code: a.code, name: a.name, msisdn: a.msisdn, town: a.town, status: a.status, float: money(a.balance as number), cash: money(a.cash as number), commission: money(a.commission as number),
              requests: (w.db.prepare("SELECT ref, payer_msisdn, amount, status, reason, created_at FROM approvals WHERE payee_wallet = ? AND kind = 'cashout' ORDER BY created_at DESC LIMIT 10").all(a.wallet_id) as Record<string, string | number>[]).map((r) => ({
                ref: r.ref, customer: r.payer_msisdn, amount: money(r.amount as number), status: r.status, reason: r.reason, at: iso(r.created_at as number),
              })),
              txns: txnFeed(w, "t.from_wallet = ? OR t.to_wallet = ?", [a.wallet_id, a.wallet_id], 40),
            }
          : null,
        fees: getConfig(w.db, `telco.${t}`).fees.cashout,
      };
    },
    actions: {
      register_customer(w, b) {
        const x = telcoOps.agentRegisterWallet(w, t, b.agent, { msisdn: str(b.msisdn), card: str(b.card), fingerprint: str(b.fingerprint), pin: str(b.pin) });
        return ok(`${x.display_name} (${x.msisdn}) has a ${brand.wallet} wallet on ${x.kyc_tier} KYC.`);
      },
      cash_in(w, b) {
        return ok(telcoOps.agentCashIn(w, t, b.agent, { msisdn: str(b.msisdn), amount: b.amount, pin: str(b.pin) }).message);
      },
      cash_out(w, b) {
        const r = telcoOps.agentRequestCashOut(w, t, b.agent, { msisdn: str(b.msisdn), amount: b.amount, card: str(b.card) });
        return ok(`Request sent to ${r.payer_msisdn}. The customer must dial ${getConfig(w.db, `telco.${t}`).menu.shortcode}, choose option 4 and approve with their PIN. Pay out the cash only after it shows as SUCCESSFUL below.`);
      },
      send_float(w, b) {
        return ok(telcoOps.agentSendFloat(w, t, b.agent, { toCode: str(b.toCode), amount: b.amount, pin: str(b.pin) }).message);
      },
      till(w, b) {
        const delta = amountOf(b.amount) * (b.direction === "out" ? -1 : 1);
        telcoOps.adjustTill(w, t, b.agent, delta);
        return ok(delta > 0 ? "Cash added to the till." : "Cash taken out of the till.");
      },
      txn: txnDetail,
    },
  };
}

// ---------- customer care (call centre) ----------

function careSystem(t: Telco): System {
  const brand = TELCO_INFO[t];
  const by = `${brand.name} customer care`;
  const label = (c: string) => care.CATEGORIES[c as care.Category] ?? c;

  function ticketRows(w: World, where: string, args: (string | number)[]) {
    const rows = w.db
      .prepare(`SELECT k.*, x.amount, w.display_name FROM tickets k LEFT JOIN txns x ON x.id = k.txn_id LEFT JOIN wallets w ON w.msisdn = k.msisdn WHERE ${where} ORDER BY (k.status IN ('resolved','rejected')), k.updated_at DESC LIMIT 200`)
      .all(...args) as unknown as (care.TicketRow & { amount: number | null; display_name: string | null })[];
    return rows.map((k) => ({
      id: k.id, msisdn: k.msisdn, customer: k.display_name ?? "", category: label(k.category), status: k.status, channel: k.channel, role: k.role, linked: k.linked_ticket,
      amount: k.amount === null ? null : money(k.amount), held: money(k.held), returned: money(k.returned), resolution: k.resolution, openedAt: iso(k.created_at), updatedAt: iso(k.updated_at),
    }));
  }

  function ticketDetail(w: World, id: string) {
    const k = care.getTicket(w, id);
    if (!k || k.telco !== t) return null;
    const txn = k.txn_id ? getTxn(w, k.txn_id) : undefined;
    const recipient = txn?.to_wallet ? getWallet(w, txn.to_wallet) : undefined;
    const open = k.status !== "resolved" && k.status !== "rejected";
    const walletDispute = !!txn && ["p2p", "merchant"].includes(txn.type);
    const ours = k.role === "both" || k.role === "recipient"; // the recipient's wallet is on this network
    const remaining = txn ? txn.amount - k.returned - k.held : 0;
    return {
      ...ticketRows(w, "k.id = ?", [k.id])[0],
      description: k.description,
      events: care.ticketEvents(w, k.id).map((e) => ({ ...e, at: iso(e.at) })),
      txn: txn ? txnFeed(w, "t.id = ?", [txn.id], 1)[0] : null,
      // Only the recipient's own network can see what is left in the recipient's wallet.
      recipientBalance: ours && recipient ? money(recipient.balance) : null,
      waitingForRecipient: sum(w, "SELECT COUNT(*) AS n FROM approvals WHERE kind = 'dispute' AND external_id = ? AND status = 'PENDING'", k.id) > 0,
      can: {
        hold: open && walletDispute && ours && remaining > 0 && (recipient?.balance ?? 0) > 0,
        askRecipient: open && walletDispute && ours && k.status !== "awaiting_recipient",
        returnFunds: open && walletDispute && ours && k.held > 0,
        forward: open && walletDispute && k.role === "sender" && !k.linked_ticket,
        reverseAgent: open && !!txn && ["cashin", "cashout", "float"].includes(txn.type),
        close: open && k.status !== "with_other_network",
      },
    };
  }

  function customer(w: World, input: string) {
    const msisdn = normalizeMsisdn(input);
    const sim = telcoOps.getSim(w, msisdn);
    if (!sim || sim.telco !== t || sim.status === "in_stock") return { msisdn, found: false as const };
    const p = sim.person_id ? personById(w, sim.person_id) : undefined;
    const wallet = walletByMsisdn(w, msisdn);
    return {
      msisdn,
      found: true as const,
      // What the agent checks the caller's answers against. A call centre cannot take a fingerprint.
      identity: p ? { name: fullName(p), dob: p.dob, card: p.ghana_card, town: `${p.town}, ${p.region}` } : null,
      sim: { status: sim.status, registeredAt: iso(sim.registered_at), lastSwapAt: iso(sim.last_swap_at), blockReason: sim.block_reason },
      wallet: wallet ? { name: wallet.display_name, type: wallet.owner_type, tier: wallet.kyc_tier, status: wallet.status, balance: money(wallet.balance) } : null,
      txns: wallet ? txnFeed(w, "t.from_wallet = ? OR t.to_wallet = ?", [wallet.id, wallet.id], 15).map((x) => ({ ...x, out: x.from.includes(msisdn) })) : [],
      tickets: ticketRows(w, "k.telco = ? AND k.msisdn = ?", [t, msisdn]),
    };
  }

  return {
    view(w, q) {
      return {
        telco: t,
        brand: { ...brand, logo: telcoLogo(t) },
        endpoint: careEndpoint(t),
        waiting: careQueue(w, t),
        stats: {
          open: sum(w, "SELECT COUNT(*) AS n FROM tickets WHERE telco = ? AND status = 'open'", t),
          awaitingRecipient: sum(w, "SELECT COUNT(*) AS n FROM tickets WHERE telco = ? AND status = 'awaiting_recipient'", t),
          withOtherNetwork: sum(w, "SELECT COUNT(*) AS n FROM tickets WHERE telco = ? AND status = 'with_other_network'", t),
          fromOtherNetworks: sum(w, "SELECT COUNT(*) AS n FROM tickets WHERE telco = ? AND channel = 'network' AND status NOT IN ('resolved','rejected')", t),
          closed: sum(w, "SELECT COUNT(*) AS n FROM tickets WHERE telco = ? AND status IN ('resolved','rejected')", t),
          onHold: money(balanceOf(w, `hold:${t}`)),
        },
        tickets: ticketRows(w, "k.telco = ?", [t]),
        ticket: q.get("ticket") ? ticketDetail(w, q.get("ticket")!) : null,
        customer: q.get("customer") ? customer(w, q.get("customer")!) : null,
        categories: Object.entries(care.CATEGORIES),
      };
    },
    actions: {
      open_ticket(w, b) {
        if (b.verified !== "yes") throw new SimError("Ask the security questions first, and only go on if the caller answers them correctly.");
        const k = care.openTicket(w, t, { msisdn: str(b.msisdn), category: str(b.category), description: str(b.description), txnId: str(b.txnId) || undefined, channel: "call", by });
        return ok(`Ticket ${k.id} opened. The customer has been sent an SMS.`, { ticket: k.id });
      },
      note(w, b) {
        care.addNote(w, t, b.ticket, by, str(b.text));
        return ok("Note added.");
      },
      hold(w, b) {
        return ok(`GHS ${(care.placeHold(w, t, b.ticket, by) / 100).toFixed(2)} is now on hold.`);
      },
      ask_recipient(w, b) {
        care.requestConsent(w, t, b.ticket, by);
        return ok("The recipient has been asked by SMS. They answer from their phone, under option 4.");
      },
      return_funds(w, b) {
        const r = care.returnFunds(w, t, b.ticket, by);
        return ok(r.full ? "The full amount has been returned to the sender." : `GHS ${(r.returned / 100).toFixed(2)} returned. The rest could not be recovered.`);
      },
      forward(w, b) {
        const theirs = care.forwardDispute(w, t, b.ticket, by);
        return ok(`Sent to ${participantName(theirs.telco)} through the national switch as ${theirs.id}.`);
      },
      reverse_agent(w, b) {
        care.reverseAgentTransaction(w, t, b.ticket, by);
        return ok("Transaction reversed.");
      },
      close(w, b) {
        care.closeTicket(w, t, b.ticket, by, { outcome: str(b.outcome), resolution: str(b.resolution) });
        return ok("Ticket closed. The customer has been sent an SMS.");
      },
      block_sim(w, b) {
        telcoOps.setSimStatus(w, t, by, b.msisdn, "blocked", str(b.reason) || "Reported lost or stolen by phone");
        return ok("Number blocked. To get it back the customer visits a service centre with their Ghana Card.");
      },
      freeze_wallet(w, b) {
        telcoOps.setWalletStatus(w, t, b.msisdn, "frozen", str(b.reason) || "Frozen by customer care");
        return ok("Wallet frozen. No money can go in or out until the back office unfreezes it.");
      },
      txn: txnDetail,
    },
  };
}

// ---------- phone ----------

const phone: System = {
  view(w, q) {
    const lines = (w.db
      .prepare(
        `SELECT s.msisdn, s.telco, s.status, p.first_names || ' ' || p.surname AS owner, w.owner_type, w.display_name
         FROM sims s JOIN persons p ON p.id = s.person_id LEFT JOIN wallets w ON w.msisdn = s.msisdn WHERE s.status IN ('active','blocked') ORDER BY s.registered_at`,
      )
      .all() as { msisdn: string; telco: Telco; status: string; owner: string; owner_type: string | null; display_name: string | null }[]).map((l) => ({
      msisdn: l.msisdn, telco: l.telco, status: l.status, owner: l.owner, label: l.owner_type && l.owner_type !== "person" ? `${l.display_name} (${l.owner_type})` : l.owner, kind: l.owner_type ?? "no wallet",
    }));
    const msisdn = q.get("msisdn") ? normalizeMsisdn(q.get("msisdn")!) : undefined;
    const sim = msisdn ? telcoOps.getSim(w, msisdn) : undefined;
    if (!sim || sim.status === "in_stock") return { lines, phone: null };
    const wallet = walletByMsisdn(w, sim.msisdn);
    const brand = TELCO_INFO[sim.telco];
    return {
      lines,
      phone: {
        msisdn: sim.msisdn,
        telco: sim.telco,
        brand,
        logo: telcoLogo(sim.telco),
        simStatus: sim.status,
        owner: lines.find((l) => l.msisdn === sim.msisdn)?.owner ?? "",
        shortcode: getConfig(w.db, `telco.${sim.telco}`).menu.shortcode,
        codes: [
          { code: getConfig(w.db, `telco.${sim.telco}`).menu.shortcode, label: brand.wallet },
          { code: REGISTRATION_CHECK_CODE, label: "SIM registration status" },
          { code: LINKED_SIMS_CODE, label: "Numbers on my Ghana Card" },
          { code: OWN_NUMBER_CODE[sim.telco], label: "My number" },
        ],
        wallet: wallet ? { name: wallet.display_name, type: wallet.owner_type, tier: wallet.kyc_tier, status: wallet.status, balance: money(wallet.balance) } : null,
        sms: (w.db.prepare("SELECT id, sender, body, at FROM sms WHERE msisdn = ? ORDER BY id DESC LIMIT 60").all(sim.msisdn) as { id: number; sender: string; body: string; at: number }[]).map((s) => ({ ...s, at: iso(s.at) })),
        approvals: wallet ? pendingFor(w, sim.msisdn).map((a) => ({ ref: a.ref, kind: a.kind, amount: money(a.amount), from: a.display_name })) : [],
        calls: callLog(w, sim.msisdn),
        conversations: conversations(w, sim.msisdn),
        thread: q.get("thread") ? thread(w, sim.msisdn, q.get("thread")!) : null,
        recent: wallet ? txnFeed(w, "(t.from_wallet = ? OR t.to_wallet = ?) AND t.status != 'failed'", [wallet.id, wallet.id], 15).map((x) => ({ ...x, out: x.type === "hold" || x.from.includes(sim.msisdn) })) : [],
      },
    };
  },
  actions: {
    ussd(w, b) {
      if (typeof b.input !== "string") throw new SimError("input is required");
      return ussd(w, { sessionId: str(b.sessionId), msisdn: normalizeMsisdn(String(need(str(b.msisdn), "msisdn"))), input: b.input.slice(0, 182) });
    },
    sms_send(w, b) {
      const r = sendText(w, { from: String(need(str(b.msisdn), "msisdn")), to: str(b.to), text: b.text });
      return { ok: true, ...r, message: r.delivered ? "Sent." : `Not delivered: ${r.reason}` };
    },
    // Voice calls. The phone checks in about once a second with call_poll.
    call_start: (w, b) => startCall(w, { from: String(need(str(b.msisdn), "msisdn")), to: String(need(str(b.to), "Number to call")), device: String(need(str(b.device), "device")), offer: String(b.offer ?? "") }),
    call_poll: (w, b) => pollCall(w, { msisdn: String(need(str(b.msisdn), "msisdn")), device: String(need(str(b.device), "device")), callId: str(b.callId) || undefined, have: Number(b.have ?? 0), candidates: Array.isArray(b.candidates) ? b.candidates : undefined }),
    call_answer(w, b) {
      answerCall(w, { callId: String(need(str(b.callId), "callId")), msisdn: String(need(str(b.msisdn), "msisdn")), device: String(need(str(b.device), "device")), answer: String(b.answer ?? "") });
      return { ok: true };
    },
    call_end(w, b) {
      endCall(w, { callId: String(need(str(b.callId), "callId")), msisdn: String(need(str(b.msisdn), "msisdn")), reason: str(b.reason) });
      return { ok: true };
    },
  },
};

// ---------- banks ----------

function bankSystem(bank: string): System {
  const name = bankName(bank);
  return {
    view(w) {
      const accounts = w.db.prepare("SELECT a.*, p.ghana_card FROM bank_accounts a LEFT JOIN persons p ON p.id = a.person_id WHERE a.bank = ? ORDER BY a.kind DESC, a.created_at").all(bank) as Record<string, string | number | null>[];
      return {
        bank,
        name,
        banks: BANKS,
        stats: {
          accounts: accounts.filter((a) => a.kind === "personal").length,
          deposits: money(accounts.filter((a) => a.kind === "personal").reduce((s, a) => s + (a.balance as number), 0)),
          trustHeld: money(accounts.filter((a) => a.kind === "trust").reduce((s, a) => s + (a.balance as number), 0)),
          vaultCash: money(-balanceOf(w, `vault:${bank}`)),
          settlementAccount: money(-balanceOf(w, `reserve:${bank}`)),
          switchPosition: money(balanceOf(w, `switch:${bank}`)),
          feeIncome: money(balanceOf(w, `fee:${bank}`)),
        },
        accounts: accounts.map((a) => ({ id: a.id, accountNo: a.account_no, name: a.name, kind: a.kind, telco: a.telco, status: a.status, balance: money(a.balance as number), card: a.ghana_card, openedAt: iso(a.created_at as number) })),
        txns: txnFeed(w, "t.from_party = ? OR t.to_party = ?", [bank, bank], 150),
        activity: auditFeed(w, bank),
        config: getConfig(w.db, `bank.${bank}`),
      };
    },
    actions: {
      open_account(w, b) {
        const a = openAccount(w, bank, { card: str(b.card), fingerprint: str(b.fingerprint) });
        return ok(`Account opened for ${a.name}. Account number: ${a.account_no}`);
      },
      deposit: (w, b) => ok(bankCash(w, { bank, account: String(need(str(b.account), "Account")), amount: amountOf(b.amount), kind: "deposit" }).message),
      withdraw: (w, b) => ok(bankCash(w, { bank, account: String(need(str(b.account), "Account")), amount: amountOf(b.amount), kind: "withdrawal" }).message),
      transfer: (w, b) => ok(bankTransfer(w, { bank, fromAccount: String(need(str(b.account), "Account")), toAccountNo: String(need(str(b.toAccountNo), "Destination account number")), amount: amountOf(b.amount), reference: str(b.reference) }).message),
      to_wallet: (w, b) =>
        ok(bankToWallet(w, { bank, fromAccount: str(b.account) || undefined, msisdn: normalizeMsisdn(String(need(str(b.msisdn), "Mobile number"))), amount: amountOf(b.amount), reference: str(b.reference) }).message),
      account_status(w, b) {
        setAccountStatus(w, bank, String(b.account), b.status === "frozen" ? "frozen" : "active");
        return ok("Account updated.");
      },
      settings: saveSettings(`bank.${bank}`),
      txn: txnDetail,
    },
  };
}

// ---------- national switch ----------

const switchSystem: System = {
  view(w) {
    const pos = positions(w);
    return {
      participants: pos.map((p) => ({ ...p, position: money(p.position), feesBilled: money(p.feesBilled), settlesVia: p.kind === "telco" ? bankName(TRUST_BANK[p.participant as Telco]) : "Bank of Ghana" })),
      stats: {
        routed: sum(w, "SELECT COUNT(*) AS n FROM txns WHERE rail = 'switch' AND status IN ('success','reversed') AND type NOT IN ('settlement','reversal')"),
        value: money(sum(w, "SELECT COALESCE(SUM(amount),0) AS n FROM txns WHERE rail = 'switch' AND status IN ('success','reversed') AND type NOT IN ('settlement','reversal')")),
        rejected: sum(w, "SELECT COUNT(*) AS n FROM switch_log WHERE step = 'reject'"),
        unsettled: money(pos.filter((p) => p.position > 0).reduce((s, p) => s + p.position, 0)),
      },
      log: (w.db.prepare("SELECT * FROM switch_log ORDER BY id DESC LIMIT 200").all() as { id: number; txn_id: string | null; step: string; from_party: string | null; to_party: string | null; detail: string; at: number }[]).map((l) => ({
        ...l, at: iso(l.at), from: l.from_party ? participantName(l.from_party) : "", to: l.to_party ? participantName(l.to_party) : "",
      })),
      settlements: (w.db.prepare("SELECT * FROM settlements ORDER BY at DESC LIMIT 20").all() as { id: string; at: number; detail: string }[]).map((s) => ({ id: s.id, at: iso(s.at), lines: (JSON.parse(s.detail) as { name: string; net: number }[]).map((l) => ({ name: l.name, net: money(l.net) })) })),
      txns: txnFeed(w, "t.rail = 'switch'", [], 100),
      // Disputes one network has raised with another. The switch carries them and, if money comes back, routes it.
      disputes: (w.db
        .prepare(
          `SELECT a.id, a.telco, a.status, a.created_at, a.updated_at, a.resolution, b.id AS other_id, b.telco AS other_telco, b.held, b.returned, x.amount
           FROM tickets a JOIN tickets b ON b.id = a.linked_ticket JOIN txns x ON x.id = a.txn_id WHERE a.role = 'sender' ORDER BY a.created_at DESC LIMIT 100`,
        )
        .all() as Record<string, string | number | null>[]).map((d) => ({
        id: d.id, from: participantName(String(d.telco)), otherId: d.other_id, to: participantName(String(d.other_telco)), amount: money(d.amount as number), held: money(d.held as number), returned: money(d.returned as number),
        status: d.status, resolution: d.resolution, raisedAt: iso(d.created_at as number), updatedAt: iso(d.updated_at as number),
      })),
      config: getConfig(w.db, "switch"),
      activity: auditFeed(w, "switch"),
    };
  },
  actions: {
    connect(w, b) {
      const p = String(b.participant);
      if (!PARTICIPANTS.includes(p)) throw new SimError("Unknown participant");
      const connected = b.connected === true || b.connected === "true";
      setConfig(w.db, "switch", applyPatch(getConfig(w.db, "switch"), [{ op: "replace", path: `/participants/${p}/connected`, value: connected }]), `${participantName(p)} ${connected ? "connected to" : "disconnected from"} the switch`, "console");
      return ok(`${participantName(p)} ${connected ? "connected" : "disconnected"}.`);
    },
    settle(w) {
      const r = settle(w);
      return ok(`Settlement ${r.id.slice(4, 12).toUpperCase()} completed for ${r.lines.length} participant(s).`, { lines: r.lines.map((l) => ({ ...l, net: money(l.net) })) });
    },
    settings: saveSettings("switch"),
    txn: txnDetail,
  },
};

// ---------- Bank of Ghana ----------

const bog: System = {
  view(w) {
    return {
      config: getConfig(w.db, "bog"),
      issuers: TELCOS.map((t) => {
        const wallets = sum(w, "SELECT COALESCE(SUM(balance),0) AS n FROM wallets WHERE telco = ?", t);
        const revenue = balanceOf(w, `fee:${t}`);
        const trust = trustAccount(w, t)?.balance ?? 0;
        const position = balanceOf(w, `switch:${t}`);
        // Customers' money held during a dispute has left their wallets but is still e-money the issuer owes.
        const held = balanceOf(w, `hold:${t}`);
        return {
          telco: t, name: TELCO_INFO[t].wallet, trustBank: bankName(TRUST_BANK[t]), customerFunds: money(wallets), onHold: money(held), issuerFunds: money(revenue), eMoney: money(wallets + held + revenue), trustBalance: money(trust), unsettled: money(position),
          // Every cedi of e-money must be backed: by the trust account, or by money still owed to the issuer through the switch.
          backed: wallets + held + revenue === trust - position,
        };
      }),
      banks: BANK_IDS.map((b) => ({
        bank: b, name: bankName(b),
        deposits: money(sum(w, "SELECT COALESCE(SUM(balance),0) AS n FROM bank_accounts WHERE bank = ?", b)),
        vaultCash: money(-balanceOf(w, `vault:${b}`)),
        settlementAccount: money(-balanceOf(w, `reserve:${b}`)),
        unsettled: money(balanceOf(w, `switch:${b}`)),
      })),
      wallets: TIERS.map((tier) => ({ tier, count: sum(w, "SELECT COUNT(*) AS n FROM wallets WHERE owner_type = 'person' AND kyc_tier = ?", tier) })),
      ledgerBalanced: sum(w, "SELECT COUNT(*) AS n FROM (SELECT txn_id FROM postings GROUP BY txn_id HAVING SUM(amount) != 0)") === 0,
      activity: auditFeed(w, "bog"),
    };
  },
  actions: { settings: saveSettings("bog") },
};

// ---------- NCA ----------

const nca: System = {
  view(w, q) {
    const card = q.get("card") ? normalizeCard(q.get("card")!) : "";
    return {
      config: getConfig(w.db, "nca"),
      networks: TELCOS.map((t) => ({
        telco: t, name: TELCO_INFO[t].name,
        registered: sum(w, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'active'", t),
        blocked: sum(w, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'blocked'", t),
        deactivated: sum(w, "SELECT COUNT(*) AS n FROM sims WHERE telco = ? AND status = 'deactivated'", t),
        points: sum(w, "SELECT COUNT(*) AS n FROM sim_agents WHERE telco = ?", t),
      })),
      // The central register: every number, on every network, against the Ghana Card it was registered with.
      registry: (w.db
        .prepare(
          `SELECT s.msisdn, s.telco, s.status, s.registered_at, s.registered_by, p.ghana_card, p.first_names || ' ' || p.surname AS owner,
            (SELECT COUNT(*) FROM sims x WHERE x.person_id = s.person_id AND x.status IN ('active','blocked')) AS held
           FROM sims s JOIN persons p ON p.id = s.person_id WHERE s.status != 'in_stock' ${card ? "AND p.ghana_card = ?" : ""} ORDER BY s.registered_at DESC LIMIT 400`,
        )
        .all(...(card ? [card] : [])) as Record<string, string | number>[]).map((r) => ({ ...r, network: TELCO_INFO[r.telco as Telco].name, registered_at: iso(r.registered_at as number) })),
      activity: auditFeed(w, "nca"),
    };
  },
  actions: {
    settings: saveSettings("nca"),
    // The regulator orders a number off the network; the operator must comply.
    order_block(w, b) {
      const sim = telcoOps.getSim(w, normalizeMsisdn(String(need(str(b.msisdn), "Mobile number"))));
      if (!sim) throw new SimError("Number not found");
      telcoOps.setSimStatus(w, sim.telco, "NCA directive", sim.msisdn, "blocked", str(b.reason) || "Blocked on the regulator's directive");
      audit(w, "nca", "directive", `Ordered ${TELCO_INFO[sim.telco].name} to block ${sim.msisdn}`);
      return ok(`${TELCO_INFO[sim.telco].name} has blocked ${sim.msisdn}.`);
    },
  },
};

// ---------- registry ----------

export const SYSTEM_PATHS = ["hub", "nia", "telco/{mtn|telecel|at}", "care/{mtn|telecel|at}", "sim-agent/{mtn|telecel|at}", "momo-agent/{mtn|telecel|at}", "phone", `bank/{${BANK_IDS.join("|")}}`, "switch", "bog", "nca"];

export function resolveSystem(path: string[]): System {
  const [a, b] = path;
  const telco = () => {
    if (!b || !isTelco(b)) throw new SimError("Unknown network. Use mtn, telecel or at.", 404);
    return b;
  };
  switch (a) {
    case "hub":
      return hub;
    case "nia":
      return nia;
    case "telco":
      return telcoSystem(telco());
    case "care":
      return careSystem(telco());
    case "sim-agent":
      return simAgentSystem(telco());
    case "momo-agent":
      return momoAgentSystem(telco());
    case "phone":
      return phone;
    case "bank":
      if (!b || !BANK_IDS.includes(b)) throw new SimError(`Unknown bank. Use one of: ${BANK_IDS.join(", ")}`, 404);
      return bankSystem(b);
    case "switch":
      return switchSystem;
    case "bog":
      return bog;
    case "nca":
      return nca;
  }
  throw new SimError(`Unknown system. Use one of: ${SYSTEM_PATHS.join(", ")}`, 404);
}

export { approvalView };
