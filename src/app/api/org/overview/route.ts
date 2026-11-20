import { HttpError, handle, isOrganiser, publicOrigin } from "@/server/http";
import { getWorld, registry, ORGANISER_WORLD } from "@/engine/worlds";
import { count } from "@/engine/db";

/** Organiser view: how far each team's world has been built. */
export const GET = handle(async (req: Request) => {
  if (!(await isOrganiser(req))) throw new HttpError(401, "Organiser access required");
  const reg = registry();
  const origin = publicOrigin(req);
  const worlds = [...reg.teams.map((t) => ({ id: t.id, name: t.name, key: t.key })), { id: ORGANISER_WORLD, name: "Organiser world", key: "" }];
  return {
    teams: worlds.map((t) => {
      const db = getWorld(t.id).db;
      const n = (sql: string) => count(db, sql);
      return {
        id: t.id,
        name: t.name,
        hubUrl: t.key ? `${origin}/join/${t.id}?k=${t.key}` : `${origin}/t/${t.id}`,
        people: n("SELECT COUNT(*) AS n FROM persons"),
        sims: n("SELECT COUNT(*) AS n FROM sims WHERE status IN ('active','blocked')"),
        wallets: n("SELECT COUNT(*) AS n FROM wallets"),
        agents: n("SELECT COUNT(*) AS n FROM momo_agents") + n("SELECT COUNT(*) AS n FROM sim_agents"),
        bankAccounts: n("SELECT COUNT(*) AS n FROM bank_accounts WHERE kind = 'personal'"),
        payments: n("SELECT COUNT(*) AS n FROM txns WHERE status = 'success' AND type NOT IN ('settlement','reversal','opening')"),
        value: n("SELECT COALESCE(SUM(amount),0) AS n FROM txns WHERE status = 'success' AND type NOT IN ('settlement','reversal','opening')") / 100,
        settingsChanges: n("SELECT COUNT(*) AS n FROM config_history"),
        lastActivity: (db.prepare("SELECT MAX(at) AS at FROM audit").get() as { at: number | null }).at,
      };
    }),
  };
});
