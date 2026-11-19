"use client";

import { useState } from "react";
import { ActionButton, ActionForm, Loading, REGIONS, Section, Shell, Stat, Stats, Status, Table, Tabs, useView } from "@/components/ui";
import { when } from "@/lib/client";
import { ApiPartners, type ApiPartner } from "./partners";

interface Person {
  id: string;
  ghana_card: string;
  name: string;
  dob: string;
  gender: string;
  nationality: string;
  region: string;
  town: string;
  fingerprint: string;
  status: string;
  issued_at: string;
  sims: number;
}
interface NiaView {
  stats: { cards: number; suspended: number; checks: number; failed: number };
  people: Person[];
  apiPartners: ApiPartner[];
  log: { id: number; at: string; requesterName: string; purpose: string; ghana_card: string; biometric: boolean; result: string }[];
}

const TABS = [["enrol", "Enrol a person"], ["register", "National register"], ["log", "Verification requests"], ["api", "API partners"]] as const;

export default function Nia({ team }: { team: string }) {
  const path = "/s/nia";
  const { data, error, refresh } = useView<NiaView>(team, path);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("enrol");
  return (
    <Shell team={team} title="National Identification Authority" subtitle="Ghana Card register" color="#0b6b3a">
      {!data ? (
        <Loading error={error} />
      ) : (
        <>
          <Stats>
            <Stat label="Ghana Cards issued" value={data.stats.cards} />
            <Stat label="Suspended cards" value={data.stats.suspended} />
            <Stat label="Identity checks answered" value={data.stats.checks} sub="from telcos and banks" />
            <Stat label="Checks failed" value={data.stats.failed} tone={data.stats.failed ? "bad" : undefined} />
          </Stats>
          <Tabs tabs={TABS} value={tab} onChange={setTab} />

          {tab === "enrol" && (
            <Section title="Enrol a person and issue a Ghana Card" hint="Nobody exists in this world until NIA enrols them. One person gets one card. The fingerprint code stands in for the person's real fingerprints: they need it wherever a biometric check is done.">
              <ActionForm
                team={team}
                path={path}
                action="enrol"
                submit="Enrol and issue card"
                onDone={refresh}
                fields={[
                  { name: "firstNames", label: "First names", placeholder: "Ama Serwaa" },
                  { name: "surname", label: "Surname", placeholder: "Owusu" },
                  { name: "dob", label: "Date of birth", type: "date" },
                  { name: "gender", label: "Sex", type: "select", options: [["F", "Female"], ["M", "Male"]] },
                  { name: "region", label: "Region", type: "select", options: REGIONS.map((r) => [r, r] as const) },
                  { name: "town", label: "Town", placeholder: "Kumasi" },
                ]}
              />
            </Section>
          )}

          {tab === "register" && (
            <Section title="National register" hint="Each card with its fingerprint code. Give a person their card number and fingerprint code so they can register a SIM or open a bank account.">
              <Table
                rows={data.people}
                empty="No one has been enrolled yet."
                cols={[
                  { label: "Name", cell: (p) => <span className="font-medium text-gray-900">{p.name}</span> },
                  { label: "Ghana Card", cell: (p) => <span className="font-mono text-xs">{p.ghana_card}</span> },
                  { label: "Fingerprint", cell: (p) => <span className="font-mono text-xs">{p.fingerprint}</span> },
                  { label: "Born", cell: (p) => p.dob },
                  { label: "Sex", cell: (p) => p.gender },
                  { label: "Lives in", cell: (p) => `${p.town}, ${p.region}` },
                  { label: "SIMs", right: true, cell: (p) => p.sims },
                  { label: "Card", cell: (p) => <Status value={p.status} /> },
                  {
                    label: "",
                    cell: (p) => (
                      <ActionButton team={team} path={path} body={{ action: "card_status", card: p.ghana_card, status: p.status === "active" ? "suspended" : "active" }} onDone={refresh} danger={p.status === "active"}>
                        {p.status === "active" ? "Suspend" : "Reinstate"}
                      </ActionButton>
                    ),
                  },
                ]}
              />
            </Section>
          )}

          {tab === "api" && (
            <ApiPartners
              team={team}
              path={path}
              partners={data.apiPartners}
              onChange={refresh}
              institution="NIA"
              apiPath="/nia"
              what="NIA lets certified institutions verify a Ghana Card from their own systems. With the holder's fingerprint the answer includes their details; with the card number alone it only says whether the card is valid."
            />
          )}

          {tab === "log" && (
            <Section title="Verification requests" hint="Every time a telco or bank checks a card, NIA records who asked, why, and what it answered.">
              <Table
                rows={data.log}
                empty="No institution has asked NIA to verify anyone yet."
                cols={[
                  { label: "Time", cell: (l) => <span className="whitespace-nowrap text-gray-500">{when(l.at)}</span> },
                  { label: "Asked by", cell: (l) => l.requesterName },
                  { label: "Purpose", cell: (l) => l.purpose },
                  { label: "Card", cell: (l) => <span className="font-mono text-xs">{l.ghana_card}</span> },
                  { label: "Check", cell: (l) => (l.biometric ? "Card + fingerprint" : "Card only") },
                  { label: "Answer", cell: (l) => <Status value={l.result} /> },
                ]}
              />
            </Section>
          )}
        </>
      )}
    </Shell>
  );
}
