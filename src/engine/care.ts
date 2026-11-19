import { count, tx } from "./db";
import { getTxn, getWallet, insertTxn, post, walletByMsisdn, type TxnRow, type WalletRow } from "./ledger";
import { notify } from "./notify";
import { reverse } from "./payments";
import { commit, positionEntries, requireLink, route, switchLog } from "./switch";
import { SimError, TELCO_INFO, cedis, isTelco, need, newId, normalizeMsisdn, participantName, type Telco } from "./util";
import { audit, type World } from "./world";

/**
 * Customer care: the tickets a telco's call centre opens for its customers, and the process for
 * getting money back after a payment the sender disputes.
 *
 * A dispute over a wallet-to-wallet payment runs on the recipient's network, because that is where
 * the money now sits: it can hold the recipient's funds, ask the recipient to agree to return them,
 * and send them back. When the two wallets are on different networks, the sender's network raises
 * the dispute with the recipient's network through the national switch.
 */

export const CATEGORIES = {
  wrong_transfer: "Sent money to the wrong number",
  unauthorised: "Payment the customer did not make",
  agent_complaint: "Problem with a mobile money agent",
  sim_network: "SIM or network problem",
  wallet_access: "Locked wallet or forgotten PIN",
  other: "Something else",
} as const;
export type Category = keyof typeof CATEGORIES;

export interface TicketRow {
  id: string;
  telco: Telco;
  msisdn: string;
  category: Category;
  description: string;
  channel: "call" | "ussd" | "back_office" | "network";
  status: "open" | "awaiting_recipient" | "with_other_network" | "resolved" | "rejected";
  txn_id: string | null;
  role: "sender" | "recipient" | "both" | null;
  linked_ticket: string | null;
  held: number;
  returned: number;
  resolution: string | null;
  created_at: number;
  updated_at: number;
}

const DISPUTABLE = ["p2p", "merchant"];
const AGENT_TXNS = ["cashin", "cashout", "float"];
const shortId = (id: string) => id.slice(3, 13).toUpperCase();
const closed = (t: TicketRow) => t.status === "resolved" || t.status === "rejected";

export const getTicket = (w: World, id: string) => w.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow | undefined;

function own(w: World, telco: Telco, id: unknown): TicketRow {
  const t = getTicket(w, String(need(id as string, "Ticket")));
  if (!t || t.telco !== telco) throw new SimError("Ticket not found on this network");
  return t;
}

function note(w: World, ticketId: string, by: string, text: string) {
  w.db.prepare("INSERT INTO ticket_events(ticket_id, at, by, note) VALUES(?,?,?,?)").run(ticketId, w.now, by, text);
  w.db.prepare("UPDATE tickets SET updated_at = ? WHERE id = ?").run(w.now, ticketId);
}

function setStatus(w: World, ticketId: string, status: TicketRow["status"], resolution?: string) {
  w.db.prepare("UPDATE tickets SET status = ?, resolution = COALESCE(?, resolution), updated_at = ? WHERE id = ?").run(status, resolution ?? null, w.now, ticketId);
}

/** True while a dispute on this payment is still being worked, or has already returned money. */
export function paymentInDispute(w: World, txnId: string): boolean {
  return count(w.db, "SELECT COUNT(*) AS n FROM tickets WHERE txn_id = ? AND (status NOT IN ('resolved','rejected') OR returned > 0 OR held > 0)", txnId) > 0;
}

function insertTicket(w: World, t: Pick<TicketRow, "telco" | "msisdn" | "category" | "description" | "channel" | "txn_id" | "role" | "linked_ticket">): TicketRow {
  const n = count(w.db, "SELECT COUNT(*) AS n FROM tickets WHERE telco = ?", t.telco) + 1;
  const id = `${TELCO_INFO[t.telco].name.toUpperCase()}-${String(n).padStart(6, "0")}`;
  w.db
    .prepare("INSERT INTO tickets(id, telco, msisdn, category, description, channel, status, txn_id, role, linked_ticket, created_at, updated_at) VALUES(?,?,?,?,?,?, 'open', ?,?,?,?,?)")
    .run(id, t.telco, t.msisdn, t.category, t.description, t.channel, t.txn_id, t.role, t.linked_ticket, w.now, w.now);
  return getTicket(w, id)!;
}

