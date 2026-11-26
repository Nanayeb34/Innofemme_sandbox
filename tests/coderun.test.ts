import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SANDBOX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "momo-sandbox-code-"));
process.env.SANDBOX_TEAMS = "2";

const code = await import("../src/engine/coderun");
const { callOut } = await import("../src/engine/outside");
const TEAM = "team-01";
const ask = (id: string, point: string, data: unknown, timeoutMs = 4000) => code.askCode(TEAM, id, { point, institution: "mtn", world: TEAM, data }, timeoutMs);
const made: string[] = [];
const make = (language: "javascript" | "python", source: string) => {
  const m = code.createCode(TEAM, { name: `test ${language}`, language, source });
  made.push(m.id);
  return m.id;
};
afterAll(() => made.forEach((id) => code.stopCode(TEAM, id)));

const JS = `
export function decide(point, data, ctx) {
  const seen = (ctx.store.get("seen") ?? 0) + 1;
  ctx.store.set("seen", seen);
  console.log("asked", point, data.amount);
  if (point === "boom") throw new Error("kaboom");
  if (point === "loop") for (;;) {}
  if (point === "read") return { decision: "allow", message: String(import.meta.dirname) };
  return data.amount > 100 ? { decision: "warn", message: "big " + seen } : { decision: "allow", message: "seen " + seen };
}
`;
const PY = `
import os
def decide(point, data, ctx):
    seen = ctx.store.get("seen", 0) + 1
    ctx.store.set("seen", seen)
    print("asked", point, data.get("amount"))
    if point == "boom":
        raise ValueError("kaboom")
    if point == "read":
        open("/etc/hosts").read()
    if point == "shell":
        os.system("echo hi")
    if data.get("amount", 0) > 100:
        return {"decision": "warn", "message": "big %d" % seen}
    return {"decision": "allow", "message": "seen %d" % seen}
`;

describe("plug-ins written in the Developer console", () => {
  it("runs JavaScript, keeps its store between questions and on disk, and shows its output", async () => {
    const id = make("javascript", JS);
    expect(await ask(id, "payment.authorize", { amount: 50 })).toEqual({ decision: "allow", message: "seen 1" });
    expect(await ask(id, "payment.authorize", { amount: 500 })).toEqual({ decision: "warn", message: "big 2" });
    expect(code.codeStatus(TEAM, id).logs.some((l) => l.text === "asked payment.authorize 500")).toBe(true);
    // A restart keeps the store.
    code.stopCode(TEAM, id);
    expect(await ask(id, "payment.authorize", { amount: 1 })).toEqual({ decision: "allow", message: "seen 3" });
    // An error in the code is reported, and the plug-in keeps going.
    await expect(ask(id, "boom", {})).rejects.toThrow(/Your code raised an error: .*kaboom/);
    expect(await ask(id, "payment.authorize", { amount: 1 })).toMatchObject({ decision: "allow" });
    // A plug-in stuck in a loop is stopped and comes back for the next question.
    await expect(ask(id, "loop", {}, 600)).rejects.toThrow(/No answer within 600 ms/);
    expect(await ask(id, "payment.authorize", { amount: 1 })).toMatchObject({ decision: "allow" });
  });

  it("reaches the code through a code:// address, as an institution would", async () => {
    const id = make("javascript", JS);
    const r = await callOut(code.codeAddress(id), { body: JSON.stringify({ point: "payment.authorize", institution: "mtn", world: TEAM, data: { amount: 900 } }), timeoutMs: 4000, world: TEAM });
    expect(JSON.parse(r.body)).toEqual({ decision: "warn", message: "big 1" });
    // Another team's world cannot reach it.
    await expect(callOut(code.codeAddress(id), { body: "{}", timeoutMs: 2000, world: "team-02" })).rejects.toThrow(/Unknown plug-in/);
  });

  it("keeps JavaScript to its own folder", async () => {
    const id = make("javascript", `import { readFileSync } from "node:fs";\nexport function decide() { return { decision: "allow", message: readFileSync("/etc/hosts", "utf8").slice(0, 5) }; }`);
    await expect(ask(id, "x", {})).rejects.toThrow(/ERR_ACCESS_DENIED|Access to this API has been restricted/);
    const bad = make("javascript", `export const nothing = 1;`);
    await expect(ask(bad, "x", {})).rejects.toThrow(/must export a function/);
  });

  it.runIf(!!code.pythonCommand())("runs Python the same way, with the same limits", async () => {
    const id = make("python", PY);
    expect(await ask(id, "payment.authorize", { amount: 50 })).toEqual({ decision: "allow", message: "seen 1" });
    expect(await ask(id, "payment.authorize", { amount: 500 })).toEqual({ decision: "warn", message: "big 2" });
    code.stopCode(TEAM, id);
    expect(await ask(id, "payment.authorize", { amount: 1 })).toEqual({ decision: "allow", message: "seen 3" });
    await expect(ask(id, "boom", {})).rejects.toThrow(/ValueError: kaboom/);
    await expect(ask(id, "read", {})).rejects.toThrow(/may only open files in their own folder/);
    await expect(ask(id, "shell", {})).rejects.toThrow(/may not use os.system/);
    expect(code.codeStatus(TEAM, id).logs.some((l) => l.text === "asked payment.authorize 500")).toBe(true);
    const broken = make("python", "def decide(point, data, ctx)\n  return 1");
    await expect(ask(broken, "x", {})).rejects.toThrow(/could not start/);
  });

  it("on a shared server, keeps plug-ins off private network addresses", async () => {
    process.env.SANDBOX_PRIVATE_ADDRESSES = "block";
    try {
      const js = make(
        "javascript",
        `import net from "node:net";
export async function decide(point) {
  await new Promise((ok, no) => { try { const s = net.connect(9, point); s.on("error", no); s.on("connect", ok); } catch (e) { no(e); } });
  return { decision: "allow" };
}`,
      );
      await expect(ask(js, "127.0.0.1", {})).rejects.toThrow(/may only reach addresses on the internet/);
      await expect(ask(js, "localhost", {})).rejects.toThrow(/may only reach addresses on the internet/);
      if (code.pythonCommand()) {
        const py = make("python", `import socket\ndef decide(point, data, ctx):\n    socket.create_connection((point, 9), timeout=1)\n    return {"decision": "allow"}`);
        await expect(ask(py, "127.0.0.1", {})).rejects.toThrow(/may only reach addresses on the internet/);
        await expect(ask(py, "169.254.169.254", {})).rejects.toThrow(/may only reach addresses on the internet/);
      }
    } finally {
      delete process.env.SANDBOX_PRIVATE_ADDRESSES;
    }
  });

  it("saves, lists and deletes a team's plug-ins", () => {
    const id = make("javascript", JS);
    expect(code.listCode(TEAM).some((m) => m.id === id)).toBe(true);
    code.saveCode(TEAM, id, { name: "Renamed", source: "export function decide() { return { decision: 'allow' }; }" });
    expect(code.getCode(TEAM, id)).toMatchObject({ name: "Renamed", source: expect.stringContaining("decide") });
    expect(code.listCode("team-02")).toEqual([]);
    code.deleteCode(TEAM, id);
    expect(code.listCode(TEAM).some((m) => m.id === id)).toBe(false);
    expect(() => code.getCode(TEAM, "code_0000000000000000")).toThrow(/Unknown plug-in/);
  });
});
