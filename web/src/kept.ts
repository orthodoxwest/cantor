// The singer's last take of each chant, kept on this device so that the next take of it can be
// drawn over it: its bands only (the pitch held and heard, never its sound), in the browser's
// IndexedDB, never sent anywhere. A chant is known by a digest of its GABC, so a chant changed
// on the page is another chant. Only the latest `KEEP` chants are kept.
import type { Band } from "./ribbon";

/** The most chants whose last take is kept. */
export const KEEP = 30;

/** A take kept: when it was sung (milliseconds since the epoch), the notes the chant had when it
 * was sung, as [`notesOf`] writes them (a take kept by a build that read the chant otherwise is
 * not drawn on its notes), and its bands. */
export interface Kept {
  at: number;
  notes: string;
  bands: Band[];
}

/** A chant's notes as a take kept of it is drawn on: each note's pitch, in order. */
export function notesOf(notes: ReadonlyArray<{ semitones: number }>): string {
  return notes.map((n) => n.semitones).join(" ");
}

/** A take as stored: each band's trace packed as seconds and cents in turn. */
export interface Stored {
  chant: string;
  at: number;
  notes: string;
  bands: Array<Omit<Band, "trace"> & { trace: Float32Array }>;
}

const DB = "cantor";
const STORE = "takes";
/** Where every tab hears that a take was kept, or the takes kept forgotten. */
const CHANNEL = "cantor.kept";
/** How long the database is given to open, in milliseconds: a browser may never answer (Safari
 * 14.1 did not on a first load), and then nothing is kept until the page is loaded again. */
const OPEN_MS = 2000;

let opened: Promise<IDBDatabase> | null = null;

/** The database, opened once and again once the browser closes it (its data cleared, or a later
 * build opening it anew); rejects where the browser keeps none (a private window may), or does
 * not open it within [`OPEN_MS`]. */
function db(): Promise<IDBDatabase> {
  if (opened) return opened;
  const mine = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(new Error("the takes kept did not open"));
    }, OPEN_MS);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "chant" });
      store.createIndex("at", "at");
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const got = request.result;
      // Opened after it was given up on, it is let go, so as not to hold up a later build's.
      if (late) return got.close();
      const lost = () => {
        if (opened === mine) opened = null;
      };
      got.onclose = lost;
      got.onversionchange = () => {
        got.close();
        lost();
      };
      resolve(got);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error("the takes kept could not be opened"));
    };
  });
  opened = mine;
  mine.catch(() => {
    if (opened === mine) opened = null;
  });
  return mine;
}

/** A transaction on the takes kept, on a connection opened anew if the one held has closed. */
async function begin(mode: IDBTransactionMode): Promise<IDBTransaction> {
  try {
    return (await db()).transaction(STORE, mode);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "InvalidStateError")) throw error;
    opened = null;
    return (await db()).transaction(STORE, mode);
  }
}

/** The hex SHA-256 of `gabc`, the key its takes are kept under. */
export async function chantKey(gabc: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(gabc));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function pack(chant: string, take: Kept): Stored {
  return {
    chant,
    at: take.at,
    notes: take.notes,
    bands: take.bands.map((b) => ({ ...b, trace: Float32Array.from(b.trace.flat()) })),
  };
}

export function unpack(stored: Stored): Kept {
  return {
    at: stored.at,
    notes: stored.notes,
    bands: stored.bands.map((b) => {
      const trace: Array<[number, number]> = [];
      for (let i = 0; i + 1 < b.trace.length; i += 2) trace.push([b.trace[i]!, b.trace[i + 1]!]);
      return { ...b, trace };
    }),
  };
}

/** Resolves when `tx` has committed. */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("the takes kept could not be changed"));
  });
}

/** The take kept of chant `chant` (a [`chantKey`]) when the chant has the notes `notes` (see
 * [`notesOf`]), as it had when that take was sung. */
export async function kept(chant: string, notes: string): Promise<Kept | null> {
  const tx = await begin("readonly");
  const got = tx.objectStore(STORE).get(chant);
  await done(tx);
  const stored = got.result as Stored | undefined;
  return stored && stored.notes === notes ? unpack(stored) : null;
}