/** Opens a ticket for one of this network's customers. A ticket about a payment must be raised by the person who paid. */
export function openTicket(w: World, telco: Telco, input: { msisdn?: string; category?: string; description?: string; txnId?: string; channel: TicketRow["channel"]; by: string }): TicketRow {
  const msisdn = normalizeMsisdn(String(need(input.msisdn, "Customer's number")));
  const sim = w.db.prepare("SELECT telco, status FROM sims WHERE msisdn = ?").get(msisdn) as { telco: string; status: string } | undefined;
  if (!sim || sim.telco !== telco || sim.status === "in_stock") throw new SimError(`${msisdn} is not a registered ${TELCO_INFO[telco].name} number`);
  const category = (input.category ?? "other") as Category;
  if (!(category in CATEGORIES)) throw new SimError("Choose what the complaint is about");
  const description = input.description?.trim() || CATEGORIES[category];

  let txn: TxnRow | undefined;
  let role: TicketRow["role"] = null;
  if (input.txnId) {
    txn = getTxn(w, input.txnId);
    const wallet = walletByMsisdn(w, msisdn);
    if (!txn || !wallet || txn.from_wallet !== wallet.id) throw new SimError("That payment was not made from this customer's wallet");
    if (txn.status !== "success") throw new SimError(`That payment is ${txn.status}; there is nothing to dispute`);
    if (![...DISPUTABLE, ...AGENT_TXNS].includes(txn.type)) throw new SimError("Only wallet payments can be disputed here. For a payment to a bank account, the customer raises it with the bank.");
    if (paymentInDispute(w, txn.id)) throw new SimError("There is already a dispute on this payment");
    role = txn.to_party === telco ? "both" : "sender";
  } else if (category === "wrong_transfer" || category === "unauthorised") {
    throw new SimError("Choose the payment the customer is complaining about");
  }

  return tx(w.db, () => {
    const t = insertTicket(w, { telco, msisdn, category, description, channel: input.channel, txn_id: txn?.id ?? null, role, linked_ticket: null });
    note(w, t.id, input.by, `Ticket opened (${input.channel === "ussd" ? "from the customer's phone" : input.channel === "call" ? "on a call to customer care" : "by the back office"}): ${description}${txn ? `. Payment ${shortId(txn.id)} of GHS ${cedis(txn.amount)}.` : ""}`);
    notify(w, telco, "ticket_opened", msisdn, { ticket: t.id, category: CATEGORIES[category] });
    audit(w, telco, "ticket", `Ticket ${t.id} opened for ${msisdn}: ${CATEGORIES[category]}`);
    return t;
  });
}

export function addNote(w: World, telco: Telco, id: unknown, by: string, text?: string) {
  const t = own(w, telco, id);
  note(w, t.id, by, String(need(text?.trim(), "Note")));
}

/** The disputed payment and the two wallets, for a ticket this network is allowed to act on as the recipient's side. */
function recipientSide(w: World, telco: Telco, id: unknown) {
  const t = own(w, telco, id);
  if (closed(t)) throw new SimError(`Ticket ${t.id} is already ${t.status}`);
  const txn = t.txn_id ? getTxn(w, t.txn_id) : undefined;
  if (!txn) throw new SimError("This ticket is not about a payment");
  if (!DISPUTABLE.includes(txn.type)) throw new SimError("Agent transactions are reversed in full, not held. Use Reverse transaction.");
  if (t.role === "sender") throw new SimError(`The money is on ${participantName(txn.to_party ?? "")}. Send the dispute to that network; only it can hold or return the funds.`);
  const sender = getWallet(w, txn.from_wallet ?? "");
  const recipient = getWallet(w, txn.to_wallet ?? "");
  if (!sender || !recipient) throw new SimError("The wallets on this payment no longer exist");
  return { t, txn, sender, recipient, remaining: txn.amount - t.returned - t.held };
}

/** Keeps the sender's network's ticket in step with what the recipient's network does. */
function mirror(w: World, t: TicketRow, by: string, text: string, status?: TicketRow["status"], resolution?: string) {
  if (t.role !== "recipient" || !t.linked_ticket) return;
  note(w, t.linked_ticket, by, text);
  if (status) setStatus(w, t.linked_ticket, status, resolution);
}

