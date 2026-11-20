import { getConfig } from "./config/store";
import { count, setMeta, tx } from "./db";
import { feeFor } from "./ledger";
import { settle } from "./switch";
import { BANKS, DAY, HOUR, MINUTE, SimError, TELCOS, TELCO_INFO, TRUST_BANK, bankName, cedis, clock, participantName, type Telco } from "./util";
import type { World } from "./world";

/**
 * Fills an empty world with a simulated country and three months of activity: people with Ghana
 * Cards, SIMs registered at registration points, wallets, agents, merchants, bank accounts, and
 * every transaction between them, written through the same ledger the live sandbox uses.
 *
 * A share of the transactions are fraud, in ten scenarios. Each fraud case plays out step by step
 * (the lure by text or call, the victim's payment, the money moving through other wallets, the
 * cash-out), and every transaction is labelled in the `dataset` table.
 *
 * The same seed always produces the same country.
 */

export interface SimOptions {
  seed?: number;
  /** Transactions to produce. */
  total?: number;
  /** Share of them that are fraud. */
  fraudShare?: number;
  days?: number;
  /** The moment the history ends. Defaults to the start of today (UTC). */
  end?: number;
}

export const SIM_DEFAULTS = { seed: 2026, total: 100_023, fraudShare: 0.22, days: 90 };

export const SCENARIOS = {
  reversal_scam: "A fake \"payment received\" text, then a call asking for the money to be sent back",
  pin_phishing: "A caller posing as customer service gets the PIN and empties the wallet",
  sim_swap: "The victim's number is moved to the fraudster's SIM, then the wallet is emptied",
  agent_fraud: "A fake head-office call makes an agent send float, or a stolen wallet is cashed out at a complicit agent",
  mule_chain: "Money taken from a bank account is passed through several wallets and cashed out",
  fake_promo: "A text says the victim has won a prize and must pay a fee to claim it",
  rtp_abuse: "The victim is told to approve a prompt to receive money; approving it pays the fraudster",
  fake_merchant: "A fake shop takes payment for goods that never arrive",
  relative_impersonation: "A text from \"a relative on a new number\" asks for urgent money",
  limit_splitting: "A large stolen sum is split into amounts below the daily limit and sent to many wallets",
} as const;
export type Scenario = keyof typeof SCENARIOS;

/** How the fraud transactions are shared between the scenarios. */
const SCENARIO_SHARE: Record<Scenario, number> = {
  reversal_scam: 0.15, pin_phishing: 0.12, sim_swap: 0.08, agent_fraud: 0.09, mule_chain: 0.13,
  fake_promo: 0.09, rtp_abuse: 0.08, fake_merchant: 0.08, relative_impersonation: 0.1, limit_splitting: 0.08,
};

export interface SimSummary {
  seed: number;
  transactions: number;
  fraud: number;
  legitimate: number;
  failed: number;
  cases: number;
  byScenario: Record<string, { transactions: number; cases: number }>;
  from: string;
  to: string;
  people: number;
  sims: number;
  wallets: number;
  agents: number;
  merchants: number;
  bankAccounts: number;
  texts: number;
  calls: number;
  complaints: number;
}

// ---------- random numbers ----------

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number) {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  normal() {
    return Math.sqrt(-2 * Math.log(1 - this.next())) * Math.cos(2 * Math.PI * this.next());
  }
  /** A positive amount with a long tail: `median` is the middle value. */
  logn(median: number, sigma: number) {
    return median * Math.exp(sigma * this.normal());
  }
  weighted<T>(items: readonly T[], weight: (t: T) => number): T {
    let r = this.next() * items.reduce((s, i) => s + weight(i), 0);
    for (const i of items) if ((r -= weight(i)) < 0) return i;
    return items[items.length - 1];
  }
  digits(n: number) {
    let s = "";
    for (let i = 0; i < n; i++) s += Math.floor(this.next() * 10);
    return s;
  }
  hex(n: number) {
    let s = "";
    for (let i = 0; i < n; i++) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }
}

// ---------- the people and places the country is made of ----------

const FIRST_F = ["Akosua", "Ama", "Adwoa", "Abena", "Akua", "Yaa", "Afua", "Efua", "Esi", "Adjoa", "Gifty", "Comfort", "Patience", "Felicia", "Joyce", "Mercy", "Grace", "Linda", "Esther", "Naa", "Dzifa", "Enyonam", "Yayra", "Amina", "Mariama", "Zainab", "Rukaya", "Priscilla", "Vida", "Mavis"];
const FIRST_M = ["Kwame", "Kwaku", "Kofi", "Kwabena", "Kwasi", "Yaw", "Kojo", "Emmanuel", "Prince", "Evans", "Michael", "Daniel", "Isaac", "Samuel", "Richard", "Nii", "Selorm", "Elikem", "Edem", "Mawuli", "Senyo", "Abdul", "Fuseini", "Ibrahim", "Alhassan", "Rashid", "Sumaila", "Ebenezer", "Kelvin", "Bright"];
const SECOND = ["Nana", "Adoma", "Serwaa", "Boakye", "Kwadwo", "Ohemaa", "Papa", "Maame", "Sena", "Delali", "Awuni", "Laryea", "Baaba", "Kuukua", "Fiifi", "Nhyira"];
const SURNAMES = ["Mensah", "Owusu", "Boateng", "Asante", "Osei", "Agyeman", "Appiah", "Acheampong", "Darko", "Addo", "Amoah", "Ofori", "Adjei", "Kumi", "Quaye", "Tetteh", "Lartey", "Nartey", "Agbeko", "Dogbe", "Amedzro", "Kpodo", "Abubakar", "Mahama", "Issah", "Iddrisu", "Sulemana", "Yakubu", "Annan", "Quansah", "Aidoo", "Arthur", "Eshun", "Sarpong", "Gyamfi", "Frimpong", "Antwi", "Bonsu", "Okai", "Ankrah"];
const PLACES: { region: string; towns: string[]; weight: number }[] = [
  { region: "Greater Accra", towns: ["Accra", "Madina", "Tema", "Teshie", "Dansoman", "Adenta", "Kaneshie", "Nima"], weight: 30 },
  { region: "Ashanti", towns: ["Kumasi", "Ayeduase", "Ejisu", "Obuasi", "Konongo", "Suame", "Bantama"], weight: 24 },
  { region: "Central", towns: ["Cape Coast", "Kasoa", "Winneba"], weight: 8 },
  { region: "Western", towns: ["Takoradi", "Tarkwa"], weight: 7 },
  { region: "Eastern", towns: ["Koforidua", "Nkawkaw"], weight: 7 },
  { region: "Volta", towns: ["Ho", "Hohoe", "Keta"], weight: 6 },
  { region: "Northern", towns: ["Tamale", "Yendi"], weight: 7 },
  { region: "Bono", towns: ["Sunyani", "Berekum"], weight: 5 },
  { region: "Upper East", towns: ["Bolgatanga"], weight: 3 },
  { region: "Upper West", towns: ["Wa"], weight: 3 },
];
const MERCHANT_KINDS: [string, string[]][] = [
  ["Provisions", ["Provisions Shop", "Mini Mart", "Enterprise"]],
  ["Food", ["Chop Bar", "Waakye Joint", "Kenkey Spot", "Fast Food"]],
  ["Pharmacy", ["Pharmacy", "Chemical Shop"]],
  ["Transport", ["Station Ticketing", "Ride Services"]],
  ["Fashion", ["Fashion Home", "Boutique"]],
  ["Electronics", ["Phones & Accessories", "Electricals"]],
  ["Utilities", ["Prepaid Vendor"]],
];
const FAKE_SHOPS = ["QuickBuy Online", "GH Best Deals", "Flash Gadgets", "Accra Phone Hub", "Easy Loans GH", "Royal Imports", "Smart Shoppers", "Top Up Bonus", "Kente Direct", "Metro Tickets", "Sure Forex GH", "Lucky Deals"];
const EMPLOYERS = ["Asanka Foods Ltd", "Golden Tulip Farms", "Volta Textiles", "Ridge Security Services", "Makola Logistics", "Sunrise Academy", "Adom Pharmacy Group", "Tema Cold Stores", "Savanna Builders", "Coastline Hotels"];

// Relative activity by hour of day (Ghana time).
const HOURLY = [0.1, 0.05, 0.05, 0.05, 0.1, 0.3, 0.8, 1.3, 1.5, 1.5, 1.5, 1.5, 1.6, 1.5, 1.4, 1.4, 1.5, 1.6, 1.6, 1.4, 1.2, 0.9, 0.5, 0.25];
// Scam calls and texts follow the working day more closely.
const LURE_HOURLY = [0, 0, 0, 0, 0, 0, 0.2, 0.6, 1.2, 1.5, 1.5, 1.4, 1.2, 1.3, 1.4, 1.4, 1.3, 1.2, 1.1, 0.9, 0.5, 0.2, 0, 0];
const NIGHT_HOURLY = [1.2, 1.3, 1.2, 0.9, 0.5, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.6, 1, 1.2];

const P2P_REFS = ["", "", "", "food", "chop money", "school fees", "rent", "transport", "thanks", "for mum", "susu", "contribution", "funeral", "church dues", "light bill", "data", "loan", "fuel", "wedding", "goods"];
const MERCHANT_REFS = ["", "", "goods", "order", "bill", "items", "invoice"];
const LEGIT_TEXTS = [
  "Good morning, how are you?", "Are you coming for the meeting today?", "Call me when you are free.", "I have reached. Thank you.", "Please did you get the money I sent?",
  "I sent the 50 cedis this morning, check your MoMo.", "Please send me 20 cedis for lunch, I will pay you back on Friday.", "Happy birthday! God bless you.", "The goods have arrived. Come for yours.",
  "Where are you? I am waiting at the station.", "Church starts at 9. Don't be late.", "Mum says you should call her.", "I will send the school fees tomorrow.", "Light off again here oo.",
  "Thanks for the transfer, I have received it.", "Please top up my data, I will send the money now.", "Are you home? I am coming over.", "The landlord wants the rent by Friday.",
  "Sorry I missed your call. What is it?", "Safe journey.", "I mistakenly sent 30 cedis to you instead of Kofi, please send it back when you see this. Sorry.", "Meeting moved to 3pm.",
  "Did you watch the match last night?", "Please buy bread on your way home.", "I am at the hospital with Auntie, nothing serious.", "My phone was off, sorry. I am using it now.",
];
const BUSINESS_TEXTS = ["Your order is ready for pickup. Thank you for shopping with us.", "Thank you for your payment. We value your custom.", "New stock has arrived. Visit us this week.", "Your prescription is ready for collection.", "Reminder: your appointment is tomorrow at 10am.", "Sale this weekend. 10% off for regular customers."];

type Tier = "minimum" | "medium" | "enhanced";
type Role = "customer" | "agent" | "merchant" | "fraudster" | "mule" | "fake_merchant";

