import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";
import { SimError, newId } from "./util";

/**
 * Plug-ins a team writes in the Developer console, in JavaScript or Python, and the sandbox runs for them.
 *
 * Each plug-in is one file with a function `decide(point, data, ctx)`. It gets the address code://<id>, which can
 * be plugged into any step of any institution like an API address. When the institution asks, the question is
 * handed to a small program that runs the team's file in a process of its own, and its answer comes back the
 * way an API's would.
 *
 * The process keeps running between questions, so anything the code keeps in memory stays; `ctx.store` is kept
 * on disk as well. It runs with no secrets in its environment, in a folder of its own, and is stopped when it
 * takes too long or has been idle a while. JavaScript runs under Node's permission model: it can read and write
 * only its own folder and cannot start other programs. Python is held to the same with an audit hook. On a
 * server every team shares, neither can reach private network addresses. These are sensible limits for a
 * hackathon, not a hardened sandbox.
 */

export type Language = "javascript" | "python";
export const LANGUAGES: Record<Language, { label: string; file: string }> = {
  javascript: { label: "JavaScript (.mjs)", file: "plugin.mjs" },
  python: { label: "Python (.py)", file: "plugin.py" },
};

export interface CodeMeta {
  id: string;
  name: string;
  language: Language;
  createdAt: number;
  updatedAt: number;
}

const ROOT = path.join(DATA_DIR, "code");
const MAX_PLUGINS = 20;
const MAX_SOURCE = 100_000;
const MAX_LOG_LINES = 300;
const IDLE_MS = 20 * 60 * 1000;
const ID = /^code_[a-f0-9]{16}$/;

const shared = () => process.env.SANDBOX_PRIVATE_ADDRESSES === "block";
/** Teams' own code can be switched off for a whole server with SANDBOX_DEVELOPER_CODE=off. */
export const codeEnabled = () => process.env.SANDBOX_DEVELOPER_CODE !== "off";

let python: string | null | undefined;
/** The Python the server has, if any. */
export function pythonCommand(): string | null {
  if (python === undefined) {
    python = null;
    for (const cmd of ["python3", "python"]) {
      const r = spawnSync(cmd, ["-c", "import sys; print(sys.version_info[0])"], { encoding: "utf8", timeout: 5000 });
      if (r.status === 0 && r.stdout.trim() === "3") {
        python = cmd;
        break;
      }
    }
  }
  return python;
}

const teamDir = (team: string) => {
  if (!/^[a-z0-9-]+$/.test(team)) throw new SimError("Unknown team");
  return path.join(ROOT, team);
};
const dirOf = (team: string, id: string) => {
  if (!ID.test(id)) throw new SimError("Unknown plug-in");
  return path.join(teamDir(team), id);
};

export const codeAddress = (id: string) => `code://${id}`;
/** The plug-in a code:// address names, if it is one. */
export const codeIdOf = (address: string): string | undefined => {
  const m = /^code:\/\/(code_[a-f0-9]{16})\/?$/i.exec(address.trim());
  return m?.[1].toLowerCase();
};

function readMeta(team: string, id: string): CodeMeta {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(team, id), "meta.json"), "utf8")) as CodeMeta;
  } catch {
    throw new SimError("Unknown plug-in");
  }
}