/** Moves as much of the disputed amount as the recipient still has out of their wallet, so it cannot be spent. */
export function placeHold(w: World, telco: Telco, id: unknown, by: string): number {
  const { t, txn, sender, recipient, remaining } = recipientSide(w, telco, id);
  const amount = Math.min(recipient.balance, remaining);
  if (remaining <= 0) throw new SimError("The full amount is already on hold or returned");
  if (amount <= 0) throw new SimError(`${recipient.display_name} has no money left in the wallet to hold`);
  const holdId = newId("tx");
  tx(w.db, () => {
    insertTxn(w, { id: holdId, type: "hold", channel: "console", to_wallet: recipient.id, to_party: telco, rail: "onnet", amount, status: "success", related: txn.id, reference: `Dispute ${t.id}` });
    post(w, holdId, [[`w:${recipient.id}`, -amount], [`hold:${telco}`, amount]]);
    w.db.prepare("UPDATE tickets SET held = held + ? WHERE id = ?").run(amount, t.id);
    const text = `Put GHS ${cedis(amount)} of ${recipient.display_name}'s funds on hold${amount < remaining ? ` (GHS ${cedis(remaining - amount)} has already been spent or withdrawn)` : ""}`;
    note(w, t.id, by, text);
    mirror(w, t, `${TELCO_INFO[telco].name} customer care`, `${participantName(telco)}: ${text}`);
    notify(w, telco, "dispute_hold", recipient.msisdn, { amount: cedis(amount), counterparty: sender.msisdn, ticket: t.id });
    audit(w, telco, "dispute_hold", `Ticket ${t.id}: GHS ${cedis(amount)} held in ${recipient.msisdn}`);
  });
  return amount;
}

function releaseHold(w: World, t: TicketRow, by: string) {
  if (!t.held) return;
  const txn = getTxn(w, t.txn_id!)!;
  const id = newId("tx");
  insertTxn(w, { id, type: "hold_release", channel: "console", to_wallet: txn.to_wallet, to_party: t.telco, rail: "onnet", amount: t.held, status: "success", related: txn.id, reference: `Dispute ${t.id}` });
  post(w, id, [[`hold:${t.telco}`, -t.held], [`w:${txn.to_wallet}`, t.held]]);
  w.db.prepare("UPDATE tickets SET held = 0 WHERE id = ?").run(t.id);
  note(w, t.id, by, `Released the hold of GHS ${cedis(t.held)} back to the recipient`);
}

function withdrawConsentRequest(w: World, ticketId: string, reason: string) {
  w.db.prepare("UPDATE approvals SET status = 'FAILED', reason = ? WHERE kind = 'dispute' AND external_id = ? AND status = 'PENDING'").run(reason, ticketId);
}

/** Asks the recipient, on their own phone, to agree to give the money back. */
export function requestConsent(w: World, telco: Telco, id: unknown, by: string) {
  const { t, txn, sender, recipient } = recipientSide(w, telco, id);
  if (count(w.db, "SELECT COUNT(*) AS n FROM approvals WHERE kind = 'dispute' AND external_id = ? AND status = 'PENDING'", t.id)) throw new SimError("The recipient has already been asked and has not answered yet");
  const amount = txn.amount - t.returned;
  tx(w.db, () => {
    w.db
      .prepare("INSERT INTO approvals(ref, kind, telco, payee_wallet, payer_msisdn, amount, external_id, payer_message, status, created_at) VALUES(?, 'dispute', ?, ?, ?, ?, ?, ?, 'PENDING', ?)")
      .run(newId("dsp"), telco, sender.id, recipient.msisdn, amount, t.id, "sent by mistake", w.now);
    setStatus(w, t.id, "awaiting_recipient");
    note(w, t.id, by, `Asked ${recipient.display_name} (${recipient.msisdn}) to agree to return GHS ${cedis(amount)}`);
    mirror(w, t, `${TELCO_INFO[telco].name} customer care`, `${participantName(telco)} has asked the recipient to agree to return the money`);
    notify(w, telco, "dispute_consent", recipient.msisdn, { amount: cedis(amount), counterparty: sender.msisdn, counterparty_name: sender.display_name, ticket: t.id });
  });
}

