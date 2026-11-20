// Prints the organiser access key and each team's link. Usage: pnpm sandbox:info [public base url]
import { registry } from "../src/engine/worlds";

const base = (process.argv[2] || process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const reg = registry();
console.log(`Organiser sign-in: ${base}/organiser\nOrganiser access key: ${reg.organiserKey}\n`);
console.log("Team links. Each opens that team's CONSOLES: open it on a laptop.");
console.log("(The phone codes are different: they are on the team's page, under \"Open on another device\", to scan with a phone.)\n");
for (const t of reg.teams) console.log(`${t.name.padEnd(8)} ${base}/join/${t.id}?k=${t.key}`);
