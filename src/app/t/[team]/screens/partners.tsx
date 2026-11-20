"use client";

import Link from "next/link";
import { useState } from "react";
import { ActionButton, ActionForm, Section, Status, Table, type Field } from "@/components/ui";
import { when } from "@/lib/client";

export interface ApiPartner {
  id: string;
  name: string;
  secret: string;
  status: string;
  calls: number;
  callbackUrl: string | null;
  linked: string;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * Where an institution gives outside companies API access, as it would a licensed payments or
 * messaging company. The credentials work only on this institution's API.
 */
export function ApiPartners({
  team, path, partners, onChange, institution, apiPath, what, link,
}: {
  team: string;
  /** This console's API path, e.g. /s/telco/mtn */
  path: string;
  partners: ApiPartner[];
  onChange: () => void;
  institution: string;
  /** The partner API these credentials open, e.g. /momo/mtn and /network/mtn */
  apiPath: string;
  what: string;
  /** What the partner is tied to here: a merchant (telco) or an account (bank). */
  link?: Field;
}) {
  const [shown, setShown] = useState<string | null>(null);
  return (
    <>
      <Section
        title="Give a company API access"
        hint={
          <>
            {what} The company gets a client ID and an API key that work only on {institution}&apos;s API (<code className="text-xs">/api/w/{team}{apiPath}</code>). It does not get your team key. See the{" "}
            <Link className="underline" href={`/t/${team}/docs`}>
              documentation
            </Link>
            .
          </>
        }
      >
        <ActionForm
          team={team}
          path={path}
          action="api_partner_create"
          submit="Issue credentials"
          onDone={onChange}
          fields={[
            { name: "name", label: "Company name", placeholder: "PayLink Ghana" },
            ...(link ? [link] : []),
            { name: "callbackUrl", label: "Callback address", optional: true, placeholder: "https://…", hint: "Where results are sent when a request does not name its own." },
          ]}
        />
      </Section>
      <Section title="Companies with API access">
        <Table
          rows={partners}
          empty={`No company has API access to ${institution} yet.`}
          cols={[
            { label: "Company", cell: (p) => (<><span className="font-medium text-gray-900">{p.name}</span>{p.linked && <div className="text-[11px] text-gray-500">{p.linked}</div>}</>) },
            { label: "Client ID", cell: (p) => <span className="break-all font-mono text-[11px]">{p.id}</span> },
            {
              label: "API key",
              cell: (p) =>
                shown === p.id ? (
                  <span className="break-all font-mono text-[11px]">{p.secret}</span>
                ) : (
                  <button className="text-xs underline" onClick={() => setShown(p.id)}>
                    Show
                  </button>
                ),
            },
            { label: "Calls", right: true, cell: (p) => p.calls },
            { label: "Last used", cell: (p) => <span className="whitespace-nowrap text-gray-500">{p.lastUsedAt ? when(p.lastUsedAt) : "never"}</span> },
            { label: "Status", cell: (p) => <Status value={p.status} /> },
            {
              label: "",
              cell: (p) => (
                <span className="flex flex-wrap gap-1">
                  <ActionButton team={team} path={path} body={{ action: "api_partner_status", id: p.id, status: p.status === "active" ? "suspended" : "active" }} onDone={onChange} danger={p.status === "active"}>
                    {p.status === "active" ? "Suspend" : "Restore"}
                  </ActionButton>
                  <ActionButton team={team} path={path} body={{ action: "api_partner_rotate", id: p.id }} confirmText={`Issue ${p.name} a new API key? The old one stops working at once.`} onDone={() => { setShown(p.id); onChange(); }}>
                    New key
                  </ActionButton>
                </span>
              ),
            },
          ]}
        />
      </Section>
    </>
  );
}
