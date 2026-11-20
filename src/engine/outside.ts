import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { bridgeAddress, sendThroughBridge } from "./bridge";
import { SimError, need } from "./util";

/**
 * Calls to addresses a team typed in: the APIs they plug into an institution, their USSD applications,
 * the applications the fraud simulator tests, and the callbacks their API partners ask for.
 *
 * On a server shared by every team, those addresses must be out on the internet. Otherwise a team could
 * point the sandbox at its own machine or the private network around it and read what is there. The shared
 * deployment sets SANDBOX_PRIVATE_ADDRESSES=block for that. Run on your own machine (or in a Codespace) the
 * sandbox allows them, so an API under development on localhost can be plugged in.
 *
 * The address is checked when it is typed and again at the moment of connecting, against the very address
 * the name resolved to, so a name that changes where it points cannot slip past. Redirects are not followed.
 *
 * A team working from a laptop types a bridge address instead (bridge://laptop): the request then travels
 * over the call that team's bridge program keeps open to the sandbox. See bridge.ts.
 */

const blocking = () => process.env.SANDBOX_PRIVATE_ADDRESSES === "block";
/** Whether this sandbox is one every team shares, so that addresses teams type in must be out on the internet. */
export const sharedServer = blocking;

/** Never allowed, wherever the sandbox runs: cloud metadata services hold the server's own credentials. */
const never = new net.BlockList();
never.addSubnet("169.254.0.0", 16, "ipv4");
never.addSubnet("fe80::", 10, "ipv6");
never.addAddress("fd00:ec2::254", "ipv6");

/** This machine and private networks. */
const inside = new net.BlockList();
for (const [range, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) inside.addSubnet(range, bits, "ipv4");
for (const [range, bits] of [["::", 127], ["fc00::", 7], ["ff00::", 8]] as const) inside.addSubnet(range, bits, "ipv6");

const WHY_NOT = "That address is on the sandbox's own machine or private network, which a shared sandbox will not call. Use an address that can be reached from the internet.";

/** Why an IP address may not be called, if it may not. */
function refusal(address: string): string | undefined {
  let ip = address.replace(/^\[|\]$/g, "");
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is judged as the IPv4 address it is.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip) === 6 ? "ipv6" : "ipv4";
  if (never.check(ip, family)) return "That address is not allowed";
  if (blocking() && inside.check(ip, family)) return WHY_NOT;
  return undefined;
}

/** Checks an address a team typed. Throws, in plain words, if the sandbox will not call it. */
export function checkUrl(input: string | undefined | null, what = "The API's address"): string {
  const url = String(need(input?.trim(), what));
  // An API on a team's laptop, reached through their bridge. Whether it is connected is known only when it is called.
  if (/^bridge:/i.test(url)) {
    if (!bridgeAddress(url)) throw new SimError("A bridge address looks like bridge://laptop");
    return url;
  }
  let u: URL;
  try {
    u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    throw new SimError("The address must be a full http:// or https:// address, or a bridge address such as bridge://laptop");
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "metadata.google.internal" || host === "metadata") throw new SimError("That address is not allowed");
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) {
    const no = refusal(host);
    if (no) throw new SimError(no);
  } else if (blocking() && (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || !host.includes("."))) {
    throw new SimError(WHY_NOT);
  }
  return url;
}

/** Looks a name up as usual, then refuses if any address it points at may not be called. */
export const guardedLookup: net.LookupFunction = (hostname, options, done) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (!err) {
      const found = Array.isArray(address) ? address.map((a) => a.address) : [address as string];
      const no = found.map(refusal).find(Boolean);
      if (no) return done(Object.assign(new Error(no), { code: "ENOTALLOWED" }) as NodeJS.ErrnoException, address as string, family);
    }
    done(err, address as string, family);
  });
};

export interface Reply {
  status: number;
  ok: boolean;
  body: string;
}

const MAX_REPLY = 256 * 1024;

/**
 * Sends one request to an address a team supplied and returns what came back. Throws if it cannot be reached in time.
 * `world` says whose request this is: a bridge address means that team's bridge and nobody else's.
 */
export function callOut(address: string, req: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number; world?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      const checked = checkUrl(address);
      const bridge = bridgeAddress(checked);
      if (bridge) {
        if (!req.world) throw new SimError("A bridge address cannot be used here");
        return sendThroughBridge(req.world, bridge.name, bridge.path, req).then(resolve, reject);
      }
      url = new URL(checked);
    } catch (e) {
      return reject(e);
    }
    const body = req.body === undefined ? undefined : Buffer.from(req.body);
    const timer = setTimeout(() => out.destroy(new Error(`No answer within ${req.timeoutMs} ms`)), req.timeoutMs);
    const finish = <T>(fn: (v: T) => void) => (v: T) => {
      clearTimeout(timer);
      fn(v);
    };
    const out = (url.protocol === "https:" ? https : http).request(
      url,
      { method: req.method ?? "POST", headers: { ...req.headers, ...(body ? { "content-length": String(body.length) } : {}) }, lookup: guardedLookup, agent: false },
      (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_REPLY) parts.push(chunk);
          else res.destroy(new Error("The answer was too long"));
        });
        res.on("error", finish(reject));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          finish(resolve)({ status, ok: status >= 200 && status < 300, body: Buffer.concat(parts).toString("utf8") });
        });
      },
    );
    out.on("error", finish(reject));
    out.end(body);
  });
}
