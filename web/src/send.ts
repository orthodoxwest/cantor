// Sending a take: its audio and its judged result go to the Worker, which answers with a link
// anyone holding it may open, with no account, to hear the take on its score.

/** Whether the Worker knows the visitor; only a signed-in singer may send a take. */
export async function signedIn(): Promise<boolean> {
  try {
    const res = await fetch("/api/me", { redirect: "manual" });
    return res.ok && typeof ((await res.json()) as { id?: unknown }).id === "string";
  } catch {
    return false;
  }
}

/** What a take is sent with besides its audio. */
export interface Sent {
  slug: string;
  title: string;
  /** The score the take was judged against. */
  gabc: string;
  pulse: number;
  offset: number;
  seconds: number;
  /** The ear's judged result, as the core wrote it. */
  judged: unknown;
}

/** The largest take the Worker accepts (takes.ts `MAX_AUDIO`). */
export const MAX_AUDIO = 16 * 1024 * 1024;

/** How long a send may take before it is given up, in milliseconds. */
const SEND_TIMEOUT = 120_000;

/** Sends the take; resolves with the link to it. */
export async function sendTake(wav: ArrayBuffer, take: Sent): Promise<string> {
  if (wav.byteLength > MAX_AUDIO) throw new Error("the take is too long to send");
  const form = new FormData();
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "take.wav");
  form.append("take", JSON.stringify(take));
  const res = await fetch("/api/takes", { method: "POST", body: form, signal: AbortSignal.timeout(SEND_TIMEOUT) }).catch((error: unknown) => {
    throw error instanceof DOMException && error.name === "TimeoutError" ? new Error("the connection is too slow; try again") : error;
  });
  if (res.status === 401) throw new Error("you are no longer signed in");
  if (res.status === 403) throw new Error("the site could not tell that the take came from this page");
  if (res.status === 413) throw new Error("the take is too long to send");
  if (!res.ok) throw new Error(`the site answered ${res.status}`);
  const { url } = (await res.json()) as { url: string };
  return new URL(url, location.origin).href;
}

/** Copies the text `link` will resolve with. Called while the tap that asked for it is still
 * the page's to use (Safari allows the clipboard only then), with the text to come; resolves
 * whether it was copied. */
export async function copyWhenReady(link: Promise<string>): Promise<boolean> {
  // Whatever becomes of the link, it has said so; this only copies it.
  link.catch(() => {});
  try {
    const blob = link.then((text) => new Blob([text], { type: "text/plain" }));
    blob.catch(() => {});
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    return true;
  } catch {
    // A browser that takes no text to come may still take it once it has come.
  }
  try {
    await navigator.clipboard.writeText(await link);
    return true;
  } catch {
    // A link that did not come has said why; one that came may be copied by hand.
    return false;
  }
}