/** Sends the money on hold back to the sender. Across networks it travels back through the national switch. */
export function returnFunds(w: World, telco: Telco, id: unknown, by: string): { returned: number; full: boolean } {
  const { t, txn, sender, recipient } = recipientSide(w, telco, id);
  if (!t.held) throw new SimError("Nothing is on hold. Put the recipient's funds on hold first, or ask the recipient to agree.");
  const amount = t.held;
  const senderTelco = sender.telco;
  const cross = senderTelco !== telco;
  const full = t.returned + amount === txn.amount;
  const refundId = newId("tx");
  if (cross) route(w, refundId, telco, senderTelco, amount, `dispute ${t.id}: return to ${sender.msisdn}`);

  tx(w.db, () => {
    insertTxn(w, {
      id: refundId, type: "reversal", channel: "console", from_wallet: recipient.id, to_wallet: sender.id, from_party: telco, to_party: senderTelco, rail: cross ? "switch" : "onnet",
      amount, fee: full ? -txn.fee : 0, status: "success", related: txn.id, reference: `Dispute ${t.id}`,
    });
    const entries: [string, number][] = [[`hold:${telco}`, -amount], [`w:${sender.id}`, amount]];
    if (cross) entries.push(...positionEntries(telco, senderTelco, amount));
    // When everything comes back, the sender's network also gives back the fee it charged.
    if (full && txn.fee) entries.push([`fee:${senderTelco}`, -txn.fee], [`w:${sender.id}`, txn.fee]);
    post(w, refundId, entries);
    if (cross) commit(w, refundId, telco, senderTelco, amount);
    w.db.prepare("UPDATE tickets SET held = 0, returned = returned + ? WHERE id = ?").run(amount, t.id);
    if (full) w.db.prepare("UPDATE txns SET status = 'reversed' WHERE id = ?").run(txn.id);
    withdrawConsentRequest(w, t.id, "Funds returned");

    const text = full ? `Returned the full GHS ${cedis(txn.amount)} to ${sender.display_name} (${sender.msisdn})${txn.fee ? `, with the GHS ${cedis(txn.fee)} fee` : ""}` : `Returned GHS ${cedis(amount)} of GHS ${cedis(txn.amount)} to ${sender.display_name}; the rest could not be recovered`;
    note(w, t.id, by, text);
    const resolution = full ? "Money returned to the sender in full" : undefined;
    if (full) setStatus(w, t.id, "resolved", resolution);
    else setStatus(w, t.id, "open");
    mirror(w, t, `${TELCO_INFO[telco].name} customer care`, `${participantName(telco)}: ${text}`, full ? "resolved" : undefined, resolution);

    for (const wal of [getWallet(w, sender.id)!, getWallet(w, recipient.id)!]) notify(w, wal.telco, "reversal", wal.msisdn, { amount: cedis(amount), txn_id: shortId(txn.id), balance: cedis(wal.balance) });
    if (full) {
      const senderTicket = t.role === "recipient" && t.linked_ticket ? getTicket(w, t.linked_ticket) : t;
      if (senderTicket) notify(w, senderTicket.telco, "ticket_closed", senderTicket.msisdn, { ticket: senderTicket.id, outcome: resolution });
    }
    audit(w, telco, "dispute_return", `Ticket ${t.id}: returned GHS ${cedis(amount)} to ${sender.msisdn}${cross ? ` on ${participantName(senderTelco)}` : ""}`);
  });
  return { returned: amount, full };
}

/**
 * The recipient answered on their phone. Agreeing puts whatever is still recoverable on hold and
 * returns it straight away; refusing hands the decision back to customer care.
 */
export function recipientAnswered(w: World, ticketId: string, agreed: boolean) {
  const t = getTicket(w, ticketId);
  if (!t || closed(t)) throw new SimError("This request is no longer open.");
  const who = "the recipient, from their phone";
  if (!agreed) {
    setStatus(w, t.id, "open");
    note(w, t.id, who, "Refused to return the money");
    mirror(w, t, who, "The recipient refused to return the money");
    return "You have refused. Customer care will review the claim.";
  }
  note(w, t.id, who, "Agreed to return the money");
  const txn = getTxn(w, t.txn_id!)!;
  const recipient = getWallet(w, txn.to_wallet!)!;
  if (txn.amount - t.returned - t.held > 0 && recipient.balance > 0) placeHold(w, t.telco, t.id, who);
  const r = returnFunds(w, t.telco, t.id, who);
  return `GHS ${cedis(r.returned)} has been returned to the sender.${r.full ? "" : " The rest was no longer in your wallet."}`;
}

