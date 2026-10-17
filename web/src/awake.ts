// Keeps the screen on while the page is sounding or listening: a phone left to sleep mid-chant
// hides the score and the cursor, and may stop the microphone. The lock is the browser's own
// (Screen Wake Lock); where there is none, the screen sleeps as it would have.

/** The reasons the screen is held on: while any is, it stays on. */
const holding = new Set<string>();
let lock: WakeLockSentinel | null = null;
/** Whether a lock is being asked for, so that two are not. */
let asking = false;

async function take(): Promise<void> {
  if (asking || (lock && !lock.released) || holding.size === 0 || document.visibilityState !== "visible") return;
  if (!("wakeLock" in navigator)) return;
  asking = true;
  try {
    lock = await navigator.wakeLock.request("screen");
    // Let go while it was being asked for.
    if (holding.size === 0) void lock.release();
  } catch {
    // Refused (low battery, a policy): the screen sleeps as it would have.
    lock = null;
  } finally {
    asking = false;
  }
}

/** Keeps the screen on for `reason` until [`letSleep`] lets it go. */
export function stayAwake(reason: string): void {
  holding.add(reason);
  void take();
}

/** Lets `reason` go; the screen may sleep once no other holds it. */
export function letSleep(reason: string): void {
  holding.delete(reason);
  if (holding.size === 0 && lock) {
    void lock.release();
    lock = null;
  }
}

// The browser lets the lock go when the page is hidden; it is taken again on coming back.
document.addEventListener("visibilitychange", () => void take());
