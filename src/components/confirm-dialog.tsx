"use client";

import { AlertTriangle, HelpCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useConfirm } from "@/stores/ui";

/** The app's own confirmation dialog, in place of the browser's. Mounted once, at the root of every page. */
export default function ConfirmDialog() {
  const open = useConfirm((s) => s.open);
  const answer = useConfirm((s) => s.answer);
  const ok = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    ok.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, answer]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/40 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="w-full max-w-md overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
        <div className="flex gap-4 p-5">
          <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${open.danger ? "bg-rose-50 text-rose-600" : "bg-[#f3effa] text-[#3b1f6e]"}`}>
            {open.danger ? <AlertTriangle className="h-5 w-5" /> : <HelpCircle className="h-5 w-5" />}
          </span>
          <div className="min-w-0 pt-1">
            <h2 id="confirm-title" className="text-base font-semibold text-gray-900">
              {open.title}
            </h2>
            {open.message && <p className="mt-1.5 text-sm leading-6 text-gray-600">{open.message}</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-100 bg-gray-50 px-5 py-3">
          <button type="button" onClick={() => answer(false)} className="rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50">
            {open.cancel ?? "Cancel"}
          </button>
          <button
            ref={ok}
            type="button"
            onClick={() => answer(true)}
            className={`rounded-lg px-3.5 py-2 text-sm font-semibold text-white shadow-sm ${open.danger ? "bg-rose-600 hover:bg-rose-500" : "bg-[#3b1f6e] hover:bg-[#2e1757]"}`}
          >
            {open.confirm ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
