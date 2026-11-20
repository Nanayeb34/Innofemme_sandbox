import type { Metadata } from "next";
import { DocsContent } from "./content";

export const metadata: Metadata = { title: "Documentation · Innofemme Mobile Money Fraud Hackathon" };
// The page shows this server's own address, so it is made for each request.
export const dynamic = "force-dynamic";

/** The documentation, open to anyone, with placeholders where a team's own address and key would be. */
export default function PublicDocs() {
  return <DocsContent />;
}
