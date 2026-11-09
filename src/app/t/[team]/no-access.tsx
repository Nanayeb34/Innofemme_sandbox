import { InnofemmeLogo } from "@/components/brand";

export function NoAccess() {
  return (
    <main className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <InnofemmeLogo size={56} />
      <h1 className="text-xl font-semibold">Scan your team&apos;s QR code</h1>
      <p className="text-sm text-gray-600">This page belongs to a hackathon team. Scan the QR code on your team card to continue.</p>
    </main>
  );
}
