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

/** The last note sung whole in a take stopped `heard` seconds in, its notes at `times` from
 * `offset` seconds: the last of them, in order, ended by then; null when the first had not. As
 * `cantor eval` reads it (eval.rs `through_heard`), so that its stopped takes are judged as the
 * page judges them. */
export function throughHeard(times: readonly Timed[], offset: number, heard: number): number | null {
  let through = -1;
  while (through + 1 < times.length && offset + times[through + 1]!.start + times[through + 1]!.duration <= heard) through++;
  return through < 0 ? null : through;
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

/** How late the singer's first sound may be from where the first note was due, in seconds,
 * for the take to be timed by it (cantor-core's `ONSET_WINDOW`, entry.rs, which times it). */
export const ONSET_WINDOW = 1;

/** Output devices whose name says they are worn. */
const WORN = /head(phone|set)|ear(bud|phone|pod)|airpods|\bbuds/i;
/** An output named for speakers and headphones at once, whatever is plugged in. */
const BOTH = /speakers?\s*\/\s*head(phone|set)|head(phone|set)s?\s*\/\s*speaker/i;

/** Whether the audio goes to headphones, from the devices the browser lists: null when it does
 * not say (no outputs listed, or none named, as before the microphone is allowed, or a name
 * that is both, as "Speakers/Headphones" is whatever is plugged in). */
export function headphonesIn(devices: readonly Pick<MediaDeviceInfo, "kind" | "label" | "deviceId">[]): boolean | null {
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  if (outputs.length === 0 || outputs.every((d) => !d.label)) return null;
  const current = outputs.find((d) => d.deviceId === "default") ?? outputs[0]!;
  if (BOTH.test(current.label)) return null;
  return WORN.test(current.label);
}
