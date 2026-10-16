// When each note of a take falls, as cantor-core times them (timeline.rs `notes_from_gabc`):
// one pulse per weight unit, recitation at speech pace. The guide sings and the cursor moves
// to these times, so a take sung with them is judged against the times it was sung to.
import type { TimelineNote } from "neuma";

/** A recited note's length, in pulses (cantor-core's `RECITATION`). */
export const RECITATION = 0.6;

/** A note's start and length, in seconds from the first note's pulse 0. */
export interface Timed {
  start: number;
  duration: number;
}

/** The notes' times at `pulse` seconds a pulse: each starts where the last ended plus the
 * pause the timeline left between them, and a recited note lasts [`RECITATION`] of its
 * weight. */
export function timed(notes: readonly TimelineNote[], pulse: number): Timed[] {
  let clock = 0;
  let prevEnd = 0;
  return notes.map((n, i) => {
    const gap = i === 0 ? n.start : Math.max(n.start - prevEnd, 0);
    prevEnd = n.start + n.duration;
    const duration = n.recitation ? n.duration * RECITATION : n.duration;
    clock += gap;
    const at = { start: clock * pulse, duration: duration * pulse };
    clock += duration;
    return at;
  });
}

/** The note sounding at `t` seconds, or the last one begun (in the pause after it); -1 before
 * the first. */
export function noteAt(times: readonly Timed[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]!.start <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** How far the singer's first sound may be from where the first note was due, in seconds,
 * for the take to be timed by it. */
export const ONSET_WINDOW = 1;

/** When the take's first note starts, in seconds of the take: where the singer first sounded,
 * if that is within [`ONSET_WINDOW`] of where the note was due (`due`), else when it was due.
 * The singer follows the guide or the cursor a little late, and the first sound is the
 * truest measure of how late. */
export function firstNoteAt(due: number, onset: number | null): number {
  return onset !== null && Math.abs(onset - due) <= ONSET_WINDOW ? onset : due;
}

/** Output devices whose name says they are worn. */
const WORN = /head(phone|set)|ear(bud|phone|pod)|airpods|\bbuds/i;

/** Whether the audio goes to headphones, from the devices the browser lists: null when it does
 * not say (no outputs listed, or none named, as before the microphone is allowed). */
export function headphonesIn(devices: readonly Pick<MediaDeviceInfo, "kind" | "label" | "deviceId">[]): boolean | null {
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  if (outputs.length === 0 || outputs.every((d) => !d.label)) return null;
  const current = outputs.find((d) => d.deviceId === "default") ?? outputs[0]!;
  return WORN.test(current.label);
}
