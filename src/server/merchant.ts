import { getWallet, type WalletRow } from "@/engine/ledger";
import type { World } from "@/engine/world";
import type { Telco } from "@/engine/util";
import { HttpError } from "./http";

/**
 * The merchant an app is acting for on a network: the one named in the X-Merchant-Id header,
 * or the network's first merchant when the header is left out.
 */
export function merchantFor(w: World, req: Request, telco: Telco): WalletRow {
  const till = req.headers.get("x-merchant-id");
  const row = (till
    ? w.db.prepare("SELECT m.wallet_id FROM merchants m JOIN wallets w ON w.id = m.wallet_id WHERE m.till = ? AND w.telco = ?").get(till, telco)
    : w.db.prepare("SELECT m.wallet_id FROM merchants m JOIN wallets w ON w.id = m.wallet_id WHERE w.telco = ? ORDER BY m.created_at LIMIT 1").get(telco)) as { wallet_id: string } | undefined;
  if (!row) throw new HttpError(404, till ? `No merchant ${till} on this network` : "This network has no merchants yet. Onboard one in the telco back office, then send its merchant ID in X-Merchant-Id.");
  return getWallet(w, row.wallet_id)!;
}
