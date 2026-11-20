"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import AssistantChat from "./assistant-chat";

/**
 * The assistant, within reach from every console: a button in the corner that opens it in a panel beside
 * whatever is on screen. It stays open, and keeps working, while the person moves between consoles.
 */
export default function AssistantLauncher({ team }: { team: string }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const kept = `assistant-open:${team}`;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restores what this browser had open
    if (sessionStorage.getItem(kept) === "1") setOpen(true);
  }, [kept]);
  // While the panel is open the page moves over to make room, so nothing on it is hidden underneath.
  const here = path !== `/t/${team}/assistant`;
  useEffect(() => {
    document.documentElement.classList.toggle("assistant-open", open && here);
    return () => document.documentElement.classList.remove("assistant-open");
  }, [open, here]);
  const show = (on: boolean) => {
    setOpen(on);
    sessionStorage.setItem(kept, on ? "1" : "0");
  };

  // The assistant's own page has it full size already.
  if (!here) return null;

  return (
    <>
      {!open && (
        <button onClick={() => show(true)} className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full bg-[#3b1f6e] px-4 py-3 text-sm font-semibold text-white shadow-lg hover:bg-[#2c1754]" aria-label="Open the assistant">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" strokeLinejoin="round" />
          </svg>
          Assistant
        </button>
      )}
      {open && (
        <aside className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-gray-200 bg-[var(--background)] shadow-2xl sm:w-[26rem]" aria-label="Assistant">
          <div className="flex items-center gap-2 bg-[#3b1f6e] px-3 py-2.5 text-white">
            <div className="mr-auto text-sm font-semibold">Assistant</div>
            <Link href={`/t/${team}/assistant`} className="rounded-md px-2 py-1 text-xs hover:bg-white/15">
              Full page
            </Link>
            <button onClick={() => show(false)} className="rounded-md px-2 py-1 text-xs hover:bg-white/15" aria-label="Close the assistant">
              Close
            </button>
          </div>
          <AssistantChat team={team} />
        </aside>
      )}
    </>
  );
}
