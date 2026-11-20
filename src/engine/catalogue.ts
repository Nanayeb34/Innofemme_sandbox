/** What every network sells and collects for by default. Each network's own list is in its settings. */

export const DEFAULT_BUNDLES = [
  { id: "daily", name: "Daily 450MB", price: 3, mb: 450, days: 1 },
  { id: "weekly", name: "Weekly 1.2GB", price: 10, mb: 1200, days: 7 },
  { id: "monthly", name: "Monthly 5GB", price: 40, mb: 5000, days: 30 },
  { id: "big", name: "Monthly 15GB", price: 100, mb: 15000, days: 30 },
];

export const DEFAULT_BILLERS: { id: string; name: string; ask: string; token?: boolean }[] = [
  { id: "ecg", name: "ECG Prepaid", ask: "Enter meter number", token: true },
  { id: "water", name: "Ghana Water", ask: "Enter customer account number" },
  { id: "dstv", name: "DStv", ask: "Enter smartcard number" },
  { id: "gotv", name: "GOtv", ask: "Enter IUC number" },
  { id: "school", name: "School Fees", ask: "Enter student ID" },
];

/** The banks whose cash machines pay out against a wallet voucher, and how long a voucher lasts. */
export const DEFAULT_ATM = { banks: ["ecobank", "absa"], minutes: 10 };
