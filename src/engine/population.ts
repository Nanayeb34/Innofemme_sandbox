import type { DB } from "./db";
import { setMeta, tx } from "./db";
import { seedConfig } from "./config/store";
import { DAY, Rng, TELCO_INFO, ghs, telcoOf, type Telco } from "./util";

const FIRST_F = ["Akosua", "Ama", "Adwoa", "Abena", "Akua", "Yaa", "Afua", "Efua", "Esi", "Adjoa", "Gifty", "Comfort", "Patience", "Felicia", "Joyce", "Mercy", "Grace", "Linda", "Esther", "Naa", "Dzifa", "Enyonam", "Yayra", "Amina", "Mariama", "Zainab", "Rukaya", "Priscilla", "Vida", "Mavis"];
const FIRST_M = ["Kwame", "Kwaku", "Kofi", "Kwabena", "Kwasi", "Yaw", "Kojo", "Emmanuel", "Prince", "Evans", "Michael", "Daniel", "Isaac", "Samuel", "Richard", "Nii", "Selorm", "Elikem", "Edem", "Mawuli", "Senyo", "Abdul", "Fuseini", "Ibrahim", "Alhassan", "Rashid", "Sumaila", "Ebenezer", "Kelvin", "Bright"];
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

const BANKS = ["GCB Bank", "Ecobank Ghana", "Fidelity Bank", "CalBank", "Absa Ghana", "Stanbic Bank"];
const MERCHANT_KINDS: [string, string[]][] = [
  ["Provisions", ["Provisions Shop", "Mini Mart", "Enterprise"]],
  ["Food", ["Chop Bar", "Waakye Joint", "Kenkey Spot", "Fast Food"]],
  ["Pharmacy", ["Pharmacy", "Chemical Shop"]],
  ["Transport", ["Station Ticketing", "Ride Services"]],
  ["Fashion", ["Fashion Home", "Boutique"]],
  ["Electronics", ["Phones & Accessories", "Electricals"]],
  ["Utilities", ["Prepaid Vendor"]],
];

export const PERSONA_PIN = "1234";
export const SIM_START = Date.UTC(2026, 10, 26, 6, 0, 0); // 26 Nov 2026 06:00 GMT (Ghana time)

export interface Persona {
  key: string;
  name: string;
  msisdn: string;
  telco: Telco;
  role: string;
  blurb: string;
}

export const PERSONAS: Omit<Persona, "msisdn">[] = [
  { key: "akosua", name: "Akosua Mensah", telco: "mtn", role: "customer", blurb: "Trader at Kejetia, Kumasi. Medium KYC MTN MoMo wallet." },
  { key: "kwame", name: "Kwame Boateng", telco: "telecel", role: "customer", blurb: "Teacher in Madina, Accra. Paid on the 25th." },
  { key: "fuseini", name: "Fuseini Abdul", telco: "at", role: "customer", blurb: "Student in Tamale. Minimum KYC AT Money wallet." },
  { key: "ama_shop", name: "Ama's Provisions", telco: "mtn", role: "merchant", blurb: "Provisions shop in Ayeduase taking MoMoPay." },
  { key: "yaw_agent", name: "Yaw Mobile Money Centre", telco: "mtn", role: "agent", blurb: "MoMo agent in Suame with cash and e-float." },
];

function pickWeighted<T extends { weight: number }>(rng: Rng, items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rng.next() * total;
  for (const i of items) if ((r -= i.weight) < 0) return i;
  return items[items.length - 1];
}

function pickTelco(rng: Rng): Telco {
  const r = rng.next();
  return r < 0.68 ? "mtn" : r < 0.88 ? "telecel" : "at";
}

export interface PopulationSize {
  customers: number;
  agents: number;
  merchants: number;
  fraudsters: number;
  mules: number;
}

export const DEFAULT_SIZE: PopulationSize = { customers: 1200, agents: 60, merchants: 80, fraudsters: 15, mules: 45 };