/** The sender's network raises the dispute with the recipient's network through the national switch. */
export function forwardDispute(w: World, telco: Telco, id: unknown, by: string): TicketRow {
  const t = own(w, telco, id);
  if (closed(t)) throw new SimError(`Ticket ${t.id} is already ${t.status}`);
  const txn = t.txn_id ? getTxn(w, t.txn_id) : undefined;
  if (!txn || t.role !== "sender") throw new SimError("Only a dispute over a payment to another network is sent through the switch");
  if (t.linked_ticket) throw new SimError(`This dispute is already with the other network as ${t.linked_ticket}`);
  const other = txn.to_party;
  if (!other || !isTelco(other)) throw new SimError("The recipient is not on a mobile money network");
  const recipient = getWallet(w, txn.to_wallet ?? "");
  if (!recipient) throw new SimError("The recipient wallet no longer exists");
  // Travels over the switch like a payment does, so both ends must be connected.
  requireLink(w, telco, other);

  return tx(w.db, () => {
    const theirs = insertTicket(w, { telco: other, msisdn: recipient.msisdn, category: t.category, description: `Raised by ${participantName(telco)} (their ticket ${t.id}): ${t.description}`, channel: "network", txn_id: txn.id, role: "recipient", linked_ticket: t.id });
    w.db.prepare("UPDATE tickets SET linked_ticket = ? WHERE id = ?").run(theirs.id, t.id);
    setStatus(w, t.id, "with_other_network");
    note(w, t.id, by, `Sent to ${participantName(other)} through the national switch (their ticket ${theirs.id})`);
    note(w, theirs.id, "national switch", `Dispute received from ${participantName(telco)}: their customer says GHS ${cedis(txn.amount)} sent to ${recipient.msisdn} (payment ${shortId(txn.id)}) should not have been paid`);
    switchLog(w, txn.id, "dispute", telco, other, `${t.id} → ${theirs.id}: GHS ${cedis(txn.amount)} disputed`);
    audit(w, telco, "dispute_forwarded", `Ticket ${t.id} sent to ${participantName(other)} through the switch`);
    audit(w, other, "dispute_received", `Ticket ${theirs.id} received from ${participantName(telco)} through the switch`);
    return theirs;
  });
}

/** An agent transaction (cash-in, cash-out, float) is undone in full: money, fee, commission and the agent's till. */
export function reverseAgentTransaction(w: World, telco: Telco, id: unknown, by: string) {
  const t = own(w, telco, id);
  if (closed(t)) throw new SimError(`Ticket ${t.id} is already ${t.status}`);
  const txn = t.txn_id ? getTxn(w, t.txn_id) : undefined;
  if (!txn || !AGENT_TXNS.includes(txn.type)) throw new SimError("This ticket is not about an agent transaction");
  tx(w.db, () => {
    w.db.prepare("UPDATE tickets SET status = 'resolved' WHERE id = ?").run(t.id); // lets the reversal through the dispute guard
    reverse(w, telco, txn.id);
    setStatus(w, t.id, "resolved", "Transaction reversed");
    note(w, t.id, by, `Reversed the ${txn.type} of GHS ${cedis(txn.amount)}`);
    notify(w, telco, "ticket_closed", t.msisdn, { ticket: t.id, outcome: "Transaction reversed" });
  });
}

/** Closes a ticket. Rejecting a dispute gives any held money back to the recipient. */
export function closeTicket(w: World, telco: Telco, id: unknown, by: string, input: { outcome?: string; resolution?: string }) {
  const t = own(w, telco, id);
  if (closed(t)) throw new SimError(`Ticket ${t.id} is already ${t.status}`);
  const outcome = input.outcome === "rejected" ? "rejected" : "resolved";
  const resolution = String(need(input.resolution?.trim(), "What was decided"));
  if (t.status === "with_other_network") throw new SimError(`This dispute is with the other network (${t.linked_ticket}). It closes when they decide.`);
  if (outcome === "resolved" && t.held) throw new SimError("GHS " + cedis(t.held) + " is still on hold. Return it to the sender, or reject the claim to release it.");
  tx(w.db, () => {
    releaseHold(w, t, by);
    withdrawConsentRequest(w, t.id, "Ticket closed");
    setStatus(w, t.id, outcome, resolution);
    note(w, t.id, by, `${outcome === "resolved" ? "Resolved" : "Rejected"}: ${resolution}`);
    const text = `${participantName(telco)} ${outcome === "resolved" ? "resolved" : "rejected"} the dispute: ${resolution}`;
    mirror(w, t, `${TELCO_INFO[telco].name} customer care`, text, outcome, resolution);
    // The person who complained is told the outcome: this network's customer, or the other network's for a dispute it sent us.
    const complainant = t.role === "recipient" && t.linked_ticket ? getTicket(w, t.linked_ticket) : t;
    if (complainant) notify(w, complainant.telco, "ticket_closed", complainant.msisdn, { ticket: complainant.id, outcome: `${outcome}. ${resolution}` });
    audit(w, telco, "ticket", `Ticket ${t.id} ${outcome}: ${resolution}`);
  });
}

export function ticketEvents(w: World, id: string) {
  return w.db.prepare("SELECT at, by, note FROM ticket_events WHERE ticket_id = ? ORDER BY id").all(id) as { at: number; by: string; note: string }[];
}

export type { WalletRow };
