export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureBaseWorld, startTicker } = await import("./engine/worlds");
    ensureBaseWorld();
    startTicker();
  }
}