/** Builds a complete synthetic world into an empty database. Deterministic for a given seed. */
export function generateWorld(db: DB, seed = 2026, size: PopulationSize = DEFAULT_SIZE) {
  const rng = new Rng(seed);
  const usedNumbers = new Set<string>();
  const usedCards = new Set<string>();

  // Numbers use real network prefixes followed by a reserved "99" block.
  const newMsisdn = (telco: Telco) => {
    for (;;) {
      const n = rng.pick(TELCO_INFO[telco].prefixes) + "99" + String(rng.int(0, 99999)).padStart(5, "0");
      if (!usedNumbers.has(n)) {
        usedNumbers.add(n);
        return n;
      }
    }
  };
  const newCard = () => {
    for (;;) {
      const c = `GHA-${rng.int(700000000, 799999999)}-${rng.int(0, 9)}`;
      if (!usedCards.has(c)) {
        usedCards.add(c);
        return c;
      }
    }
  };

  const insPerson = db.prepare("INSERT INTO persons(id, name, ghana_card, region, town, gender, age, role, susceptibility, persona) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const insSim = db.prepare("INSERT INTO sims(msisdn, person_id, telco, registered_at) VALUES(?,?,?,?)");
  const insWallet = db.prepare("INSERT INTO wallets(id, msisdn, telco, person_id, owner_type, display_name, kyc_tier, pin, balance, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const insAgent = db.prepare("INSERT INTO agents(wallet_id, code, name, town, cash, colluding) VALUES(?,?,?,?,?,?)");
  const insMerchant = db.prepare("INSERT INTO merchants(wallet_id, till, name, category, town, fake) VALUES(?,?,?,?,?,?)");
  const insBank = db.prepare("INSERT INTO bank_accounts(id, bank, account_no, person_id, name, balance) VALUES(?,?,?,?,?,?)");
  const insContact = db.prepare("INSERT OR IGNORE INTO contacts(msisdn, contact) VALUES(?,?)");

  let pid = 0;
  const persons: { id: string; name: string; region: string; town: string; msisdns: string[]; role: string }[] = [];

  const makePerson = (role: string, opts: { name?: string; town?: string; region?: string; persona?: string; susceptibility?: number } = {}) => {
    const female = rng.chance(0.5);
    const name = opts.name ?? `${rng.pick(female ? FIRST_F : FIRST_M)} ${rng.pick(SURNAMES)}`;
    const place = pickWeighted(rng, PLACES);
    const region = opts.region ?? place.region;
    const town = opts.town ?? rng.pick(place.towns);
    const id = `p${String(++pid).padStart(5, "0")}`;
    const age = rng.int(18, 70);
    // Older and younger users are modelled as somewhat more susceptible.
    const susceptibility = opts.susceptibility ?? Math.min(0.95, Math.max(0.05, 0.3 + (age > 55 ? 0.2 : 0) + (age < 24 ? 0.1 : 0) + rng.normal() * 0.15));
    insPerson.run(id, name, newCard(), region, town, female ? "F" : "M", age, role, susceptibility, opts.persona ?? null);
    const p = { id, name, region, town, msisdns: [] as string[], role };
    persons.push(p);
    return p;
  };

  const tierBalanceCap = { minimum: 5000, medium: 40000, enhanced: 75000 };
  const makeWallet = (
    p: { id: string; name: string; msisdns: string[] },
    telco: Telco,
    o: { ownerType?: string; display?: string; tier?: "minimum" | "medium" | "enhanced"; balance?: number; ageDays?: number; pin?: string; msisdn?: string } = {},
  ) => {
    const msisdn = o.msisdn ?? newMsisdn(telco);
    const ageDays = o.ageDays ?? rng.int(120, 3000);
    insSim.run(msisdn, p.id, telco, SIM_START - ageDays * DAY);
    const r = rng.next();
    const tier = o.tier ?? (r < 0.35 ? "minimum" : r < 0.9 ? "medium" : "enhanced");
    const balance = o.balance ?? Math.min(tierBalanceCap[tier] * 0.6, rng.amount(250, 1.1));
    const id = `w_${msisdn}`;
    insWallet.run(id, msisdn, telco, p.id, o.ownerType ?? "person", o.display ?? p.name, tier, o.pin ?? String(rng.int(1000, 9999)), ghs(balance), SIM_START - ageDays * DAY);
    p.msisdns.push(msisdn);
    return { id, msisdn };
  };

  tx(db, () => {
    // Featured personas first, so they get stable, memorable numbers.
    const personaNumbers: Record<string, string> = {};
    const akosua = makePerson("customer", { name: "Akosua Mensah", region: "Ashanti", town: "Kumasi", persona: "akosua", susceptibility: 0.5 });
    personaNumbers.akosua = makeWallet(akosua, "mtn", { tier: "medium", balance: 1850, pin: PERSONA_PIN, msisdn: "0249900001" }).msisdn;
    const kwame = makePerson("customer", { name: "Kwame Boateng", region: "Greater Accra", town: "Madina", persona: "kwame", susceptibility: 0.4 });
    personaNumbers.kwame = makeWallet(kwame, "telecel", { tier: "medium", balance: 920, pin: PERSONA_PIN, msisdn: "0209900002" }).msisdn;
    const fuseini = makePerson("customer", { name: "Fuseini Abdul", region: "Northern", town: "Tamale", persona: "fuseini", susceptibility: 0.6 });
    personaNumbers.fuseini = makeWallet(fuseini, "at", { tier: "minimum", balance: 240, pin: PERSONA_PIN, msisdn: "0269900003" }).msisdn;
    const ama = makePerson("merchant", { name: "Ama Owusu", region: "Ashanti", town: "Ayeduase", persona: "ama_shop" });
    const amaW = makeWallet(ama, "mtn", { ownerType: "merchant", display: "Ama's Provisions", tier: "enhanced", balance: 3400, pin: PERSONA_PIN, msisdn: "0549900004" });
    insMerchant.run(amaW.id, "100001", "Ama's Provisions", "Provisions", "Ayeduase", 0);
    personaNumbers.ama_shop = amaW.msisdn;
    const yaw = makePerson("agent", { name: "Yaw Asante", region: "Ashanti", town: "Suame", persona: "yaw_agent" });
    const yawW = makeWallet(yaw, "mtn", { ownerType: "agent", display: "Yaw Mobile Money Centre", tier: "enhanced", balance: 12000, pin: PERSONA_PIN, msisdn: "0559900005" });
    insAgent.run(yawW.id, "200001", "Yaw Mobile Money Centre", "Suame", ghs(9000), 0);
    personaNumbers.yaw_agent = yawW.msisdn;
    setMeta(db, "personas", JSON.stringify(personaNumbers));

    // The team's own merchant account on each network, used by the telco-style APIs.
    const shopNumbers = { mtn: "0249900010", telecel: "0209900010", at: "0269900010" } as const;
    (Object.keys(shopNumbers) as Telco[]).forEach((t, i) => {
      const owner = makePerson("merchant", { name: "Hackathon Team", region: "Ashanti", town: "Kumasi" });
      const w = makeWallet(owner, t, { ownerType: "merchant", display: `Team Shop (${TELCO_INFO[t].name})`, tier: "enhanced", balance: 5000, pin: PERSONA_PIN, msisdn: shopNumbers[t], ageDays: 30 });
      insMerchant.run(w.id, String(300001 + i), `Team Shop (${TELCO_INFO[t].name})`, "Online", "Kumasi", 0);
    });

    const customers = [akosua, kwame, fuseini];
    for (let i = 0; i < size.customers; i++) {
      const p = makePerson("customer");
      makeWallet(p, pickTelco(rng));
      if (rng.chance(0.12)) {
        const second = (["mtn", "telecel", "at"] as Telco[]).find((t) => !p.msisdns.some((m) => telcoOf(m) === t))!;
        makeWallet(p, second);
      }
      customers.push(p);
    }

    for (let i = 0; i < size.agents; i++) {
      const p = makePerson("agent");
      const telco = pickTelco(rng);
      const name = `${p.name.split(" ")[0]} ${rng.pick(["Mobile Money Centre", "MoMo Point", "Ventures", "Enterprise"])}`;
      const w = makeWallet(p, telco, { ownerType: "agent", display: name, tier: "enhanced", balance: rng.amount(6000, 0.5) });
      insAgent.run(w.id, String(200002 + i), name, p.town, ghs(rng.amount(5000, 0.5)), rng.chance(0.08) ? 1 : 0);
    }

    for (let i = 0; i < size.merchants; i++) {
      const p = makePerson("merchant");
      const [category, suffixes] = rng.pick(MERCHANT_KINDS);
      const name = `${p.name.split(" ")[1]} ${rng.pick(suffixes)}`;
      const w = makeWallet(p, pickTelco(rng), { ownerType: "merchant", display: name, tier: "enhanced", balance: rng.amount(1500, 0.8) });
      insMerchant.run(w.id, String(100002 + i), name, category, p.town, 0);
    }

    // Fraudsters hold several SIMs; one fake merchant till each for QR scams.
    for (let i = 0; i < size.fraudsters; i++) {
      const p = makePerson("fraudster", { susceptibility: 0 });
      const n = rng.int(1, 3);
      for (let k = 0; k < n; k++) makeWallet(p, pickTelco(rng), { tier: "minimum", balance: rng.amount(80, 0.6), ageDays: rng.int(3, 90) });
      const fake = makeWallet(p, "mtn", { ownerType: "merchant", display: `${rng.pick(SURNAMES)} ${rng.pick(["Enterprise", "Ventures", "Mini Mart"])}`, tier: "minimum", balance: 20, ageDays: rng.int(2, 30) });
      insMerchant.run(fake.id, String(190001 + i), `${p.name.split(" ")[1]} Ventures`, "Provisions", p.town, 1);
    }

    // Mules: real-looking people, often young, with new low-tier wallets.
    for (let i = 0; i < size.mules; i++) {
      const p = makePerson("mule", { susceptibility: 0.2 });
      makeWallet(p, pickTelco(rng), { tier: rng.chance(0.8) ? "minimum" : "medium", balance: rng.amount(40, 0.8), ageDays: rng.int(1, 60) });
    }

    // Bank accounts for ~30% of customers, plus the organisation payroll accounts.
    let acct = 0;
    for (const p of customers) {
      if (!rng.chance(0.3) && p.msisdns[0] !== personaNumbers.kwame) continue;
      insBank.run(`b${++acct}`, rng.pick(BANKS), String(1000000000000 + rng.int(0, 899999999)) + String(acct), p.id, p.name, ghs(rng.amount(2500, 1)));
    }
    for (const role of ["fraudster", "mule"]) {
      for (const p of persons.filter((x) => x.role === role).slice(0, 8)) {
        insBank.run(`b${++acct}`, rng.pick(BANKS), String(1000000000000 + rng.int(0, 899999999)) + String(acct), p.id, p.name, ghs(rng.amount(300, 1)));
      }
    }

    // Social graph: each customer knows a handful of people, mostly nearby.
    const byRegion = new Map<string, typeof customers>();
    for (const c of customers) byRegion.set(c.region, [...(byRegion.get(c.region) ?? []), c]);
    for (const c of customers) {
      const local = byRegion.get(c.region)!;
      const n = rng.int(4, 10);
      for (let k = 0; k < n; k++) {
        const other = rng.chance(0.75) ? rng.pick(local) : rng.pick(customers);
        if (other === c) continue;
        insContact.run(c.msisdns[0], other.msisdns[0]);
        insContact.run(other.msisdns[0], c.msisdns[0]);
      }
    }

    seedConfig(db);
    setMeta(db, "seed", seed);
    setMeta(db, "sim_now", SIM_START);
    setMeta(db, "speed", 60); // simulated seconds per real second
    setMeta(db, "running", 1);
  });
}
