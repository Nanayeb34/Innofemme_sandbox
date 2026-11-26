"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * State the whole app shares in the browser, in one place:
 *   - preferences, remembered between visits (text size in the editor, which panels are open, page sizes)
 *   - the latest data of each console, so moving between pages shows it at once while it refreshes
 *   - the confirmation dialog, which any part of the app can ask a question with
 */

// ---------- preferences ----------

interface Prefs {
  /** Text size in the Developer console's editor, in pixels. */
  codeSize: number;
  /** Whether the Developer console's side panel and output panel are open. */
  devSide: boolean | null;
  devBottom: boolean;
  /** Rows per page in activity lists. */
  activityPageSize: number;
  set: (p: Partial<Omit<Prefs, "set">>) => void;
}

// Some browsers refuse storage (private windows, blocked site data): preferences then simply last until the page closes.
const safeStorage = createJSONStorage(() => {
  try {
    const t = "__probe__";
    localStorage.setItem(t, t);
    localStorage.removeItem(t);
    return localStorage;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
  }
});

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      codeSize: 13,
      devSide: null,
      devBottom: true,
      activityPageSize: 8,
      set: (p) => set(p),
    }),
    { name: "sandbox:prefs", storage: safeStorage, partialize: (s) => ({ codeSize: s.codeSize, devSide: s.devSide, devBottom: s.devBottom, activityPageSize: s.activityPageSize }) },
  ),
);

// ---------- what each console last showed ----------

interface ViewEntry {
  data: unknown;
  error: string | null;
  at: number;
}

interface Views {
  entries: Record<string, ViewEntry>;
  put: (key: string, e: Partial<ViewEntry>) => void;
}

export const useViews = create<Views>()((set) => ({
  entries: {},
  put: (key, e) => set((s) => ({ entries: { ...s.entries, [key]: { data: s.entries[key]?.data ?? null, error: null, at: Date.now(), ...e } } })),
}));

// ---------- the confirmation dialog ----------

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirm?: string;
  cancel?: string;
  /** For something that cannot be undone: the button is red. */
  danger?: boolean;
}

interface Confirming {
  open: (ConfirmOptions & { resolve: (yes: boolean) => void }) | null;
  ask: (o: ConfirmOptions) => Promise<boolean>;
  answer: (yes: boolean) => void;
}

export const useConfirm = create<Confirming>()((set, get) => ({
  open: null,
  ask: (o) =>
    new Promise<boolean>((resolve) => {
      // A question still open is answered "no" before the next one is asked.
      get().open?.resolve(false);
      set({ open: { ...o, resolve } });
    }),
  answer: (yes) => {
    get().open?.resolve(yes);
    set({ open: null });
  },
}));

/** Asks the person to confirm, in the app's own dialog. Resolves to true if they agree. */
export const askConfirm = (o: ConfirmOptions) => useConfirm.getState().ask(o);
