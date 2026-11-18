export default function NoAccess() {
  return (
    <main className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center px-6 text-center">
      <h1 className="text-xl font-semibold text-gray-900">Scan your team&apos;s QR code</h1>
      <p className="mt-2 text-sm text-gray-600">
        This sandbox belongs to one team. Open it by scanning the QR code on your team card, or ask an organiser for your team&apos;s link.
      </p>
    </main>
  );
}
