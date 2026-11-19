import { HttpError, body, handle } from "@/server/http";
import { issueToken, requirePartner } from "@/server/partner-auth";
import { verify } from "@/engine/nia";
import { locked } from "@/engine/integrations";
import { SimError } from "@/engine/util";

/**
 * NIA's identity verification service for institutions.
 * Base URL: /api/w/{team}/nia
 *   POST token        client id + API key (Basic) → bearer token
 *   POST v1/verify    { cardNumber, fingerprint?, purpose? }
 * With the holder's fingerprint the answer includes their details (a biometric match). With the card
 * number alone it only says whether the card is valid. Every request is on NIA's log.
 */

type Ctx = RouteContext<"/api/w/[team]/nia/[...path]">;

export const POST = handle(async (req: Request, ctx: Ctx) => {
  const { team, path: parts } = await ctx.params;
  const path = parts.join("/").replace(/\/$/, "");
  if (path === "token") return issueToken(req, team, "nia");
  const { w, client } = requirePartner(req, team, "nia");
  if (path !== "v1/verify") throw new HttpError(404, `No such endpoint: POST ${path}`);
  const b = await body(req);
  if (!b.cardNumber) throw new HttpError(400, "cardNumber is required");
  const biometric = !!b.fingerprint;
  return locked(w, () => {
    try {
      const p = verify(w, { requester: client.name, purpose: String(b.purpose ?? "API verification").slice(0, 80), card: String(b.cardNumber), fingerprint: b.fingerprint as string | undefined, biometric });
      if (!biometric) return { valid: true, cardNumber: p.ghana_card, biometricMatch: null };
      return {
        valid: true, biometricMatch: true, cardNumber: p.ghana_card,
        person: { surname: p.surname, firstNames: p.first_names, dateOfBirth: p.dob, sex: p.gender, nationality: p.nationality, region: p.region, town: p.town },
      };
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
      // Not found, suspended, or the fingerprint is someone else's: an answer, not an error.
      const wrongPerson = /fingerprint/.test(e.message);
      return { valid: wrongPerson, biometricMatch: biometric ? false : null, reason: e.message.replace(/^NIA: /, "") };
    }
  });
});
