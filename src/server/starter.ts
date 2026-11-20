import fs from "node:fs";
import path from "node:path";

/**
 * The starter kits: small working files a team copies and changes. They live in examples/ in the
 * repository, are shown on the documentation page and can be downloaded from it, so there is one copy.
 * None of them suggests what to build: they show how to connect.
 */
export const KITS = [
  { file: "plugin_api.py", language: "Python", kind: "plugin", run: "python3 plugin_api.py" },
  { file: "plugin-api.mjs", language: "JavaScript", kind: "plugin", run: "node plugin-api.mjs" },
  { file: "app.py", language: "Python", kind: "app", run: "python3 app.py" },
  { file: "app.mjs", language: "JavaScript", kind: "app", run: "node app.mjs" },
] as const;

export type Kit = (typeof KITS)[number];

export function kitSource(file: string): string | undefined {
  if (!KITS.some((k) => k.file === file)) return undefined;
  try {
    return fs.readFileSync(path.join(process.cwd(), "examples", file), "utf8");
  } catch {
    return undefined;
  }
}