export function listCode(team: string): CodeMeta[] {
  const dir = teamDir(team);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => ID.test(d))
    .flatMap((id) => {
      try {
        return [readMeta(team, id)];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getCode(team: string, id: string): CodeMeta & { source: string } {
  const meta = readMeta(team, id);
  return { ...meta, source: fs.readFileSync(path.join(dirOf(team, id), LANGUAGES[meta.language].file), "utf8") };
}

const cleanName = (name: unknown) => {
  const n = String(name ?? "").trim().slice(0, 60);
  if (!n) throw new SimError("Give the plug-in a name");
  return n;
};
const cleanSource = (source: unknown) => {
  const s = String(source ?? "");
  if (s.length > MAX_SOURCE) throw new SimError(`The code is too long: at most ${MAX_SOURCE / 1000} KB`);
  return s;
};

export function createCode(team: string, input: { name?: unknown; language?: unknown; source?: unknown }): CodeMeta {
  if (!codeEnabled()) throw new SimError("Running your own code is switched off on this server");
  const language: Language = input.language === "python" ? "python" : "javascript";
  if (language === "python" && !pythonCommand()) throw new SimError("Python is not installed on this server. Use JavaScript, or ask the organisers.");
  if (listCode(team).length >= MAX_PLUGINS) throw new SimError(`A team can have at most ${MAX_PLUGINS} plug-ins. Delete one first.`);
  const id = newId("code").toLowerCase().replace(/[^a-z0-9_]/g, "0");
  const dir = dirOf(team, id);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const meta: CodeMeta = { id, name: cleanName(input.name), language, createdAt: now, updatedAt: now };
  fs.writeFileSync(path.join(dir, LANGUAGES[language].file), cleanSource(input.source));
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

/** Saves new code (and name). The running copy is stopped, so the next question starts the new code. */
export function saveCode(team: string, id: string, input: { name?: unknown; source?: unknown }): CodeMeta {
  const meta = readMeta(team, id);
  const dir = dirOf(team, id);
  if (input.source !== undefined) fs.writeFileSync(path.join(dir, LANGUAGES[meta.language].file), cleanSource(input.source));
  const next = { ...meta, name: input.name === undefined ? meta.name : cleanName(input.name), updatedAt: Date.now() };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(next, null, 2));
  stopCode(team, id, "The code was saved: the new version starts with the next question.");
  return next;
}

export function deleteCode(team: string, id: string) {
  readMeta(team, id);
  stopCode(team, id);
  runs().delete(`${team}/${id}`);
  fs.rmSync(dirOf(team, id), { recursive: true, force: true });
}

/** Empties what the plug-in has kept in ctx.store. */
export function clearStore(team: string, id: string) {
  readMeta(team, id);
  stopCode(team, id, "The store was emptied.");
  fs.rmSync(path.join(dirOf(team, id), "store.json"), { force: true });
}

// ---------- running ----------

interface Pending {
  resolve: (answer: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Run {
  proc?: ChildProcess;
  status: "stopped" | "starting" | "running" | "failed";
  ready?: Promise<void>;
  pending: Map<number, Pending>;
  next: number;
  logs: { at: number; text: string; kind: "out" | "err" | "info" }[];
  idle?: NodeJS.Timeout;
  error?: string;
  calls: number;
}

// Kept across hot reloads in development, so running plug-ins are not orphaned.
const g = globalThis as unknown as { __codeRuns?: Map<string, Run> };
const runs = () => (g.__codeRuns ??= new Map());

function runOf(team: string, id: string): Run {
  const key = `${team}/${id}`;
  let r = runs().get(key);
  if (!r) runs().set(key, (r = { status: "stopped", pending: new Map(), next: 1, logs: [], calls: 0 }));
  return r;
}

function log(r: Run, kind: Run["logs"][number]["kind"], text: string) {
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!line && kind !== "info") continue;
    r.logs.push({ at: Date.now(), kind, text: line.slice(0, 1000) });
  }
  if (r.logs.length > MAX_LOG_LINES) r.logs.splice(0, r.logs.length - MAX_LOG_LINES);
}

export function codeStatus(team: string, id: string) {
  const r = runOf(team, id);
  return { status: r.status, error: r.error ?? null, calls: r.calls, logs: r.logs.map((l) => ({ at: new Date(l.at).toISOString(), kind: l.kind, text: l.text })) };
}

export function clearLogs(team: string, id: string) {
  runOf(team, id).logs = [];
}

export function stopCode(team: string, id: string, why?: string) {
  const r = runs().get(`${team}/${id}`);
  if (!r) return;
  if (r.proc && r.proc.exitCode === null) r.proc.kill("SIGKILL");
  r.proc = undefined;
  r.ready = undefined;
  r.status = "stopped";
  for (const p of r.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(why ?? "The plug-in was stopped"));
  }
  r.pending.clear();
  if (r.idle) clearTimeout(r.idle);
  if (why) log(r, "info", why);
}

function start(team: string, id: string): Promise<void> {
  const r = runOf(team, id);
  if (r.ready && r.proc && r.proc.exitCode === null) return r.ready;
  const meta = readMeta(team, id);
  // Node's permission model checks real paths, so a data folder reached through a symlink must be resolved first.
  const dir = fs.realpathSync(dirOf(team, id));
  const file = path.join(dir, LANGUAGES[meta.language].file);
  let cmd: string;
  let args: string[];
  if (meta.language === "python") {
    const py = pythonCommand();
    if (!py) throw new SimError("Python is not installed on this server");
    fs.writeFileSync(path.join(dir, ".runner.py"), PY_RUNNER);
    cmd = py;
    args = ["-I", "-u", "-B", path.join(dir, ".runner.py"), dir, file, shared() ? "1" : "0"];
  } else {
    fs.writeFileSync(path.join(dir, ".runner.mjs"), JS_RUNNER);
    cmd = process.execPath;
    // Newer Node versions also close the network under --permission; plug-ins may call APIs, so open it where that applies.
    const net = process.allowedNodeEnvironmentFlags.has("--allow-net") ? ["--allow-net"] : [];
    args = ["--permission", `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, ...net, "--max-old-space-size=96", "--disable-warning=ExperimentalWarning", path.join(dir, ".runner.mjs"), dir, file, shared() ? "1" : "0"];
  }
  r.status = "starting";
  r.error = undefined;
  log(r, "info", `Starting ${meta.name} (${LANGUAGES[meta.language].label})`);
  // No secrets: only what a program needs to run.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", PYTHONIOENCODING: "utf-8" } as unknown as NodeJS.ProcessEnv;
  const proc: ChildProcess = spawn(cmd, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
  r.proc = proc;
  r.ready = new Promise<void>((resolve, reject) => {
    let buffer = "";
    const startTimer = setTimeout(() => {
      r.error = "The plug-in did not start within 10 seconds";
      reject(new Error(r.error));
      proc.kill("SIGKILL");
    }, 10_000);
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("\u0001")) {
          log(r, "out", line);
          continue;
        }
        let msg: { ready?: boolean; fatal?: string; id?: number; answer?: unknown; error?: string; message?: string };
        try {
          msg = JSON.parse(line.slice(1));
        } catch {
          continue;
        }
        if (msg.ready) {
          clearTimeout(startTimer);
          r.status = "running";
          resolve();
        } else if (msg.fatal) {
          clearTimeout(startTimer);
          r.status = "failed";
          r.error = msg.fatal.split("\n")[0];
          log(r, "err", msg.fatal);
          reject(new Error(`Your code could not start: ${r.error}`));
        } else if (msg.id !== undefined) {
          const p = r.pending.get(msg.id);
          if (!p) continue;
          r.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error !== undefined) {
            log(r, "err", msg.error);
            p.reject(new Error(`Your code raised an error: ${(msg.message ?? msg.error.trim().split("\n").pop() ?? "").slice(0, 300)}`));
          } else p.resolve(msg.answer);
        }
      }
    });
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => log(r, "err", chunk));
    proc.on("exit", (code, signal) => {
      clearTimeout(startTimer);
      if (r.proc !== proc) return;
      r.proc = undefined;
      r.ready = undefined;
      if (r.status !== "failed") r.status = "stopped";
      if (code !== 0 && signal !== "SIGKILL") log(r, "info", `The plug-in stopped (exit code ${code ?? signal}).`);
      for (const p of r.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(r.error ? `Your code could not start: ${r.error}` : "The plug-in stopped while answering"));
      }
      r.pending.clear();
      reject(new Error(r.error ?? "The plug-in stopped"));
    });
    proc.on("error", (e) => {
      r.status = "failed";
      r.error = e.message;
      reject(e);
    });
  });
  r.ready.catch(() => undefined);
  return r.ready;
}

/**
 * Asks a team's plug-in one question and returns its answer. A plug-in that takes longer than `timeoutMs` is
 * stopped (it may be stuck in a loop) and started afresh for the next question.
 */
export async function askCode(team: string, id: string, req: { point: string; institution: string; world: string; at?: string; data: unknown }, timeoutMs: number): Promise<unknown> {
  if (!codeEnabled()) throw new Error("Running your own code is switched off on this server");
  const r = runOf(team, id);
  const began = Date.now();
  await start(team, id);
  const left = Math.max(50, timeoutMs - (Date.now() - began));
  r.calls += 1;
  if (r.idle) clearTimeout(r.idle);
  r.idle = setTimeout(() => stopCode(team, id, "Stopped after 20 minutes without questions. It starts again with the next one."), IDLE_MS);
  r.idle.unref?.();
  const n = r.next++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      r.pending.delete(n);
      log(r, "err", `No answer within ${timeoutMs} ms: the plug-in was restarted.`);
      stopCode(team, id);
      reject(new Error(`No answer within ${timeoutMs} ms`));
    }, left);
    r.pending.set(n, { resolve, reject, timer });
    r.proc?.stdin?.write(JSON.stringify({ id: n, ...req }) + "\n");
  });
}

/** Starts a plug-in ahead of its first question, so a mistake in it shows up straight away. */
export async function warmCode(team: string, id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await start(team, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------- the programs that run a team's file ----------

const JS_RUNNER = String.raw`// Written by the sandbox: runs plugin.mjs and passes questions to it. Do not edit.
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const [dir, file, guard] = process.argv.slice(2);
const send = (o) => process.stdout.write("\u0001" + JSON.stringify(o) + "\n");
const storeFile = dir + "/store.json";
let kept = {};
try { kept = JSON.parse(readFileSync(storeFile, "utf8")); } catch {}
let dirty = false;
const store = {
  get: (k) => kept[k],
  set: (k, v) => { kept[k] = v; dirty = true; },
  delete: (k) => { delete kept[k]; dirty = true; },
  all: () => kept,
};

if (guard === "1") {
  const isPrivate = (ip) => {
    if (net.isIPv4(ip)) {
      const [a, b] = ip.split(".").map(Number);
      return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    const s = ip.toLowerCase();
    return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80") || s.startsWith("::ffff:");
  };
  const lookup = (host, opts, done) => import("node:dns").then((dns) => dns.lookup(host, opts, (err, address, family) => {
    if (err) return done(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some((a) => isPrivate(a.address))) return done(new Error("Plug-ins on this server may only reach addresses on the internet"));
    done(null, address, family);
  }));
  const connect = net.Socket.prototype.connect;
  Object.defineProperty(net.Socket.prototype, "connect", {
    writable: false, configurable: false,
    value: function (...args) {
      let opts = args[0];
      const cb = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
      if (Array.isArray(opts)) opts = opts[0];
      if (typeof opts !== "object" || opts === null) opts = { port: args[0], host: typeof args[1] === "string" ? args[1] : "localhost" };
      if (opts.path) throw new Error("Plug-ins on this server may not open local sockets");
      if (net.isIP(opts.host ?? "") && isPrivate(opts.host)) throw new Error("Plug-ins on this server may only reach addresses on the internet");
      return connect.call(this, { ...opts, lookup }, cb);
    },
  });
}

let mod;
try {
  mod = await import(pathToFileURL(file).href);
} catch (e) {
  send({ fatal: String((e && e.stack) || e) });
  process.exit(1);
}
const decide = mod.decide ?? mod.default;
if (typeof decide !== "function") {
  send({ fatal: "Your file must export a function: export function decide(point, data, ctx) { ... }" });
  process.exit(1);
}
send({ ready: true });
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let q;
  try { q = JSON.parse(line); } catch { return; }
  try {
    const answer = await decide(q.point, q.data, { institution: q.institution, world: q.world, at: q.at, store, log: (...a) => console.log(...a) });
    if (dirty) { writeFileSync(storeFile, JSON.stringify(kept)); dirty = false; }
    send({ id: q.id, answer: answer ?? { decision: "allow" } });
  } catch (e) {
    send({ id: q.id, error: String((e && e.stack) || e), message: (e && e.code ? e.code + ": " : "") + String((e && e.message) || e) });
  }
});
`;

const PY_RUNNER = String.raw`# Written by the sandbox: runs plugin.py and passes questions to it. Do not edit.
import importlib.util, ipaddress, json, os, sys, traceback

folder, file, guard = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
out = sys.stdout

def send(o):
    out.write("\x01" + json.dumps(o) + "\n")
    out.flush()

store_file = os.path.join(folder, "store.json")
try:
    with open(store_file) as f:
        kept = json.load(f)
except Exception:
    kept = {}

class Store:
    dirty = False
    def get(self, key, default=None): return kept.get(key, default)
    def set(self, key, value):
        kept[key] = value
        Store.dirty = True
    def delete(self, key):
        kept.pop(key, None)
        Store.dirty = True
    def all(self): return kept

class Ctx:
    def __init__(self, q):
        self.institution, self.world, self.at = q.get("institution"), q.get("world"), q.get("at")
        self.store = Store()
    def log(self, *a): print(*a)

try:
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
except Exception:
    pass

own = os.path.realpath(folder)
system = sorted({os.path.realpath(p) for p in (sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix) if p} | {"/etc/ssl", "/usr/lib/ssl", "/etc/pki", "/usr/share/ca-certificates", "/etc/ca-certificates", "/private/etc/ssl", "/usr/local/etc/openssl", "/usr/local/etc/openssl@3", "/opt/homebrew/etc/openssl@3"})
inside = lambda p, root: p == root or p.startswith(root + os.sep)
writes = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC
BANNED = {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork", "os.forkpty", "pty.spawn", "ctypes.dlopen", "ctypes.dlsym", "ctypes.cdata", "os.kill", "os.killpg", "os.putenv", "os.unsetenv"}

def audit(event, args):
    if event in BANNED:
        raise PermissionError("Plug-ins may not use " + event)
    if event == "open":
        target, mode, flags = args
        if isinstance(target, int) or target is None:
            return
        p = os.path.realpath(os.fsdecode(target))
        if inside(p, own):
            return
        writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & writes)
        if not writing and any(inside(p, r) for r in system):
            return
        raise PermissionError("Plug-ins may only open files in their own folder: " + str(target))
    if event in ("os.listdir", "os.scandir", "os.remove", "os.rename", "os.rmdir", "os.mkdir", "shutil.rmtree"):
        target = args[0] if args else None
        if target is None or isinstance(target, int):
            return
        if not inside(os.path.realpath(os.fsdecode(target)), own):
            raise PermissionError("Plug-ins may only use their own folder")
    if guard and event == "socket.connect":
        address = args[1]
        if isinstance(address, tuple) and address:
            ip = ipaddress.ip_address(address[0].split("%")[0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
                raise PermissionError("Plug-ins on this server may only reach addresses on the internet")
        elif isinstance(address, (str, bytes)):
            raise PermissionError("Plug-ins on this server may not open local sockets")

sys.addaudithook(audit)

try:
    spec = importlib.util.spec_from_file_location("plugin", file)
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    decide = getattr(plugin, "decide", None)
    if not callable(decide):
        raise TypeError("Your file must define a function: def decide(point, data, ctx): ...")
except Exception:
    send({"fatal": traceback.format_exc()})
    sys.exit(1)

send({"ready": True})
for line in sys.stdin:
    try:
        q = json.loads(line)
    except Exception:
        continue
    try:
        answer = decide(q.get("point"), q.get("data") or {}, Ctx(q))
        if Store.dirty:
            with open(store_file, "w") as f:
                json.dump(kept, f)
            Store.dirty = False
        send({"id": q["id"], "answer": answer if answer is not None else {"decision": "allow"}})
    except Exception:
        kind, value = sys.exc_info()[:2]
        send({"id": q["id"], "error": traceback.format_exc(), "message": "".join(traceback.format_exception_only(kind, value)).strip()})
`;

// Stop every plug-in when the server stops.
const gg = globalThis as unknown as { __codeExitHook?: boolean };
if (!gg.__codeExitHook) {
  gg.__codeExitHook = true;
  process.on("exit", () => {
    for (const r of runs().values()) if (r.proc && r.proc.exitCode === null) r.proc.kill("SIGKILL");
  });
}
