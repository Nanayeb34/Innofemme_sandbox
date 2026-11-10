import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SANDBOX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "momo-sandbox-test-"));
process.env.SANDBOX_TEAMS = "3";

const { resetWorld } = await import("../src/engine/worlds");
const { fastForward } = await import("../src/engine/sim");
const { metrics } = await import("../src/engine/scoring");
const { getConfig, setConfig, undoChange, applyPatch, validateSurface } = await import("../src/engine/config/store");
const { ussd } = await import("../src/engine/ussd");
const { withLock } = await import("../src/engine/world");

const ff = (id: string, hours: number) => resetWorld(id).then((w) => (hours ? withLock(w, () => fastForward(w, hours)).then(() => w) : w));

describe("engine", () => {
  let baseline: ReturnType<typeof metrics>;

  beforeAll(async () => {
    const w = await ff("team-01", 0);
    await withLock(w, () => fastForward(w, 48));
    baseline = metrics(w);
  });

  it("produces genuine traffic and labelled fraud with a balanced ledger", async () => {
    expect(baseline.legitTxns).toBeGreaterThan(3000);
    expect(baseline.fraudAttempts).toBeGreaterThan(30);
    const w = await ff("team-01", 0);
    await withLock(w, () => fastForward(w, 6));
    expect(w.db.prepare("SELECT COUNT(*) n FROM (SELECT txn_id, SUM(amount) s FROM postings GROUP BY txn_id HAVING s != 0)").get()).toMatchObject({ n: 0 });
    const neg = w.db.prepare("SELECT COUNT(*) n FROM wallets WHERE balance < 0").get() as { n: number };
    expect(neg.n).toBe(0);
  });

  it("a hold-and-warn rule for new recipients cuts fraud losses", async () => {
    const w = await ff("team-02", 0);
    const fc = getConfig(w.db, "fraudChecks");
    setConfig(
      w.db,
      "fraudChecks",
      {
        ...fc,
        checks: [
          ...fc.checks,
          { id: "new_recipient_hold", name: "Hold large payments to new recipients", enabled: true, appliesTo: ["p2p"], when: { all: [{ fact: "recipient_is_new", op: "==", value: true }, { fact: "amount", op: ">=", value: 100 }] }, action: "hold", holdMinutes: 60 },
          { id: "new_recipient_warn", name: "Warn on new recipients", enabled: true, appliesTo: ["p2p", "rtp"], when: { fact: "recipient_is_new", op: "==", value: true }, action: "warn" },
        ],
      },
      "test rule",
      "test",
    );
    await withLock(w, () => fastForward(w, 48));
    const m = metrics(w);
    expect(m.fraudPrevented).toBeGreaterThan(0);
    expect(m.lossPreventionRate).toBeGreaterThan(baseline.lossPreventionRate);
    expect(m.legitHeld + m.legitWarned).toBeGreaterThan(0); // friction is visible
  });

  it("menu warning screens are shown to humans and change bot behaviour", async () => {
    const w = await ff("team-03", 0);
    const menus = getConfig(w.db, "menus");
    const patched = applyPatch(menus, [
      { op: "add", path: "/mtn/nodes/onnet_check", value: { type: "branch", if: { fact: "recipient_is_new", op: "==", value: true }, then: "onnet_warn", else: "onnet_pin" } },
      { op: "add", path: "/mtn/nodes/onnet_warn", value: { type: "warning", text: "You have never paid this number. Scammers ask for refunds of money 'sent by mistake'.", next: "onnet_pin" } },
      { op: "replace", path: "/mtn/nodes/onnet_ref/next", value: "onnet_check" },
    ]);
    expect(validateSurface("menus", patched).ok).toBe(true);
    setConfig(w.db, "menus", patched, "warning screen", "test");

    let sid: string | undefined;
    const screens: string[] = [];
    for (const input of ["*170#", "1", "1", "0249912345", "0249912345", "10", "x"]) {
      const r = await withLock(w, () => ussd(w, { sessionId: sid, msisdn: "0249900001", input }));
      sid = r.sessionId;
      screens.push(r.text);
    }
    // 0249912345 is unlikely to exist; either the warning or "not registered" is fine, but the
    // walk must not crash. Pick a real MTN wallet that is not a contact instead.
    const target = w.db.prepare("SELECT msisdn FROM wallets WHERE telco='mtn' AND owner_type='person' AND msisdn NOT IN (SELECT contact FROM contacts WHERE msisdn='0249900001') AND msisdn != '0249900001' LIMIT 1").get() as { msisdn: string };
    sid = undefined;
    let last = "";
    for (const input of ["*170#", "1", "1", target.msisdn, target.msisdn, "10", "x"]) {
      const r = await withLock(w, () => ussd(w, { sessionId: sid, msisdn: "0249900001", input }));
      sid = r.sessionId;
      last = r.text;
    }
    expect(last).toContain("never paid this number");
    expect(last).toContain("1) Continue");
  });

  it("undo restores the previous configuration", async () => {
    const w = await ff("team-03", 0);
    const before = getConfig(w.db, "rules");
    const id = setConfig(w.db, "rules", { ...before, pinAttemptsBeforeLock: 5 }, "change", "test");
    expect(getConfig(w.db, "rules").pinAttemptsBeforeLock).toBe(5);
    undoChange(w.db, id, "test");
    expect(getConfig(w.db, "rules")).toEqual(before);
  });

  it("rejects invalid configuration with readable errors", () => {
    const r = validateSurface("fraudChecks", { checks: [{ id: "x", name: "x", enabled: true, appliesTo: ["p2p"], when: { fact: "nope", op: ">", value: 1 }, action: "block" }], webhook: { enabled: false, url: "", timeoutMs: 500, failOpen: true } });
    expect(r.ok).toBe(false);
  });

  it("second factor stops SIM-swap only when it is not an SMS code", async () => {
    const w = await ff("team-02", 0);
    const fc = getConfig(w.db, "fraudChecks");
    const sc = getConfig(w.db, "scenarios");
    setConfig(w.db, "scenarios", { ...sc, legitTxnsPerDay: 500, scenarios: sc.scenarios.map((s) => ({ ...s, enabled: s.id === "sim_swap", perDay: s.id === "sim_swap" ? 60 : 0 })) }, "only sim swap", "test");
    setConfig(w.db, "fraudChecks", { ...fc, checks: [...fc.checks, { id: "sf", name: "2FA after SIM swap", enabled: true, appliesTo: ["p2p", "cashout"], when: { fact: "hours_since_sim_swap", op: "<", value: 48 }, action: "require_second_factor" }] }, "2fa", "test");
    const rules = getConfig(w.db, "rules");
    setConfig(w.db, "rules", { ...rules, secondFactor: { ...rules.secondFactor, method: "ghana_card_selfie" } }, "biometric", "test");
    await withLock(w, () => fastForward(w, 24));
    const m = metrics(w);
    expect(m.fraudAttempts).toBeGreaterThan(5);
    expect(m.detectionRate).toBeGreaterThan(0.8);
  });
});

