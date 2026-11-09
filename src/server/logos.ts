import fs from "node:fs";
import path from "node:path";

/** Public URL of an official telco logo placed in public/brand/telcos, if there is one. */
export function telcoLogo(telco: string): string | null {
  for (const ext of ["svg", "png", "webp"]) {
    if (fs.existsSync(path.join(process.cwd(), "public", "brand", "telcos", `${telco}.${ext}`))) return `/brand/telcos/${telco}.${ext}`;
  }
  return null;
}

export const telcoLogos = () => ({ mtn: telcoLogo("mtn"), telecel: telcoLogo("telecel"), at: telcoLogo("at") });
