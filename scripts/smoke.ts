// Simulates a day in a throwaway world and walks a *170# transfer. Never touches real team worlds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SANDBOX_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "momo-smoke-"));

async function main() {
  const { resetWorld } = await import("../src/engine/worlds");
  const { fastForward } = await import("../src/engine/sim");
  const { metrics } = await import("../src/engine/scoring");
  const { ussd } = await import("../src/engine/ussd");
  const { withLock } = await import("../src/engine/world");
  const t0 = Date.now();
  const w = await resetWorld("team-01");
  console.log("world ready in", Date.now() - t0, "ms; sim", new Date(w.now).toISOString());
  const t1 = Date.now();
  await withLock(w, () => fastForward(w, 24));
  console.log("24h simulated in", Date.now() - t1, "ms");
  const m = metrics(w);
  console.log(JSON.stringify(m, null, 1));
  const byScen = w.db.prepare("SELECT scenario, status, COUNT(*) n FROM txns WHERE is_fraud=1 GROUP BY scenario, status ORDER BY scenario").all();
  console.table(byScen);
  console.log("sms", w.db.prepare("SELECT COUNT(*) n FROM sms").get(), "calls", w.db.prepare("SELECT COUNT(*) n FROM calls").get(), "reports", w.db.prepare("SELECT COUNT(*) n FROM fraud_reports").get());
  const sum = w.db.prepare("SELECT txn_id, SUM(amount) s FROM postings GROUP BY txn_id HAVING s != 0").all();
  console.log("unbalanced txns:", sum.length);

  // USSD: Akosua sends GHS 20 to Kwame (cross network) via *170#
  const steps = ["*170#", "1", "2", "0209900002", "0209900002", "20", "lunch", "1234"];
  let sid: string | undefined;
  for (const input of steps) {
    const r = await withLock(w, () => ussd(w, { sessionId: sid, msisdn: "0249900001", input }));
    sid = r.sessionId;
    console.log(`> ${input}\n${r.text}${r.end ? "  [END]" : ""}\n`);
  }
  console.log(w.db.prepare("SELECT step, detail FROM switch_log ORDER BY id DESC LIMIT 3").all());
  console.log(w.db.prepare("SELECT body FROM sms WHERE msisdn='0209900002' ORDER BY id DESC LIMIT 1").get());
}
main();
