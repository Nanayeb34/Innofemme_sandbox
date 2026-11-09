// Prints the organiser access key and each team's join link. Usage: pnpm sandbox:info [public base url]
import { registry } from "../src/engine/worlds";

const base = (process.argv[2] || process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
const reg = registry();
console.log(`Organiser sign-in: ${base}/organiser\nOrganiser access key: ${reg.organiserKey}\n`);
for (const t of reg.teams) console.log(`${t.name.padEnd(8)} phone: ${base}/join/${t.id}?k=${t.key}\n         console: ${base}/join/${t.id}?k=${t.key}&to=console`);
