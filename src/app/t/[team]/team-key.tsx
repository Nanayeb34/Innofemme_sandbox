/** Lets a device that has no access, or only a phone screen, be switched to the team's consoles with the team key. */
export default function TeamKey({ team, label = "Open the consoles on this device" }: { team: string; label?: string }) {
  return (
    // An ordinary form: the browser goes to the same address a scanned team code would open.
    <form className="mt-5 w-full rounded-lg border border-gray-200 bg-white p-3 text-left" method="get" action={`/join/${team}`}>
      <label className="block text-xs font-medium text-gray-600" htmlFor="team-key">
        {label}
      </label>
      <div className="mt-1 flex gap-2">
        <input id="team-key" name="k" required placeholder="Your team key" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <button className="btn btn-dark">Open</button>
      </div>
      <p className="mt-1 text-xs text-gray-500">The team key is on your team card. A teammate who is already in can send you the link from the home page: <b>Invite teammates</b>.</p>
    </form>
  );
}