/** Whether any take is kept. */
export async function anyKept(): Promise<boolean> {
  const tx = await begin("readonly");
  const count = tx.objectStore(STORE).count();
  await done(tx);
  return count.result > 0;
}

/** Keeps `take` as the last of chant `chant` (a [`chantKey`]), unless the take kept of it went
 * further: a take stopped short does not replace a fuller one of the same notes. Past [`KEEP`]
 * chants, the ones sung longest ago go, never this one. */
export async function keep(chant: string, take: Kept): Promise<void> {
  const tx = await begin("readwrite");
  let put = false;
  const store = tx.objectStore(STORE);
  const got = store.get(chant);
  got.onsuccess = () => {
    const was = got.result as Stored | undefined;
    if (was && was.notes === take.notes && was.bands.length > take.bands.length) return;
    store.put(pack(chant, take));
    put = true;
    const count = store.count();
    count.onsuccess = () => {
      let over = count.result - KEEP;
      if (over <= 0) return;
      const oldest = store.index("at").openCursor();
      oldest.onsuccess = () => {
        const cursor = oldest.result;
        if (!cursor || over <= 0) return;
        if (cursor.primaryKey !== chant) {
          cursor.delete();
          over--;
        }
        cursor.continue();
      };
    };
  };
  await done(tx);
  if (put) tell("kept");
}

/** What a tab tells the others of the takes kept. */
export type News = "kept" | "forgotten";

/** This tab's end of the channel every tab hears news on, opened once: a channel object hears
 * every other's news, never its own, so a tab is not told what it did. Null where the browser
 * has none, and other tabs find out at their next take. */
let channel: BroadcastChannel | null | undefined;
function news(): BroadcastChannel | null {
  if (channel === undefined) {
    try {
      channel = new BroadcastChannel(CHANNEL);
    } catch {
      channel = null;
    }
  }
  return channel;
}

/** Tells every other tab of this page `what` happened: a take kept, or the takes forgotten. */
function tell(what: News): void {
  news()?.postMessage(what);
}

/** Forgets every take kept, and tells every other tab of this page. */
export async function forget(): Promise<void> {
  const tx = await begin("readwrite");
  tx.objectStore(STORE).clear();
  await done(tx);
  tell("forgotten");
}

/** Calls `then` with the news whenever another tab keeps a take or forgets the takes kept. */
export function onNews(then: (news: News) => void): void {
  const heard = news();
  if (heard) heard.onmessage = (event: MessageEvent<News>) => then(event.data);
}

/** The English the browser prefers, else British: the page is in English, so its dates are. */
export function english(): string {
  const preferred = typeof navigator === "undefined" ? [] : (navigator.languages ?? []);
  return preferred.find((l) => /^en\b/i.test(l)) ?? "en-GB";
}

/** The hours the browser's own language writes times in: on a 12-hour clock or a 24-hour one. */
export function hours(): Intl.DateTimeFormatOptions["hourCycle"] {
  const language = typeof navigator === "undefined" ? undefined : navigator.language;
  try {
    return new Intl.DateTimeFormat(language, { hour: "numeric" }).resolvedOptions().hourCycle;
  } catch {
    return undefined;
  }
}

/** When a take kept at `at` was sung, as seen at `now` (both milliseconds since the epoch, in
 * the browser's time zone), in English as `locale` writes it, on the clock `hourCycle` names:
 * "today at 14:05", "yesterday at 9:30", "on 3 October", or with its year when that is not this
 * year's. */
export function whenSung(at: number, now: number, locale = english(), hourCycle = hours()): string {
  const sung = new Date(at);
  const today = new Date(now);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const time = sung.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", ...(hourCycle ? { hourCycle } : {}) });
  const days = Math.round((day(today) - day(sung)) / 86_400_000);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  const year = sung.getFullYear() === today.getFullYear() ? {} : { year: "numeric" as const };
  return `on ${sung.toLocaleDateString(locale, { day: "numeric", month: "long", ...year })}`;
}
