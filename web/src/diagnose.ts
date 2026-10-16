// What /diagnostics makes of what it heard: the browser named from its user agent, how long
// each beep took to come back through the microphone, levels, and the report as text.

/** A frame as the ear tracks it (ear/worker.ts `Frame`): its centre on the audio clock, the
 * pitch heard as a MIDI number or null, and its RMS. */
export interface Heard {
  t: number;
  midi: number | null;
  rms: number;
}

/** The browser and system `ua` names, as a person would say them. Browsers now freeze some of
 * it (Chrome on Android says Android 10, every Mac says 10.15.7), so it is what the user agent
 * says, not always what runs. An iPad asking for desktop
 * pages says it is a Mac; `touch` (a touch screen) tells it apart. On iOS every browser is
 * Safari's engine underneath. */
export function browserOf(ua: string, touch = false): string {
  const at = (re: RegExp) => re.exec(ua)?.[1];
  const ios = at(/(?:iPhone|iPad|iPod)[^)]*? OS (\d+(?:_\d+)*)/)?.replace(/_/g, ".");
  const mac = at(/Mac OS X (\d+(?:[._]\d+)*)/)?.replace(/_/g, ".");
  const android = at(/Android (\d+(?:\.\d+)*)/);
  const system = ios
    ? `iOS ${ios}`
    : android
      ? `Android ${android}`
      : mac
        ? touch
          ? "an iPad (as a Mac)"
          : `macOS ${mac}`
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "an unknown system";
  const named: Array<[RegExp, string]> = [
    [/EdgA?\/(\d+)/, "Edge"],
    [/EdgiOS\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
    [/CriOS\/(\d+)/, "Chrome"],
    [/FxiOS\/(\d+)/, "Firefox"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Version\/(\d+(?:\.\d+)?).*Safari\//, "Safari"],
  ];
  const found = named.find(([re]) => re.test(ua));
  const browser = found ? `${found[1]} ${at(found[0])}` : "An unknown browser";
  const webkit = (ios || (mac && touch)) && found?.[1] !== "Safari" ? " (Safari's engine)" : "";
  return `${browser}${webkit} on ${system}`;
}

/** For each beep that began at a time in `beeps` (on the audio clock), how long until a frame
 * heard its pitch, `midi`, within a semitone, looking no further than `window` seconds; null
 * where none did. A frame is about 43 ms long and they come every 30 ms, so each is within
 * about 15 ms; beeps that fall at different places between frames do better together. */
export function echoes(frames: readonly Heard[], beeps: readonly number[], midi: number, window: number): Array<number | null> {
  return beeps.map((at) => {
    const frame = frames.find((f) => f.t >= at && f.t < at + window && f.midi !== null && Math.abs(f.midi - midi) <= 1);
    return frame ? frame.t - at : null;
  });
}

/** The middle of `xs`, or null when there are none. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** `rms` in decibels below full scale, as words. */
export function level(rms: number | null): string {
  if (rms === null) return "not heard";
  if (!(rms > 0)) return "silence";
  return `${Math.round(20 * Math.log10(rms))} dBFS`;
}

/** Seconds as milliseconds, or "not said" when the browser gave nothing. */
export function ms(seconds: unknown): string {
  return typeof seconds === "number" && Number.isFinite(seconds) ? `${Math.round(seconds * 1000)} ms` : "not said";
}

/** A processing step the page asked the browser to turn off: what the track says it is, and
 * what the browser says it could be (`can`, the track's capability, when it says). */
export function processing(on: unknown, can: unknown): string {
  if (on === false) return "off";
  if (on !== true) return "not said";
  const could = Array.isArray(can) ? (can.includes(false) ? "; the browser says it can be" : "; the browser says it cannot be") : "";
  return `on, though the page asked for it off${could}`;
}

/** The report as plain text, a row a line. */
export function asText(rows: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
}