describe("fees", async () => {
  const { feeFor } = await import("../src/engine/payments");
  const { DEFAULTS } = await import("../src/engine/config/defaults");
  const r = DEFAULTS.rules;
  const fee = (telco: "mtn" | "telecel" | "at", kind: Parameters<typeof feeFor>[2], cedis: number) => feeFor(r, telco, kind, Math.round(cedis * 100)) / 100;

  it("applies the MTN tariff (AT uses the same)", () => {
    expect(fee("mtn", "p2p_onnet", 200)).toBe(1.5);
    expect(fee("mtn", "p2p_offnet", 1000)).toBe(7.5);
    expect(fee("mtn", "p2p_onnet", 5000)).toBe(7.5);
    expect(fee("mtn", "cashout", 20)).toBe(0.5);
    expect(fee("mtn", "cashout", 49.99)).toBe(0.5);
    expect(fee("mtn", "cashout", 50)).toBe(0.5);
    expect(fee("mtn", "cashout", 500)).toBe(5);
    expect(fee("mtn", "cashout", 2500)).toBe(20);
    expect(fee("mtn", "to_bank", 400)).toBe(3);
    expect(fee("mtn", "to_bank", 2000)).toBe(5);
    expect(fee("at", "cashout", 500)).toBe(fee("mtn", "cashout", 500));
  });

  it("applies the Telecel tariff", () => {
    expect(fee("telecel", "p2p_onnet", 5000)).toBe(0);
    expect(fee("telecel", "p2p_offnet", 100)).toBe(0);
    expect(fee("telecel", "p2p_offnet", 600)).toBe(3);
    expect(fee("telecel", "p2p_offnet", 1500)).toBe(5);
    expect(fee("telecel", "p2p_offnet", 9000)).toBe(5);
    expect(fee("telecel", "cashout", 30)).toBe(0.5);
    expect(fee("telecel", "cashout", 1000)).toBe(10);
    expect(fee("telecel", "cashout", 2500)).toBe(20);
  });
});