interface Person {
  id: string;
  card: string;
  first: string;
  sur: string;
  dob: string;
  gender: string;
  region: string;
  town: string;
  fingerprint: string;
  issued: number;
}
interface Account {
  id: string;
  bank: string;
  no: string;
  person: Person | null;
  name: string;
  bal: number;
  opened: number;
}
interface Wallet {
  id: string;
  msisdn: string;
  telco: Telco;
  person: Person;
  type: "person" | "agent" | "merchant";
  role: Role;
  name: string;
  tier: Tier;
  bal: number;
  opened: number;
  /** In the middle of a fraud case: left alone by everyday activity until it is over. */
  busy: number;
  day: number;
  daySum: number;
  month: number;
  monthSum: number;
  contacts: Wallet[];
  account?: Account;
  agent?: Agent;
  till?: string;
}
interface Agent {
  wallet: Wallet;
  code: string;
  name: string;
  town: string;
  cash: number;
  commission: number;
  complicit: boolean;
  topUp?: boolean;
}
interface Label {
  fraud: boolean;
  scenario?: Scenario;
  role?: string;
  caseId?: string;
  request?: boolean;
}
interface FraudCase {
  id: string;
  scenario: Scenario;
  victim?: Wallet;
  crook?: Wallet;
  /** Who holds the proceeds now, and how much of them. */
  holder?: Wallet;
  inFlight: number;
  locked: Wallet[];
  amount: number;
  paidTxn?: string;
}
/** One step of a fraud case. Every step writes exactly one transaction, unless it is marked `free`. */
type Step = { dt: number; run: (at: number) => void; free?: true };

const ghs = (n: number) => Math.round(n * 100);
const iso = (ms: number) => new Date(ms).toISOString();

