/**
 * The network helpers a phone's browser needs to connect call audio to another phone.
 * STUN lets each phone discover its own address, which is enough when the Wi-Fi lets phones talk
 * to each other directly. TURN is a relay for when it does not; it comes from Cloudflare Realtime
 * when CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN are set.
 */

export interface IceConfig {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  /** True when a relay is available, so calls also work on Wi-Fi that isolates devices. */
  relay: boolean;
}

const STUN_ONLY: IceConfig = { iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], relay: false };
const TTL_SECONDS = 6 * 3600;
const REFRESH_MS = 30 * 60_000;

let cached: { at: number; value: IceConfig } | undefined;

export const relayConfigured = () => !!(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN);

export async function iceConfig(): Promise<IceConfig> {
  if (!relayConfigured()) return STUN_ONLY;
  if (cached && Date.now() - cached.at < REFRESH_MS) return cached.value;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_TURN_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Cloudflare TURN returned ${res.status}`);
    const body = (await res.json()) as { iceServers?: IceConfig["iceServers"] };
    // Browsers refuse port 53, so those addresses only add delay.
    const servers = (body.iceServers ?? [])
      .map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length);
    if (!servers.some((s) => s.urls.some((u) => u.startsWith("turn")))) throw new Error("Cloudflare TURN returned no relay addresses");
    cached = { at: Date.now(), value: { iceServers: servers, relay: true } };
    return cached.value;
  } catch (e) {
    console.error("[sandbox] could not get call relay credentials; calls will try to connect directly:", (e as Error).message);
    return STUN_ONLY;
  }
}