export function simulate(w: World, options: SimOptions = {}): SimSummary {
  const o = { ...SIM_DEFAULTS, ...options };
  const total = Math.floor(o.total);
  if (total < 2000) throw new SimError("The simulated history needs at least 2,000 transactions");
  if (!(o.fraudShare > 0 && o.fraudShare < 0.6)) throw new SimError("The share of fraud must be between 0 and 60%");
  if (count(w.db, "SELECT COUNT(*) AS n FROM persons") || count(w.db, "SELECT COUNT(*) AS n FROM txns")) throw new SimError("Simulated data can only be loaded into an empty world");

  const rng = new Rng(o.seed);
  const today = Date.now() - (Date.now() % DAY);
  const end = o.end ?? today;
  const start = end - o.days * DAY;
  const scale = total / SIM_DEFAULTS.total;
  const sized = (n: number, min: number) => Math.max(min, Math.round(n * scale));

  const telcoCfg = { mtn: getConfig(w.db, "telco.mtn"), telecel: getConfig(w.db, "telco.telecel"), at: getConfig(w.db, "telco.at") };
  const bankCfg = Object.fromEntries(BANKS.map((b) => [b.id as string, getConfig(w.db, `bank.${b.id}`)]));
  const tiers = getConfig(w.db, "bog").kycTiers;
  const switchFee = getConfig(w.db, "switch").feePerTxn;

  // ---------- statements ----------
  const db = w.db;
  const insPerson = db.prepare("INSERT INTO persons(id, ghana_card, surname, first_names, dob, gender, nationality, region, town, fingerprint, status, issued_at) VALUES(?,?,?,?,?,?,'Ghanaian',?,?,?,'active',?)");
  const insSim = db.prepare("INSERT INTO sims(msisdn, telco, iccid, puk, status, person_id, registered_at, registered_by, last_swap_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const insSimAgent = db.prepare("INSERT INTO sim_agents(id, telco, person_id, name, kind, town, created_at) VALUES(?,?,?,?,?,?,?)");
  const insWallet = db.prepare("INSERT INTO wallets(id, msisdn, telco, person_id, owner_type, display_name, kyc_tier, pin, balance, created_at) VALUES(?,?,?,?,?,?,?,?,0,?)");
  const insAgent = db.prepare("INSERT INTO momo_agents(wallet_id, code, name, town, cash, commission, created_at) VALUES(?,?,?,?,0,0,?)");
  const insMerchant = db.prepare("INSERT INTO merchants(wallet_id, till, name, category, town, created_at) VALUES(?,?,?,?,?,?)");
  const insAccount = db.prepare("INSERT INTO bank_accounts(id, bank, account_no, person_id, name, kind, created_at) VALUES(?,?,?,?,?, 'personal', ?)");
  const insTxn = db.prepare(
    `INSERT INTO txns(id, type, channel, from_wallet, to_wallet, from_account, to_account, from_party, to_party, rail, amount, fee, commission, status, reason, reference, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insPosting = db.prepare("INSERT INTO postings(txn_id, account, amount, at) VALUES(?,?,?,?)");
  const insSwitch = db.prepare("INSERT INTO switch_log(txn_id, step, from_party, to_party, detail, at) VALUES(?,?,?,?,?,?)");
  const insData = db.prepare("INSERT INTO dataset(txn_id, seq, is_fraud, scenario, role, case_id, payment_request) VALUES(?,?,?,?,?,?,?)");
  const insApproval = db.prepare("INSERT INTO approvals(ref, kind, telco, payee_wallet, payer_msisdn, amount, payer_message, status, txn_id, created_at) VALUES(?, 'rtp', ?,?,?,?,?, 'SUCCESSFUL', ?, ?)");

  // Records that are not transactions are collected and written in time order at the end.
  const simEvents: [number, string, string, string, string][] = [];
  const niaLog: [number, string, string, string, number, string][] = [];
  const texts: { at: number; kind: "person" | "app"; sender: string; fromTelco: Telco; to: Wallet | { msisdn: string; telco: Telco }; body: string }[] = [];
  const calls: { at: number; from: string; to: string; fromTelco: Telco; toTelco: Telco; status: string; reason: string | null; answered: number | null; ended: number }[] = [];
  const tickets: { at: number; telco: Telco; msisdn: string; category: string; description: string; channel: string; status: string; txn: string | null; role: string | null; resolution: string | null; updated: number }[] = [];
  const swaps = new Map<string, number>();

  // ---------- people ----------
  const usedCards = new Set<string>();
  const usedNames = new Set<string>();
  const usedNumbers = new Set<string>();
  const usedAccounts = new Set<string>();
  const people: Person[] = [];

  function person(minAge = 18, maxAge = 70): Person {
    const female = rng.chance(0.5);
    const place = rng.weighted(PLACES, (p) => p.weight);
    let first = "", sur = "", dob = "";
    do {
      first = rng.pick(female ? FIRST_F : FIRST_M) + (rng.chance(0.3) ? ` ${rng.pick(SECOND)}` : "");
      sur = rng.pick(SURNAMES);
      const born = new Date(end - (minAge * 365.25 + rng.next() * (maxAge - minAge) * 365.25) * DAY);
      dob = born.toISOString().slice(0, 10);
    } while (usedNames.has(`${first}|${sur}|${dob}`));
    usedNames.add(`${first}|${sur}|${dob}`);
    let card = "";
    do card = `GHA-${rng.int(1, 9)}${rng.digits(8)}-${rng.int(0, 9)}`;
    while (usedCards.has(card));
    usedCards.add(card);
    const p: Person = { id: `p_${rng.hex(16)}`, card, first, sur, dob, gender: female ? "F" : "M", region: place.region, town: rng.pick(place.towns), fingerprint: `FP-${rng.hex(6).toUpperCase()}`, issued: start - rng.int(200, 2600) * DAY };
    insPerson.run(p.id, p.card, p.sur, p.first, p.dob, p.gender, p.region, p.town, p.fingerprint, p.issued);
    people.push(p);
    return p;
  }
  const nameOf = (p: Person) => `${p.first} ${p.sur}`;
  const pickTelco = (): Telco => {
    const r = rng.next();
    return r < 0.62 ? "mtn" : r < 0.85 ? "telecel" : "at";
  };
  const number = (telco: Telco) => {
    for (;;) {
      const n = rng.pick(TELCO_INFO[telco].prefixes) + rng.digits(7);
      if (!usedNumbers.has(n)) {
        usedNumbers.add(n);
        return n;
      }
    }
  };

  // SIM registration points: two service centres and two registration agents per network.
  // One registration agent on each network is careless about who it serves.
  const points: Record<Telco, { id: string; careless: boolean }[]> = { mtn: [], telecel: [], at: [] };
  for (const t of TELCOS) {
    for (let i = 0; i < 4; i++) {
      const owner = person(25, 60);
      const kind = i < 2 ? "service_centre" : "registration_agent";
      const id = `${TELCO_INFO[t].name.toUpperCase()}-${kind === "service_centre" ? "SC" : "RA"}-${String(i + 1).padStart(4, "0")}`;
      insSimAgent.run(id, t, owner.id, kind === "service_centre" ? `${owner.town} ${TELCO_INFO[t].name} Service Centre` : `${owner.sur} Connect, ${owner.town}`, kind, owner.town, start - rng.int(300, 1500) * DAY);
      points[t].push({ id, careless: i === 3 });
    }
  }

  const wallets: Wallet[] = [];
  const byId = new Map<string, Wallet>();
  const accounts: Account[] = [];
  const acctById = new Map<string, Account>();

  function sim(p: Person, telco: Telco, registeredAt: number, careless = false): string {
    const msisdn = number(telco);
    const point = careless ? points[telco][3] : rng.pick(points[telco].slice(0, 3));
    insSim.run(msisdn, telco, `8923301${rng.digits(12)}`, rng.digits(8), "active", p.id, registeredAt, point.id, null, registeredAt - rng.int(5, 200) * DAY);
    simEvents.push([registeredAt, msisdn, "registered", point.id, `Ghana Card ${p.card}, biometric match`]);
    niaLog.push([registeredAt, telco, `SIM registration at ${point.id}`, p.card, 1, "MATCH"]);
    return msisdn;
  }
  function pinFor(msisdn: string, p: Person): string {
    const r = rng.next();
    if (r < 0.34) return msisdn.slice(-4);
    if (r < 0.43) return p.dob.slice(0, 4);
    if (r < 0.48) return rng.pick(["1234", "0000", "1111", "2580", "1212"]);
    return rng.digits(4);
  }
  function wallet(p: Person, telco: Telco, x: { type?: Wallet["type"]; role: Role; name?: string; tier?: Tier; opened: number; careless?: boolean }): Wallet {
    const registered = x.opened - rng.int(0, x.role === "customer" ? 400 : 6) * DAY - rng.int(1, 20) * HOUR;
    const msisdn = sim(p, telco, registered, x.careless);
    const r = rng.next();
    const v: Wallet = {
      id: `w_${msisdn}`, msisdn, telco, person: p, type: x.type ?? "person", role: x.role, name: x.name ?? nameOf(p), tier: x.tier ?? (r < 0.3 ? "minimum" : r < 0.92 ? "medium" : "enhanced"),
      bal: 0, opened: x.opened, busy: 0, day: -1, daySum: 0, month: -1, monthSum: 0, contacts: [],
    };
    insWallet.run(v.id, msisdn, telco, p.id, v.type, v.name, v.tier, pinFor(msisdn, p), x.opened);
    wallets.push(v);
    byId.set(v.id, v);
    return v;
  }
  function account(p: Person | null, name: string, opened: number, bank = rng.weighted(BANKS, (b) => (b.id === "gcb" ? 3 : b.id === "ecobank" ? 2.5 : 1.5)).id): Account {
    let no = "";
    do no = BANKS.find((b) => b.id === bank)!.sortCode + rng.digits(10);
    while (usedAccounts.has(no));
    usedAccounts.add(no);
    const a: Account = { id: `acct_${rng.hex(16)}`, bank, no, person: p, name, bal: 0, opened };
    insAccount.run(a.id, bank, no, p?.id ?? null, name, opened);
    if (p) niaLog.push([opened, bank, "Bank account opening", p.card, 1, "MATCH"]);
    accounts.push(a);
    acctById.set(a.id, a);
    return a;
  }

  // Customers. A few join during the period; the rest were already there.
  const customers: Wallet[] = [];
  const nCustomers = sized(3600, 150);
  for (let i = 0; i < nCustomers; i++) {
    const p = person();
    const opened = rng.chance(0.06) ? start + rng.next() * (end - start - 10 * DAY) : start - rng.int(20, 2400) * DAY;
    const c = wallet(p, pickTelco(), { role: "customer", opened });
    customers.push(c);
    if (rng.chance(0.36)) c.account = account(p, nameOf(p), Math.min(c.opened, start) - rng.int(30, 2000) * DAY);
    // Some people keep a second line on another network.
    if (rng.chance(0.1)) customers.push(wallet(p, rng.pick(TELCOS.filter((t) => t !== c.telco)), { role: "customer", opened: Math.min(opened + rng.int(1, 60) * DAY, Math.max(opened, end - 2 * DAY)) }));
  }
  const byTown = new Map<string, Wallet[]>();
  for (const c of customers) byTown.set(c.person.town, [...(byTown.get(c.person.town) ?? []), c]);
  for (const c of customers) {
    const near = byTown.get(c.person.town)!;
    const n = rng.int(4, 12);
    for (let i = 0; i < n; i++) {
      const other = rng.chance(0.75) ? rng.pick(near) : rng.pick(customers);
      if (other !== c && !c.contacts.includes(other)) c.contacts.push(other);
    }
  }
  // How often each customer transacts: most a little, a few a lot.
  const activity = customers.map(() => rng.logn(1, 0.9));
  const activityTotal = activity.reduce((a, b) => a + b, 0);
  const cumulative: number[] = [];
  activity.reduce((s, a, i) => (cumulative[i] = s + a), 0);
  const anyCustomer = (): Wallet => {
    const r = rng.next() * activityTotal;
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return customers[lo];
  };

  // Mobile money agents, each with a business line and a bank account. A few are complicit in fraud.
  const agents: Agent[] = [];
  const nAgents = sized(140, 12);
  let agentCode = 200000, tillNo = 100000;
  for (let i = 0; i < nAgents; i++) {
    const p = person(22, 60);
    const telco = i < 3 ? TELCOS[i] : pickTelco();
    const name = rng.pick([`${p.first.split(" ")[0]} Mobile Money`, `${p.sur} Ventures`, `${p.town} MoMo Centre`, `${p.sur} & Sons Enterprise`, `God's Grace MoMo, ${p.town}`]);
    const v = wallet(p, telco, { type: "agent", role: "agent", name, tier: "enhanced", opened: start - rng.int(60, 1800) * DAY });
    v.account = account(p, nameOf(p), v.opened - rng.int(10, 600) * DAY, TRUST_BANK[telco]);
    const a: Agent = { wallet: v, code: String(++agentCode), name, town: p.town, cash: 0, commission: 0, complicit: false };
    v.agent = a;
    insAgent.run(v.id, a.code, name, p.town, v.opened);
    agents.push(a);
  }
  for (const t of TELCOS) {
    const own = agents.filter((a) => a.wallet.telco === t);
    for (let i = 0; i < Math.max(1, Math.round(own.length * 0.06)); i++) own[own.length - 1 - i].complicit = true;
  }
  const agentsOf = Object.fromEntries(TELCOS.map((t) => [t, agents.filter((a) => a.wallet.telco === t)])) as Record<Telco, Agent[]>;

  // Merchants.
  const merchants: Wallet[] = [];
  const nMerchants = sized(220, 12);
  for (let i = 0; i < nMerchants; i++) {
    const p = person(22, 65);
    const [category, kinds] = rng.pick(MERCHANT_KINDS);
    const name = `${rng.chance(0.5) ? `${p.first.split(" ")[0]}'s` : p.sur} ${rng.pick(kinds)}`;
    const v = wallet(p, pickTelco(), { type: "merchant", role: "merchant", name, tier: "enhanced", opened: start - rng.int(40, 1500) * DAY });
    v.till = String(++tillNo);
    insMerchant.run(v.id, v.till, name, category, p.town, v.opened);
    if (rng.chance(0.7)) v.account = account(p, nameOf(p), v.opened - rng.int(5, 300) * DAY);
    merchants.push(v);
  }

  // Fraudsters, the people whose wallets they move money through, and fake shops. Their lines are new.
  const recent = () => (rng.chance(0.45) ? start - rng.int(1, 25) * DAY : start + rng.next() * (end - start) * 0.7);
  const fraudsters: Wallet[] = [];
  for (let i = 0; i < sized(60, 10); i++) {
    const p = person(19, 45);
    const v = wallet(p, pickTelco(), { role: "fraudster", tier: rng.chance(0.6) ? "medium" : "minimum", opened: i < 12 ? start - rng.int(1, 25) * DAY : recent(), careless: rng.chance(0.7) });
    if (rng.chance(0.5)) v.account = account(p, nameOf(p), v.opened - rng.int(1, 40) * DAY);
    fraudsters.push(v);
  }
  // Many of those lines are registered on a handful of Ghana Cards lent or sold for the purpose.
  const lenders = Array.from({ length: Math.max(3, sized(14, 3)) }, () => ({ p: person(20, 50), held: 0 }));
  const mules: Wallet[] = [];
  for (let i = 0; i < sized(260, 30); i++) {
    const lender = rng.chance(0.4) ? lenders.find((l) => l.held < 9) : undefined;
    if (lender) lender.held++;
    const p = lender?.p ?? person(18, 40);
    const v = wallet(p, TELCOS[i % 3 === 0 ? 0 : i % 3 === 1 ? rng.int(0, 1) : rng.int(1, 2)], { role: "mule", tier: rng.chance(0.55) ? "minimum" : "medium", opened: i < 60 ? start - rng.int(1, 25) * DAY : recent(), careless: rng.chance(0.75) });
    if (rng.chance(0.25)) v.account = account(p, nameOf(p), v.opened - rng.int(1, 30) * DAY);
    mules.push(v);
  }
  const fakeShops: Wallet[] = [];
  for (let i = 0; i < sized(30, 6); i++) {
    const p = person(20, 45);
    const name = `${rng.pick(FAKE_SHOPS)}${rng.chance(0.5) ? ` ${rng.int(2, 99)}` : ""}`;
    const v = wallet(p, pickTelco(), { type: "merchant", role: "fake_merchant", name, tier: "enhanced", opened: i < 8 ? start - rng.int(1, 20) * DAY : recent(), careless: rng.chance(0.6) });
    v.till = String(++tillNo);
    insMerchant.run(v.id, v.till, name, "Online", p.town, v.opened);
    fakeShops.push(v);
  }
  // Their wallets also see a little ordinary use.
  const occasional = [...fraudsters, ...mules];

  // Employers pay salaries from the bank into wallets.
  const employers = EMPLOYERS.map((name) => ({ account: account(null, name, start - rng.int(400, 3000) * DAY), staff: Array.from({ length: rng.int(15, 60) }, () => rng.pick(customers)) }));

  // Blank SIMs in stock, so new people can be registered straight away.
  for (const t of TELCOS) for (let i = 0; i < 40; i++) insSim.run(number(t), t, `8923301${rng.digits(12)}`, rng.digits(8), "in_stock", null, null, null, null, end - rng.int(1, 30) * DAY);

  // ---------- the ledger ----------
  let seq = 0, failed = 0;
  const perScenario: Record<string, { transactions: number; cases: number }> = Object.fromEntries(Object.keys(SCENARIOS).map((s) => [s, { transactions: 0, cases: 0 }]));
  const post = (id: string, at: number, entries: [string, number][]) => {
    let sum = 0;
    for (const [acct, amount] of entries) {
      sum += amount;
      if (amount === 0) continue;
      insPosting.run(id, acct, amount, at);
      if (acct.startsWith("w:")) byId.get(acct.slice(2))!.bal += amount;
      else if (acct.startsWith("bank:")) {
        const a = acctById.get(acct.slice(5));
        if (a) a.bal += amount;
      }
    }
    if (sum !== 0) throw new Error(`unbalanced postings for ${id}`);
  };
  interface Row {
    type: string;
    channel: string;
    from?: Wallet;
    to?: Wallet;
    fromAcct?: Account;
    toAcct?: Account;
    fromParty: string | null;
    toParty: string | null;
    rail: string;
    amount: number;
    fee?: number;
    commission?: number;
    reference?: string;
  }
  /** Writes one transaction, done or refused, with its label. Every data point goes through here. */
  function write(at: number, r: Row, label: Label, entries: [string, number][] | string): string {
    const id = `tx_${rng.hex(16)}`;
    const ok = typeof entries !== "string";
    insTxn.run(id, r.type, r.channel, r.from?.id ?? null, r.to?.id ?? null, r.fromAcct?.id ?? null, r.toAcct?.id ?? null, r.fromParty, r.toParty, r.rail, r.amount, ok ? (r.fee ?? 0) : 0, ok ? (r.commission ?? 0) : 0, ok ? "success" : "failed", ok ? null : entries, r.reference || null, at);
    if (ok) {
      post(id, at, entries);
      if (r.rail === "switch") {
        const target = r.toAcct ? `account ${r.toAcct.no}` : r.to!.msisdn;
        insSwitch.run(id, "lookup", r.fromParty, r.toParty, `${target} → ${participantName(r.toParty!)}`, at);
        insSwitch.run(id, "quote", r.fromParty, r.toParty, `amount ${cedis(r.amount)}; switch fee ${switchFee.toFixed(2)} billed to ${participantName(r.fromParty!)}`, at);
        insSwitch.run(id, "commit", r.fromParty, r.toParty, `${cedis(r.amount)} cleared; ${participantName(r.fromParty!)} owes ${participantName(r.toParty!)}`, at);
      }
    } else failed++;
    insData.run(id, ++seq, label.fraud ? 1 : 0, label.scenario ?? null, label.role ?? null, label.caseId ?? null, label.request ? 1 : 0);
    if (label.scenario) perScenario[label.scenario].transactions++;
    return id;
  }
  const positions = (from: string, to: string, amount: number): [string, number][] => [[`switch:${from}`, amount], [`switch:${to}`, -amount]];

  // Bank of Ghana KYC limits, as the live sandbox applies them.
  const roll = (v: Wallet, at: number) => {
    const day = Math.floor(at / DAY);
    const d = new Date(at);
    const month = d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (v.day !== day) [v.day, v.daySum] = [day, 0];
    if (v.month !== month) [v.month, v.monthSum] = [month, 0];
  };
  const sendRoom = (v: Wallet, at: number): number => {
    if (v.type !== "person") return Infinity;
    roll(v, at);
    const t = tiers[v.tier];
    return Math.max(0, Math.min(t.daily * 100 - v.daySum, t.monthly === null ? Infinity : t.monthly * 100 - v.monthSum));
  };
  const sendProblem = (v: Wallet, amount: number, at: number): string | undefined => {
    if (v.type !== "person") return;
    roll(v, at);
    const t = tiers[v.tier];
    if (v.daySum + amount > t.daily * 100) return `Exceeds your daily limit of GHS ${t.daily} (${v.tier} KYC)`;
    if (t.monthly !== null && v.monthSum + amount > t.monthly * 100) return `Exceeds your monthly limit of GHS ${t.monthly} (${v.tier} KYC)`;
  };
  const receiveRoom = (v: Wallet) => (v.type === "person" ? Math.max(0, tiers[v.tier].maxBalance * 100 - v.bal) : Infinity);
  const receiveProblem = (v: Wallet, amount: number) => (v.type === "person" && v.bal + amount > tiers[v.tier].maxBalance * 100 ? `Recipient wallet would exceed its balance limit of GHS ${tiers[v.tier].maxBalance} (${v.tier} KYC)` : undefined);
  const sent = (v: Wallet, amount: number, at: number) => {
    roll(v, at);
    v.daySum += amount;
    v.monthSum += amount;
  };
  const holdHours = (t: Telco) => telcoCfg[t].simSwapMomoHoldHours;
  const swapHold = (v: Wallet, at: number) => {
    const s = swaps.get(v.msisdn);
    return s !== undefined && holdHours(v.telco) && at - s < holdHours(v.telco) * HOUR ? `This number had a SIM replacement recently. Sending money is paused for ${holdHours(v.telco)} hours after a SIM swap.` : undefined;
  };

  type PayKind = "p2p" | "merchant" | "cashin" | "cashout" | "float";
  const payFee = (kind: PayKind, from: Wallet, to: Wallet, amount: number) => {
    const fees = telcoCfg[from.telco].fees;
    return kind === "p2p" ? feeFor(from.telco !== to.telco ? fees.p2p_offnet : fees.p2p_onnet, amount) : kind === "merchant" ? feeFor(fees.merchant, amount) : kind === "cashout" ? feeFor(fees.cashout, amount) : 0;
  };
  /** A wallet-to-wallet payment, by the same rules and postings as the live sandbox. Returns the transaction id if it went through. */
  function pay(at: number, kind: PayKind, from: Wallet, to: Wallet, amount: number, x: { channel?: string; reference?: string; label: Label; refuse?: string }): string | undefined {
    const cross = from.telco !== to.telco;
    const row: Row = { type: kind, channel: x.channel ?? (kind === "cashin" || kind === "float" ? "agent" : "ussd"), from, to, fromParty: from.telco, toParty: to.telco, rail: cross ? "switch" : "onnet", amount, reference: x.reference };
    const fee = payFee(kind, from, to, amount);
    const agent = kind === "cashin" ? from.agent : kind === "cashout" ? to.agent : undefined;
    const problem =
      x.refuse ?? swapHold(from, at) ?? (kind === "cashout" && agent!.cash < amount ? "The agent does not have enough cash in the till" : undefined) ?? sendProblem(from, amount, at) ?? receiveProblem(to, amount) ??
      (from.bal < amount + fee ? (kind === "cashin" ? "Agent has insufficient float" : "Insufficient balance") : undefined);
    if (problem) {
      write(at, row, x.label, problem);
      return;
    }
    const commission = agent ? feeFor(telcoCfg[from.telco].agentCommission[kind as "cashin" | "cashout"], amount) : 0;
    const entries: [string, number][] = [[`w:${from.id}`, -(amount + fee)], [`fee:${from.telco}`, fee], [`w:${to.id}`, amount]];
    if (cross) entries.push(...positions(from.telco, to.telco, amount));
    if (commission) entries.push([`fee:${from.telco}`, -commission], [`w:${agent!.wallet.id}`, commission]);
    const id = write(at, { ...row, fee, commission }, x.label, entries);
    if (agent) {
      agent.cash += kind === "cashin" ? amount : -amount;
      agent.commission += commission;
    }
    sent(from, amount, at);
    return id;
  }
  const bankFeeTo = (from: Wallet, acct: Account, amount: number) => (acct.person === from.person && telcoCfg[from.telco].ownBankAccountFree !== false ? 0 : feeFor(telcoCfg[from.telco].fees.to_bank, amount));
  function toBank(at: number, from: Wallet, acct: Account, amount: number, x: { reference?: string; label: Label }): string | undefined {
    const row: Row = { type: "wallet_to_bank", channel: "ussd", from, toAcct: acct, fromParty: from.telco, toParty: acct.bank, rail: "switch", amount, reference: x.reference };
    const fee = bankFeeTo(from, acct, amount);
    const problem = swapHold(from, at) ?? sendProblem(from, amount, at) ?? (from.bal < amount + fee ? "Insufficient balance" : undefined);
    if (problem) {
      write(at, row, x.label, problem);
      return;
    }
    const id = write(at, { ...row, fee }, x.label, [[`w:${from.id}`, -(amount + fee)], [`fee:${from.telco}`, fee], ...positions(from.telco, acct.bank, amount), [`bank:${acct.id}`, amount]]);
    sent(from, amount, at);
    return id;
  }
  /** From a bank account, or in cash over the counter when there is no account, to a wallet. */
  function fromBank(at: number, bank: string, src: Account | undefined, to: Wallet, amount: number, x: { reference?: string; label: Label }): string | undefined {
    const row: Row = { type: "bank_to_wallet", channel: "branch", fromAcct: src, to, fromParty: bank, toParty: to.telco, rail: "switch", amount, reference: x.reference };
    const fee = src ? feeFor(bankCfg[bank].fees.toWallet, amount) : 0;
    const problem = (src && src.bal < amount + fee ? "Insufficient funds in the account" : undefined) ?? receiveProblem(to, amount);
    if (problem) {
      write(at, row, x.label, problem);
      return;
    }
    return write(at, { ...row, fee }, x.label, [src ? [`bank:${src.id}`, -(amount + fee)] : [`vault:${bank}`, -amount], [`fee:${bank}`, fee], ...positions(bank, to.telco, amount), [`w:${to.id}`, amount]]);
  }
  function bankTransfer(at: number, src: Account, dest: Account, amount: number, label: Label, reference?: string) {
    const inter = src.bank !== dest.bank;
    const row: Row = { type: "bank_transfer", channel: "branch", fromAcct: src, toAcct: dest, fromParty: src.bank, toParty: dest.bank, rail: inter ? "switch" : "internal", amount, reference };
    const fee = inter ? feeFor(bankCfg[src.bank].fees.interbank, amount) : 0;
    if (src.bal < amount + fee) return void write(at, row, label, "Insufficient funds in the account");
    write(at, { ...row, fee }, label, [[`bank:${src.id}`, -(amount + fee)], [`fee:${src.bank}`, fee], ...(inter ? positions(src.bank, dest.bank, amount) : []), [`bank:${dest.id}`, amount]]);
  }
  function bankCash(at: number, a: Account, amount: number, kind: "deposit" | "withdrawal", label: Label) {
    const out = kind === "withdrawal";
    const row: Row = { type: kind, channel: "branch", fromAcct: out ? a : undefined, toAcct: out ? undefined : a, fromParty: out ? a.bank : null, toParty: out ? null : a.bank, rail: "cash", amount };
    if (out && a.bal < amount) return void write(at, row, label, "Insufficient funds in the account");
    write(at, row, label, out ? [[`bank:${a.id}`, -amount], [`vault:${a.bank}`, amount]] : [[`vault:${a.bank}`, -amount], [`bank:${a.id}`, amount]]);
  }

  // ---------- balances brought forward ----------
  // The history starts with money already in wallets, tills and accounts, as any period does.
  {
    const entries: [string, number][] = [];
    const issued: Record<string, number> = {};
    for (const v of wallets) {
      if (v.opened > start) continue;
      const cap = tiers[v.tier].maxBalance * 60;
      const open =
        v.role === "customer" ? Math.min(cap, ghs(rng.logn(140, 1.1))) : v.role === "agent" ? ghs(rng.int(6000, 30000)) : v.role === "merchant" ? ghs(rng.logn(1500, 0.8)) : v.role === "fake_merchant" ? 0 : Math.min(cap, ghs(rng.logn(20, 0.8)));
      if (!open) continue;
      entries.push([`w:${v.id}`, open]);
      issued[v.telco] = (issued[v.telco] ?? 0) + open;
    }
    for (const t of TELCOS) {
      const n = issued[t] ?? 0;
      entries.push([`emoney:${t}`, -n], [`bank:trust_${t}`, n], [`vault:${TRUST_BANK[t]}`, -n]);
      db.prepare("UPDATE bank_accounts SET balance = balance + ? WHERE id = ?").run(n, `trust_${t}`);
    }
    for (const a of accounts) {
      const open = a.person === null ? ghs(rng.int(300000, 900000)) : ghs(rng.logn(2500, 1.1));
      entries.push([`bank:${a.id}`, open], [`vault:${a.bank}`, -open]);
    }
    for (const a of agents) a.cash = ghs(rng.int(8000, 40000));
    insTxn.run("tx_opening", "opening", "system", null, null, null, null, null, null, "internal", entries.reduce((s, [, n]) => s + (n > 0 ? n : 0), 0), 0, 0, "success", null, "Balances brought forward", start);
    post("tx_opening", start, entries);
  }

  // ---------- everyday activity ----------
  const LEGIT: Label = { fraud: false };
  const round = (pesewas: number, to: number) => Math.max(100, Math.round(pesewas / (to * 100)) * to * 100);
  const amountOf = (median: number, sigma: number, max: number) => {
    const a = ghs(Math.min(max, Math.max(1, rng.logn(median, sigma))));
    return rng.chance(0.7) ? round(a, a > ghs(100) ? 10 : a > ghs(20) ? 5 : 1) : a;
  };
  const free = (v: Wallet, at: number) => v.busy === 0 && v.opened <= at && !swapHold(v, at);
  const spender = (at: number, min = ghs(8)): Wallet | undefined => {
    for (let i = 0; i < 12; i++) {
      const v = rng.chance(0.03) ? rng.pick(occasional) : anyCustomer();
      if (free(v, at) && v.bal >= min) return v;
    }
  };
  const agentNear = (v: Wallet, ok: (a: Agent) => boolean): Agent | undefined => {
    const own = agentsOf[v.telco];
    const near = own.filter((a) => a.town === v.person.town && ok(a));
    if (near.length && rng.chance(0.8)) return rng.pick(near);
    for (let i = 0; i < 10; i++) {
      const a = rng.pick(own);
      if (ok(a)) return a;
    }
  };
  // Agents run short of float or of cash, and go to the bank to put it right.
  const errands: { agent: Agent; kind: "float" | "to_bank" | "withdraw"; amount?: number }[] = [];
  const watch = (a: Agent) => {
    if (a.topUp) return;
    if (a.wallet.bal < ghs(2000)) errands.push({ agent: a, kind: "float" });
    else if (a.cash < ghs(1500)) errands.push({ agent: a, kind: "to_bank" });
    else return;
    a.topUp = true;
  };
  function errand(at: number): boolean {
    const e = errands.shift();
    if (!e) return false;
    const a = e.agent;
    const acct = a.wallet.account!;
    if (e.kind === "float") {
      const want = ghs(rng.int(8, 25) * 1000);
      if (acct.bal >= want) fromBank(at, acct.bank, acct, a.wallet, want, { reference: "float", label: LEGIT });
      else {
        // Pays in cash from the till; when the till is thin too, the owner brings more capital.
        const cash = a.cash >= want ? want : Math.max(ghs(5000), Math.floor(a.cash * 0.8));
        if (a.cash >= cash) a.cash -= cash;
        fromBank(at, acct.bank, undefined, a.wallet, cash, { reference: "float", label: LEGIT });
      }
      a.topUp = false;
    } else if (e.kind === "to_bank") {
      const amount = Math.min(ghs(rng.int(8, 20) * 1000), Math.floor((a.wallet.bal - ghs(3000)) / 100) * 100);
      if (amount < ghs(500)) {
        // Not enough float to turn into cash either: the owner brings cash.
        a.cash += ghs(rng.int(5, 15) * 1000);
        a.topUp = false;
        return false;
      }
      if (toBank(at, a.wallet, acct, amount, { reference: "cash", label: LEGIT })) errands.push({ agent: a, kind: "withdraw", amount });
      else a.topUp = false;
    } else {
      bankCash(at, acct, e.amount!, "withdrawal", LEGIT);
      a.cash += e.amount!;
      a.topUp = false;
    }
    return true;
  }
  const wrongPin = (t: Telco) => `Wrong PIN. ${telcoCfg[t].pinAttemptsBeforeLock - 1} attempt(s) left.`;
  const payday = (at: number) => {
    const d = new Date(at).getUTCDate();
    return d >= 25 || d <= 2;
  };

  /** One everyday transaction. Always writes exactly one. */
  function everyday(at: number) {
    if (errand(at)) return;
    for (let attempt = 0; attempt < 10; attempt++) {
      const r = rng.next();
      if (r < 0.39) {
        // Person to person, mostly to people they know.
        const from = spender(at);
        if (!from) continue;
        const to = from.contacts.length && rng.chance(0.85) ? rng.pick(from.contacts) : rng.pick(customers);
        if (to === from || to.opened > at) continue;
        const slip = rng.next();
        if (slip < 0.012) return void pay(at, "p2p", from, to, amountOf(60, 0.9, 2000), { reference: rng.pick(P2P_REFS), label: LEGIT, refuse: wrongPin(from.telco) });
        if (slip < 0.022) return void pay(at, "p2p", from, to, from.bal + ghs(rng.int(5, 200)), { reference: rng.pick(P2P_REFS), label: LEGIT });
        const amount = Math.min(amountOf(60, 0.9, 2000), Math.floor((from.bal * 0.9) / 100) * 100);
        if (amount < 100) continue;
        return void pay(at, "p2p", from, to, amount, { reference: rng.pick(P2P_REFS), label: LEGIT });
      }
      if (r < 0.6) {
        // Paying a shop, sometimes by approving the shop's payment request.
        const from = spender(at);
        if (!from) continue;
        const shop = rng.pick(merchants);
        const amount = Math.min(amountOf(35, 0.8, 800), Math.floor((from.bal * 0.9) / 100) * 100);
        if (amount < 100) continue;
        const request = rng.chance(0.15);
        const id = pay(at, "merchant", from, shop, amount, { reference: rng.pick(MERCHANT_REFS), label: { fraud: false, request }, refuse: rng.chance(0.01) ? wrongPin(from.telco) : undefined });
        if (request && id) insApproval.run(`rtp_${rng.hex(20)}`, shop.telco, shop.id, from.msisdn, amount, "Payment", id, at - rng.int(20, 180) * 1000);
        return;
      }
      if (r < 0.77) {
        // Cash in at an agent: favours people who are running low.
        let to = anyCustomer();
        for (let i = 0; i < 2; i++) {
          const other = anyCustomer();
          if (other.bal < to.bal) to = other;
        }
        if (to.opened > at) continue;
        const amount = Math.min(amountOf(150, 0.8, 3000), Math.floor(receiveRoom(to) / 100) * 100);
        if (amount < ghs(5)) continue;
        const a = agentNear(to, (x) => x.wallet.bal >= amount);
        if (!a) {
          watch(rng.pick(agentsOf[to.telco]));
          continue;
        }
        pay(at, "cashin", a.wallet, to, amount, { label: LEGIT });
        watch(a);
        return;
      }
      if (r < 0.88) {
        const from = spender(at, ghs(30));
        if (!from) continue;
        const fees = telcoCfg[from.telco].fees.cashout;
        let amount = Math.min(amountOf(180, 0.7, 2500), Math.floor((from.bal * 0.95) / 100) * 100);
        amount -= feeFor(fees, amount);
        amount = Math.floor(amount / 100) * 100;
        if (amount < ghs(5)) continue;
        const a = agentNear(from, (x) => x.cash >= amount);
        if (!a) {
          watch(rng.pick(agentsOf[from.telco]));
          continue;
        }
        pay(at, "cashout", from, a.wallet, amount, { label: LEGIT, refuse: rng.chance(0.012) ? wrongPin(from.telco) : undefined });
        watch(a);
        return;
      }
      if (r < 0.91) {
        const from = spender(at, ghs(100));
        if (!from) continue;
        const acct = from.account && rng.chance(0.8) ? from.account : rng.pick(accounts.filter((a) => a.person));
        const amount = Math.min(amountOf(400, 0.8, 5000), Math.floor((from.bal * 0.85) / 100) * 100);
        if (amount < ghs(20)) continue;
        return void toBank(at, from, acct, amount, { reference: acct === from.account ? "savings" : rng.pick(P2P_REFS), label: LEGIT });
      }
      if (r < 0.95) {
        // From the bank to a wallet: salaries around month end, or someone moving their own money.
        if (payday(at) && rng.chance(0.6)) {
          const e = rng.pick(employers);
          const to = rng.pick(e.staff);
          const amount = Math.min(ghs(rng.int(8, 35) * 100), Math.floor(receiveRoom(to) / 100) * 100);
          if (to.opened > at || amount < ghs(100)) continue;
          if (e.account.bal < amount) {
            bankCash(at, e.account, ghs(rng.int(200, 600) * 1000), "deposit", LEGIT);
            return;
          }
          return void fromBank(at, e.account.bank, e.account, to, amount, { reference: "salary", label: LEGIT });
        }
        const to = anyCustomer();
        if (!to.account || to.opened > at) continue;
        const amount = Math.min(amountOf(500, 0.8, 6000), Math.floor((to.account.bal * 0.6) / 100) * 100, Math.floor(receiveRoom(to) / 100) * 100);
        if (amount < ghs(20)) continue;
        return void fromBank(at, to.account.bank, to.account, to, amount, { label: LEGIT });
      }
      if (r < 0.96) {
        // One agent helps another with float.
        const a = rng.pick(agents);
        const b = rng.pick(agentsOf[a.wallet.telco]);
        const amount = ghs(rng.int(5, 40) * 100);
        if (a === b || a.wallet.bal < amount + ghs(3000)) continue;
        return void pay(at, "float", a.wallet, b.wallet, amount, { reference: "float", label: LEGIT });
      }
      if (r < 0.965) {
        // A business pays someone from its merchant wallet: a refund, a supplier, a worker.
        const shop = rng.pick(merchants);
        const to = rng.pick(customers);
        const amount = Math.min(amountOf(120, 0.8, 1500), Math.floor((shop.bal * 0.5) / 100) * 100);
        if (amount < ghs(5) || to.opened > at || receiveRoom(to) < amount) continue;
        return void pay(at, "p2p", shop, to, amount, { channel: "api", reference: rng.pick(["refund", "payment", "wages", "supplies"]), label: LEGIT });
      }
      if (r < 0.99) {
        const a = rng.pick(accounts);
        if (rng.chance(0.55)) return void bankCash(at, a, amountOf(700, 0.9, 20000), "deposit", LEGIT);
        const amount = Math.min(amountOf(500, 0.8, 8000), Math.floor((a.bal * 0.5) / 100) * 100);
        if (amount < ghs(20)) continue;
        return void bankCash(at, a, amount, "withdrawal", LEGIT);
      }
      const src = rng.pick(accounts), dest = rng.pick(accounts);
      const amount = Math.min(amountOf(900, 0.9, 20000), Math.floor((src.bal * 0.5) / 100) * 100);
      if (src === dest || amount < ghs(20)) continue;
      return void bankTransfer(at, src, dest, amount, LEGIT, rng.pick(P2P_REFS));
    }
    // Nothing above fitted: someone pays cash into their account.
    bankCash(at, rng.pick(accounts), amountOf(700, 0.9, 20000), "deposit", LEGIT);
  }

  // ---------- fraud ----------
  const openBy = (list: Wallet[], at: number, ok: (v: Wallet) => boolean = () => true): Wallet => {
    for (let i = 0; i < 40; i++) {
      const v = rng.pick(list);
      if (v.opened <= at && ok(v)) return v;
    }
    return list.find((v) => v.opened <= at && ok(v)) ?? list.find((v) => v.opened <= at) ?? list[0];
  };
  const crook = (at: number) => openBy(fraudsters, at, (v) => sendRoom(v, at) >= ghs(900) && receiveRoom(v) >= ghs(900));
  const mule = (at: number, ok: (v: Wallet) => boolean = () => true) => openBy(mules, at, ok);
  /** Someone with money in their wallet who is not already caught up in another case. */
  const victim = (at: number, min: number): Wallet => {
    for (let i = 0; i < 200; i++) {
      const v = rng.pick(customers);
      if (free(v, at) && v.bal >= min && sendRoom(v, at) >= min) return v;
    }
    return customers.filter((v) => free(v, at)).reduce((a, b) => (b.bal > a.bal ? b : a));
  };
  const lock = (c: FraudCase, v: Wallet) => {
    v.busy++;
    c.locked.push(v);
  };
  const release = (c: FraudCase) => {
    for (const v of c.locked) v.busy--;
    c.locked = [];
  };
  const text = (at: number, from: Wallet, to: Wallet, body: string) => texts.push({ at, kind: "person", sender: from.msisdn, fromTelco: from.telco, to, body });
  const call = (at: number, from: Wallet, to: Wallet, seconds: number, status = "ended") =>
    calls.push({ at, from: from.msisdn, to: to.msisdn, fromTelco: from.telco, toTelco: to.telco, status, reason: status === "missed" ? "No answer" : null, answered: status === "ended" ? at + rng.int(4, 15) * 1000 : null, ended: at + (status === "ended" ? seconds * 1000 + 15000 : rng.int(8, 30) * 1000) });
  /** The same lure goes to people who do not fall for it. */
  const strays = (at: number, from: Wallet, body: (v: Wallet) => string, withCall = false) => {
    for (let i = rng.int(1, 4); i > 0; i--) {
      const v = rng.pick(customers);
      const t = at + rng.int(-240, 240) * MINUTE;
      if (v.opened > t || t <= start || t >= end) continue;
      text(t, from, v, body(v));
      if (withCall && rng.chance(0.6)) call(t + rng.int(1, 6) * MINUTE, from, v, rng.int(15, 90), rng.chance(0.55) ? "ended" : rng.chance(0.5) ? "missed" : "declined");
    }
  };
  /** The victim complains to customer care, some of the time. */
  const complain = (c: FraudCase, at: number, authorised: boolean, chance: number, agentTxn = false) => {
    const v = c.victim;
    if (!v || !c.paidTxn || !rng.chance(chance)) return;
    const when = at + rng.int(1, 40) * HOUR;
    if (when >= end) return;
    const category = agentTxn ? (rng.chance(0.5) ? "agent_complaint" : "unauthorised") : authorised ? (rng.chance(0.3) ? "wrong_transfer" : "other") : "unauthorised";
    const says: Record<Scenario, string> = {
      reversal_scam: "Someone called to say they had sent me money by mistake and I sent it back. No money had come in.",
      pin_phishing: "A caller said they were from customer service and asked for my PIN. Then my money was gone.",
      sim_swap: "My phone lost network for a day. When it came back my wallet was empty.",
      agent_fraud: agentTxn ? "Money was withdrawn from my wallet at an agent. I was not there." : "A caller said he was from agent support and told me to send float for reconciliation.",
      mule_chain: "Money left my account and I did not send it.",
      fake_promo: "I got a text that I had won a promotion and paid a fee to claim it. Nothing came.",
      rtp_abuse: "A buyer told me to approve a prompt to receive payment. Money left my wallet instead.",
      fake_merchant: "I paid a shop online and the goods never came. The number is now off.",
      relative_impersonation: "Someone texted as my relative on a new number asking for hospital money. It was not them.",
      limit_splitting: "Money left my account and I did not send it.",
    };
    const old = end - when > 4 * DAY;
    const got = old && rng.chance(0.12);
    tickets.push({
      at: when, telco: v.telco, msisdn: v.msisdn, category, description: says[c.scenario], channel: rng.chance(0.7) ? "call" : "ussd", txn: c.paidTxn, role: c.holder && c.holder.telco !== v.telco ? "sender" : "both",
      status: !old ? "open" : authorised && !got ? (rng.chance(0.5) ? "rejected" : "resolved") : "resolved",
      resolution: !old ? null : got ? "Part of the money was still in the recipient's wallet and was returned." : authorised ? "The customer made the payment themselves. The recipient had already moved the money." : "The money had already been withdrawn. Nothing could be recovered.",
      updated: old ? when + rng.int(4, 70) * HOUR : when,
    });
  };

  /** The victim sends the money themselves. */
  const victimPays = (c: FraudCase, at: number, kind: "p2p" | "merchant", to: Wallet, reference: string, request = false) => {
    const v = (c.victim ??= victim(at, c.amount + ghs(10)));
    const fee = payFee(kind, v, to, c.amount);
    const amount = Math.max(100, Math.floor(Math.min(c.amount, v.bal - fee - 100, sendRoom(v, at), receiveRoom(to)) / 100) * 100);
    const id = pay(at, kind, v, to, amount, { reference, label: { fraud: true, scenario: c.scenario, role: "victim_payment", caseId: c.id, request } });
    if (!id) return;
    if (request) insApproval.run(`rtp_${rng.hex(20)}`, to.telco, to.id, v.msisdn, amount, "Payment for item", id, at - rng.int(30, 200) * 1000);
    c.paidTxn = id;
    c.holder = to;
    c.inFlight = amount;
    lock(c, to);
  };
  /** Someone else empties the victim's wallet. */
  const drain = (c: FraudCase, at: number, how: "p2p" | "cashout") => {
    const v = c.victim!;
    const want = Math.floor((v.bal * rng.int(70, 95)) / 100 / 100) * 100;
    if (how === "cashout") {
      const pool = agentsOf[v.telco];
      const a = pool.filter((x) => x.complicit).sort((x, y) => y.cash - x.cash)[0] ?? pool[0];
      const amount = Math.max(100, Math.floor(Math.min(want - payFee("cashout", v, a.wallet, want), sendRoom(v, at), a.cash) / 100) * 100);
      const id = pay(at, "cashout", v, a.wallet, amount, { label: { fraud: true, scenario: c.scenario, role: "unauthorised_cash_out", caseId: c.id } });
      if (id) c.paidTxn ??= id;
      watch(a);
      return;
    }
    const to = mule(at, (m) => receiveRoom(m) >= want && sendRoom(m, at) >= want);
    const amount = Math.max(100, Math.floor(Math.min(want - payFee("p2p", v, to, want), sendRoom(v, at), receiveRoom(to)) / 100) * 100);
    const id = pay(at, "p2p", v, to, amount, { label: { fraud: true, scenario: c.scenario, role: "unauthorised_transfer", caseId: c.id } });
    if (!id) return;
    c.paidTxn ??= id;
    c.holder = to;
    c.inFlight = amount;
    lock(c, to);
  };
  /** The proceeds move on to another wallet, on another network where possible. */
  const hop = (c: FraudCase, at: number) => {
    const from = c.holder ?? crook(at);
    const want = Math.floor((c.inFlight * rng.int(86, 97)) / 100 / 100) * 100;
    const to = mule(at, (m) => m !== from && receiveRoom(m) >= want && sendRoom(m, at) >= want && m.telco !== from.telco);
    const amount = Math.max(100, Math.floor(Math.min(want, from.bal - payFee("p2p", from, to, want) - 50, sendRoom(from, at), receiveRoom(to)) / 100) * 100);
    const id = pay(at, "p2p", from, to, amount, { channel: from.type === "merchant" ? "api" : "ussd", label: { fraud: true, scenario: c.scenario, role: "moving_proceeds", caseId: c.id } });
    if (!id) return;
    c.holder = to;
    c.inFlight = amount;
    lock(c, to);
  };
  /** The proceeds leave the system: cash at an agent, or a bank account. */
  const cashOut = (c: FraudCase, at: number) => {
    const from = c.holder ?? crook(at);
    const label: Label = { fraud: true, scenario: c.scenario, role: "cashing_out", caseId: c.id };
    const want = Math.floor((c.inFlight * rng.int(90, 99)) / 100 / 100) * 100;
    if (from.type === "person" && from.account && rng.chance(0.3)) {
      const amount = Math.max(100, Math.floor(Math.min(want, from.bal - bankFeeTo(from, from.account, want) - 50, sendRoom(from, at)) / 100) * 100);
      toBank(at, from, from.account, amount, { label });
    } else if (from.type !== "person") {
      // A merchant or agent line cannot cash out at an agent: it sends to its owner's bank account or to a wallet.
      const acct = from.account ?? rng.pick(accounts.filter((a) => a.person));
      const amount = Math.max(100, Math.floor(Math.min(want, from.bal - bankFeeTo(from, acct, want) - 50) / 100) * 100);
      toBank(at, from, acct, amount, { label });
    } else {
      const pool = agentsOf[from.telco];
      const a = (rng.chance(0.35) ? pool.filter((x) => x.complicit && x.cash >= want)[0] : undefined) ?? agentNear(from, (x) => x.cash >= want) ?? pool.reduce((x, y) => (y.cash > x.cash ? y : x));
      const amount = Math.max(100, Math.floor(Math.min(want - payFee("cashout", from, a.wallet, want), from.bal - payFee("cashout", from, a.wallet, want) - 50, sendRoom(from, at), a.cash) / 100) * 100);
      pay(at, "cashout", from, a.wallet, amount, { label });
      watch(a);
    }
    release(c);
  };

  const GAP = () => rng.int(4, 70) * MINUTE;
  /** The steps that follow a successful theft: zero to two moves, then out. Trimmed to `room` transactions. */
  const tail = (c: FraudCase, steps: Step[], room: number, from: number, hops = rng.weighted([0, 1, 2], (h) => [0.3, 0.45, 0.25][h])) => {
    let dt = from;
    const n = Math.min(room, hops + 1);
    for (let i = 0; i < n; i++) {
      dt += GAP();
      const last = i === n - 1 && n === hops + 1;
      steps.push({ dt, run: last ? (at) => cashOut(c, at) : (at) => hop(c, at) });
    }
    steps.push({ dt: dt + 1, run: () => release(c), free: true });
    return dt;
  };
  const paid = (steps: Step[]) => steps.filter((s) => !s.free).length;
  const fakeName = () => `${rng.pick(["KWAKU", "ABENA", "YAW", "AKUA", "KOFI", "ESI"])} ${rng.pick(["ADDO", "OWUSU", "MENSAH", "BOATENG", "ASANTE"])}`;
  const who = () => rng.pick(["Ma", "Dad", "Auntie", "Bro", "Sis", "Uncle"]);

  /** Plans one case: its steps, each of which writes exactly one transaction, never more than `room` in all. */
  const PLAN: Record<Scenario, (c: FraudCase, room: number) => { steps: Step[]; hours: number[] }> = {
    reversal_scam(c, room) {
      c.amount = ghs(rng.pick([150, 200, 300, 450, 500, 650, 800]));
      const steps: Step[] = [{
        dt: 0,
        run(at) {
          const v = (c.victim = victim(at, c.amount + ghs(10)));
          const k = (c.crook = crook(at));
          const sms = (x: Wallet) => `Payment received for GHS ${cedis(c.amount)} from ${fakeName()} ${k.msisdn}. Current Balance: GHS ${cedis(x.bal + c.amount)}. Available Balance: GHS ${cedis(x.bal + c.amount)}. Reference: school fees. Transaction ID: ${rng.int(30000000000, 49999999999)}`;
          text(at - rng.int(8, 14) * MINUTE, k, v, sms(v));
          // The payment is made while the caller is still on the line.
          call(at - rng.int(2, 6) * MINUTE, k, v, rng.int(360, 600));
          strays(at, k, sms, true);
          victimPays(c, at, "p2p", k, rng.pick(["reversal", "refund", "wrong transfer", ""]));
          complain(c, at, true, 0.5);
        },
      }];
      tail(c, steps, room - 1, 0);
      return { steps, hours: LURE_HOURLY };
    },
    pin_phishing(c, room) {
      const steps: Step[] = [];
      const guess = room >= 3 && rng.chance(0.25);
      const begin = (at: number) => {
        const v = (c.victim = victim(at, ghs(180)));
        const k = (c.crook = crook(at));
        lock(c, v);
        call(at - rng.int(3, 7) * MINUTE, k, v, rng.int(420, 720));
      };
      if (guess) steps.push({ dt: 0, run(at) { begin(at); pay(at, "p2p", c.victim!, mule(at), ghs(rng.int(2, 9) * 100), { label: { fraud: true, scenario: "pin_phishing", role: "failed_attempt", caseId: c.id }, refuse: wrongPin(c.victim!.telco) }); } });
      steps.push({ dt: guess ? rng.int(1, 3) * MINUTE : 0, run(at) { if (!guess) begin(at); drain(c, at, "p2p"); complain(c, at, false, 0.7); } });
      tail(c, steps, room - paid(steps), steps[steps.length - 1].dt);
      return { steps, hours: LURE_HOURLY };
    },
    sim_swap(c, room) {
      // First, not a transaction: the number is moved to a new SIM at a careless registration point, and the PIN is reset.
      // The owner's phone goes dead, so they do nothing from then on.
      const steps: Step[] = [{
        dt: 0,
        free: true,
        run(at) {
          const v = (c.victim = victim(at, ghs(250)));
          lock(c, v);
          const point = points[v.telco][3].id;
          swaps.set(v.msisdn, at);
          simEvents.push([at, v.msisdn, "swapped", point, `New SIM card issued to ${nameOf(v.person)}; mobile money sending paused for ${holdHours(v.telco)}h`]);
          niaLog.push([at, v.telco, `SIM replacement at ${point}`, v.person.card, 1, "MATCH"]);
          simEvents.push([at + rng.int(10, 50) * MINUTE, v.msisdn, "pin_reset", point, "Owner verified with Ghana Card and fingerprint"]);
        },
      }];
      // An attempt made too soon is stopped by the pause that follows a SIM replacement.
      if (room >= 3 && rng.chance(0.5)) steps.push({ dt: rng.int(1, 5) * HOUR, run(at) { pay(at, "p2p", c.victim!, mule(at), Math.max(100, Math.floor((c.victim!.bal * 0.8) / 100) * 100), { label: { fraud: true, scenario: "sim_swap", role: "failed_attempt", caseId: c.id } }); } });
      const out = 24 * HOUR + rng.int(5, 90) * MINUTE;
      steps.push({ dt: out, run(at) { drain(c, at, rng.chance(0.3) ? "cashout" : "p2p"); complain(c, at, false, 0.75); } });
      tail(c, steps, room - paid(steps), out);
      return { steps, hours: HOURLY };
    },
    agent_fraud(c, room) {
      const steps: Step[] = [];
      if (rng.chance(0.5)) {
        // A fake call from "agent support" asks an agent to send float for reconciliation.
        c.amount = ghs(rng.pick([500, 800, 1000, 1500, 2000]));
        steps.push({
          dt: 0,
          run(at) {
            const k = (c.crook = crook(at));
            const a = rng.pick(agents.filter((x) => !x.complicit && x.wallet.bal > c.amount + ghs(500))) ?? agents[0];
            c.victim = a.wallet;
            call(at - rng.int(3, 6) * MINUTE, k, a.wallet, rng.int(420, 700));
            const amount = Math.max(100, Math.floor(Math.min(c.amount, a.wallet.bal - ghs(50), receiveRoom(k)) / 100) * 100);
            const id = pay(at, "p2p", a.wallet, k, amount, { channel: "ussd", reference: "float reconciliation", label: { fraud: true, scenario: "agent_fraud", role: "victim_payment", caseId: c.id } });
            if (id) {
              c.paidTxn = id;
              c.holder = k;
              c.inFlight = amount;
              lock(c, k);
              watch(a);
              complain(c, at, true, 0.6);
            }
          },
        });
        tail(c, steps, room - 1, 0);
        return { steps, hours: LURE_HOURLY };
      }
      // A stolen wallet is cashed out late at night at an agent who asks no questions.
      const n = Math.min(room, rng.int(1, 3));
      for (let i = 0; i < n; i++) steps.push({ dt: i * rng.int(3, 15) * MINUTE, run(at) { if (i === 0) lock(c, (c.victim = victim(at, ghs(300)))); drain(c, at, "cashout"); if (i === n - 1) { complain(c, at, false, 0.7, true); release(c); } } });
      return { steps, hours: NIGHT_HOURLY };
    },
    mule_chain(c, room) {
      // Money taken from someone's bank account lands in a wallet and is passed along.
      const steps: Step[] = [{
        dt: 0,
        run(at) {
          const k = (c.crook = crook(at));
          const want = ghs(rng.pick([800, 1200, 1800, 2500]));
          const src = (() => {
            for (let i = 0; i < 60; i++) {
              const a = rng.pick(customers).account;
              if (a && a.bal > want + ghs(100)) return a;
            }
            return accounts.filter((a) => a.person).reduce((x, y) => (y.bal > x.bal ? y : x));
          })();
          const amount = Math.max(100, Math.floor(Math.min(want, src.bal - ghs(20), receiveRoom(k)) / 100) * 100);
          const id = fromBank(at, src.bank, src, k, amount, { label: { fraud: true, scenario: "mule_chain", role: "account_takeover", caseId: c.id } });
          if (id) {
            c.holder = k;
            c.inFlight = amount;
            lock(c, k);
          }
        },
      }];
      tail(c, steps, room - 1, 0, rng.int(2, 4));
      return { steps, hours: HOURLY };
    },
    fake_promo(c, room) {
      c.amount = ghs(rng.pick([50, 80, 100, 150]));
      const steps: Step[] = [{
        dt: 0,
        run(at) {
          const v = (c.victim = victim(at, c.amount + ghs(5)));
          const k = (c.crook = crook(at));
          const prize = rng.pick([2000, 5000, 10000]);
          const sms = (x: Wallet) => `CONGRATULATIONS! Your number has won GHS ${prize} in the ${TELCO_INFO[x.telco].wallet} Yɛnkɔ Promo. To claim, send processing fee of GHS ${cedis(c.amount)} to our agent ${k.msisdn}. Offer ends today.`;
          text(at - rng.int(10, 180) * MINUTE, k, v, sms(v));
          strays(at, k, sms);
          victimPays(c, at, "p2p", k, rng.pick(["promo fee", "processing fee", "claim", ""]));
          complain(c, at, true, 0.35);
        },
      }];
      tail(c, steps, Math.min(room - 1, rng.chance(0.5) ? 1 : 0), 0, 0);
      return { steps, hours: LURE_HOURLY };
    },
    rtp_abuse(c, room) {
      c.amount = ghs(rng.pick([120, 250, 300, 400, 600]));
      const steps: Step[] = [{
        dt: 0,
        run(at) {
          const v = (c.victim = victim(at, c.amount + ghs(10)));
          const shop = openBy(fakeShops, at);
          const k = (c.crook = crook(at));
          const sms = () => `Hello, I am sending you GHS ${cedis(c.amount)} for the item you posted. You will get a prompt; approve it to receive the money.`;
          text(at - rng.int(2, 9) * MINUTE, k, v, sms());
          strays(at, k, sms);
          victimPays(c, at, "merchant", shop, "Payment for item", true);
          complain(c, at, true, 0.55);
        },
      }];
      tail(c, steps, room - 1, 0, rng.int(0, 1));
      return { steps, hours: LURE_HOURLY };
    },
    fake_merchant(c, room) {
      c.amount = Math.max(ghs(40), Math.min(ghs(900), round(ghs(rng.logn(160, 0.6)), 10)));
      const steps: Step[] = [{ dt: 0, run(at) { c.victim = victim(at, c.amount + ghs(10)); victimPays(c, at, "merchant", openBy(fakeShops, at), rng.pick(["order", "goods", "delivery", "phone", ""])); complain(c, at, true, 0.4); } }];
      tail(c, steps, Math.min(room - 1, rng.chance(0.6) ? 2 : 0), rng.int(1, 20) * HOUR, rng.int(0, 1));
      return { steps, hours: HOURLY };
    },
    relative_impersonation(c, room) {
      c.amount = ghs(rng.pick([200, 300, 350, 500, 700]));
      const steps: Step[] = [{
        dt: 0,
        run(at) {
          const v = (c.victim = victim(at, c.amount + ghs(10)));
          const k = (c.crook = crook(at));
          const sms = () => `${who()} it's me, my phone fell in water so I'm using my friend's number. I'm at the hospital and they want GHS ${cedis(c.amount)} before they treat me. Pls send to this number now, I will explain.`;
          text(at - rng.int(4, 40) * MINUTE, k, v, sms());
          strays(at, k, sms);
          victimPays(c, at, "p2p", k, rng.pick(["hospital", "hospital bill", "urgent", ""]));
          complain(c, at, true, 0.45);
        },
      }];
      tail(c, steps, room - 1, 0);
      return { steps, hours: LURE_HOURLY };
    },
    limit_splitting(c, room) {
      // A large sum lands in one wallet and is split into amounts under the daily limit of the wallets it goes to.
      const steps: Step[] = [];
      const parts: { to?: Wallet; amount: number }[] = [];
      steps.push({
        dt: 0,
        run(at) {
          const hub = (c.holder = mule(at, (m) => m.tier === "medium" && m.bal < ghs(5000)));
          lock(c, hub);
          const want = ghs(rng.pick([6000, 8000, 12000]));
          const src = accounts.filter((a) => a.person && a.bal > want + ghs(100));
          const from = src.length ? rng.pick(src) : accounts.filter((a) => a.person).reduce((x, y) => (y.bal > x.bal ? y : x));
          const amount = Math.max(100, Math.floor(Math.min(want, from.bal - ghs(20), receiveRoom(hub)) / 100) * 100);
          if (fromBank(at, from.bank, from, hub, amount, { label: { fraud: true, scenario: "limit_splitting", role: "account_takeover", caseId: c.id } })) c.inFlight = amount;
        },
      });
      let left = room - 1;
      let dt = 0;
      if (left >= 4 && rng.chance(0.35)) {
        // First it tries to push too much to one small wallet, and is refused.
        dt += rng.int(2, 10) * MINUTE;
        steps.push({ dt, run(at) { const to = mule(at, (m) => m.tier === "minimum"); pay(at, "p2p", c.holder!, to, Math.max(ghs(5200), Math.floor(c.inFlight * 0.9)), { label: { fraud: true, scenario: "limit_splitting", role: "failed_attempt", caseId: c.id } }); } });
        left--;
      }
      const n = Math.min(rng.int(4, 8), Math.max(1, Math.ceil(left / 2)));
      const outs = Math.min(n, left - n);
      for (let i = 0; i < Math.min(n, left); i++) {
        dt += rng.int(1, 12) * MINUTE;
        const part: (typeof parts)[number] = { amount: 0 };
        parts.push(part);
        steps.push({
          dt,
          run(at) {
            const hub = c.holder!;
            const to = mule(at, (m) => m.tier === "minimum" && m !== hub && receiveRoom(m) >= ghs(2900) && sendRoom(m, at) >= ghs(2900));
            const amount = Math.max(100, Math.floor(Math.min(ghs(rng.int(900, 2900)), hub.bal - ghs(30), sendRoom(hub, at), receiveRoom(to)) / 100) * 100);
            if (pay(at, "p2p", hub, to, amount, { label: { fraud: true, scenario: "limit_splitting", role: "splitting", caseId: c.id } })) {
              part.to = to;
              part.amount = amount;
              lock(c, to);
            }
          },
        });
      }
      for (let i = 0; i < outs; i++) {
        const out = dt + rng.int(10, 180) * MINUTE + i;
        steps.push({ dt: out, run(at) { const p = parts[i]; [c.holder, c.inFlight] = [p.to ?? c.holder, p.amount]; const keep = c.locked; c.locked = []; cashOut(c, at); c.locked = keep; } });
      }
      steps.push({ dt: dt + 181 * MINUTE + outs, run: () => release(c), free: true });
      return { steps, hours: HOURLY };
    },
  };

  // ---------- the timeline ----------
  const fraudTotal = Math.round(total * o.fraudShare);
  const dayWeight = Array.from({ length: o.days }, (_, i) => {
    const d = new Date(start + i * DAY);
    return (d.getUTCDay() === 0 ? 0.7 : d.getUTCDay() === 6 ? 1.1 : 1) * (d.getUTCDate() >= 25 || d.getUTCDate() <= 2 ? 1.3 : 1);
  });
  const days = dayWeight.map((_, i) => i);
  const moment = (hours: number[], latest = end - 1): number => {
    for (;;) {
      const day = rng.weighted(days, (i) => dayWeight[i]);
      const hour = rng.weighted(HOURLY.map((_, h) => h), (h) => hours[h]);
      const t = start + day * DAY + hour * HOUR + Math.floor(rng.next() * HOUR);
      if (t > start + 30 * MINUTE && t <= latest) return t;
    }
  };

  const events: { at: number; n: number; run: (at: number) => void }[] = [];
  let order = 0;
  const targets = Object.keys(SCENARIOS).map((s) => [s as Scenario, Math.round(fraudTotal * SCENARIO_SHARE[s as Scenario])] as [Scenario, number]);
  targets[0][1] += fraudTotal - targets.reduce((s, [, n]) => s + n, 0);
  let caseNo = 0;
  for (const [scenario, target] of targets) {
    let left = target;
    while (left > 0) {
      const c: FraudCase = { id: `case_${String(++caseNo).padStart(5, "0")}`, scenario, inFlight: 0, locked: [], amount: 0 };
      const plan = PLAN[scenario](c, left);
      const span = plan.steps[plan.steps.length - 1].dt;
      const at = moment(plan.hours, end - span - MINUTE);
      for (const s of plan.steps) events.push({ at: Math.min(at + s.dt, end - 1), n: order++, run: s.run });
      left -= paid(plan.steps);
      perScenario[scenario].cases++;
    }
  }
  for (let i = total - fraudTotal; i > 0; i--) events.push({ at: moment(HOURLY), n: order++, run: everyday });
  // The national switch settles at the end of each day.
  for (let d = 1; d <= o.days; d++) events.push({ at: start + d * DAY - 1000, n: order++, run: () => undefined });
  events.sort((a, b) => a.at - b.at || a.n - b.n);

  const frozen = w.clock;
  try {
    tx(db, () => {
      let nextSettle = start + DAY - 1000;
      for (const e of events) {
        if (e.at >= nextSettle) {
          w.clock = nextSettle;
          try {
            settle(w);
          } catch (err) {
            if (!(err instanceof SimError)) throw err;
          }
          nextSettle += DAY;
        }
        e.run(e.at);
      }
      w.clock = end - 500;
      try {
        settle(w);
      } catch (err) {
        if (!(err instanceof SimError)) throw err;
      }

      // ---------- what is not a transaction ----------
      // Ordinary calls and texts between people who know each other, and texts from shops.
      for (let i = sized(42000, 800); i > 0; i--) {
        const a = anyCustomer();
        const b = a.contacts.length ? rng.pick(a.contacts) : rng.pick(customers);
        const at = moment(HOURLY);
        if (a === b || a.opened > at || b.opened > at) continue;
        const r = rng.next();
        call(at, a, b, Math.round(rng.logn(70, 0.9)), r < 0.78 ? "ended" : r < 0.93 ? "missed" : "declined");
      }
      for (let i = sized(26000, 500); i > 0; i--) {
        const a = anyCustomer();
        const b = a.contacts.length ? rng.pick(a.contacts) : rng.pick(customers);
        const at = moment(HOURLY);
        if (a !== b && a.opened <= at && b.opened <= at) text(at, a, b, rng.pick(LEGIT_TEXTS));
      }
      for (let i = sized(3000, 60); i > 0; i--) {
        const shop = rng.pick(merchants);
        const to = rng.pick(customers);
        const at = moment(HOURLY);
        if (to.opened <= at) texts.push({ at, kind: "app", sender: shop.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 11) || "INFO", fromTelco: shop.telco, to, body: rng.pick(BUSINESS_TEXTS) });
      }
      // Ordinary complaints.
      for (let i = sized(450, 10); i > 0; i--) {
        const v = rng.pick(customers);
        const at = moment(HOURLY);
        if (v.opened > at) continue;
        const category = rng.pick(["sim_network", "sim_network", "wallet_access", "wallet_access", "agent_complaint", "other"]);
        const old = end - at > 3 * DAY;
        tickets.push({
          at, telco: v.telco, msisdn: v.msisdn, category, channel: rng.chance(0.8) ? "call" : "back_office", txn: null, role: null, status: old ? "resolved" : "open", updated: old ? at + rng.int(1, 30) * HOUR : at,
          description: { sim_network: "No network on the line since morning.", wallet_access: "I have forgotten my PIN and the wallet is locked.", agent_complaint: "The agent charged me extra to withdraw.", other: "I want to know my transaction limits." }[category]!,
          resolution: old ? "Handled and the customer was informed." : null,
        });
      }

      const insEvent = db.prepare("INSERT INTO sim_events(msisdn, at, kind, by, detail) VALUES(?,?,?,?,?)");
      for (const e of simEvents.sort((a, b) => a[0] - b[0])) insEvent.run(e[1], e[0], e[2], e[3], e[4]);
      const insNia = db.prepare("INSERT INTO nia_log(at, requester, purpose, ghana_card, biometric, result) VALUES(?,?,?,?,?,?)");
      for (const n of niaLog.sort((a, b) => a[0] - b[0])) insNia.run(...n);
      const setSwap = db.prepare("UPDATE sims SET last_swap_at = ?, iccid = ? WHERE msisdn = ?");
      for (const [msisdn, at] of swaps) setSwap.run(at, `8923301${rng.digits(12)}`, msisdn);
      const insInbox = db.prepare("INSERT INTO sms(msisdn, sender, body, at) VALUES(?,?,?,?)");
      const insText = db.prepare("INSERT INTO sms_log(at, kind, sender, from_telco, to_msisdn, to_telco, body, parts, status) VALUES(?,?,?,?,?,?,?,?, 'delivered')");
      for (const t of texts.sort((a, b) => a.at - b.at)) {
        insInbox.run(t.to.msisdn, t.sender, t.body, t.at);
        insText.run(t.at, t.kind, t.sender, t.fromTelco, t.to.msisdn, t.to.telco, t.body, Math.max(1, Math.ceil(t.body.length / 160)));
      }
      const insCall = db.prepare("INSERT INTO calls(id, from_msisdn, to_msisdn, from_telco, to_telco, status, reason, started_at, answered_at, ended_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
      for (const c of calls.sort((a, b) => a.at - b.at)) insCall.run(`call_${rng.hex(16)}`, c.from, c.to, c.fromTelco, c.toTelco, c.status, c.reason, c.at, c.answered, c.ended);
      const insTicket = db.prepare("INSERT INTO tickets(id, telco, msisdn, category, description, channel, status, txn_id, role, resolution, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
      const insNote = db.prepare("INSERT INTO ticket_events(ticket_id, at, by, note) VALUES(?,?,?,?)");
      const ticketNo: Record<string, number> = {};
      for (const t of tickets.sort((a, b) => a.at - b.at)) {
        const id = `${TELCO_INFO[t.telco].name.toUpperCase()}-${String((ticketNo[t.telco] = (ticketNo[t.telco] ?? 0) + 1)).padStart(6, "0")}`;
        insTicket.run(id, t.telco, t.msisdn, t.category, t.description, t.channel, t.status, t.txn, t.txn ? t.role : null, t.resolution, t.at, t.updated);
        insNote.run(id, t.at, t.channel === "ussd" ? "the customer, from their phone" : "customer care", `Ticket opened: ${t.description}`);
        if (t.resolution) insNote.run(id, t.updated, "customer care", t.resolution);
      }

      // Balances, tills and commission as they stand at the end.
      const setWallet = db.prepare("UPDATE wallets SET balance = ? WHERE id = ?");
      for (const v of wallets) setWallet.run(v.bal, v.id);
      const setAccount = db.prepare("UPDATE bank_accounts SET balance = ? WHERE id = ?");
      for (const a of accounts) setAccount.run(a.bal, a.id);
      const setAgent = db.prepare("UPDATE momo_agents SET cash = ?, commission = ? WHERE wallet_id = ?");
      for (const a of agents) setAgent.run(a.cash, a.commission, a.wallet.id);
      db.prepare("INSERT INTO audit(at, system, action, summary) VALUES(?, 'hub', 'simulated', ?)").run(end, `Simulated history loaded: ${seq.toLocaleString("en")} transactions from ${clock(start).slice(0, 5)} to ${clock(end - 1).slice(0, 5)}`);
    });
  } finally {
    w.clock = frozen;
  }

  const fraud = count(db, "SELECT COUNT(*) AS n FROM dataset WHERE is_fraud = 1");
  const summary: SimSummary = {
    seed: o.seed, transactions: seq, fraud, legitimate: seq - fraud, failed, cases: caseNo, byScenario: perScenario, from: iso(start), to: iso(end),
    people: people.length, sims: usedNumbers.size - 120, wallets: wallets.length, agents: agents.length, merchants: merchants.length + fakeShops.length, bankAccounts: accounts.length,
    texts: texts.length, calls: calls.length, complaints: tickets.length,
  };
  setMeta(db, "simulated", JSON.stringify(summary));
  return summary;
}

/** Bank names are needed by exports; re-exported here so they need only this module. */
export { bankName };
