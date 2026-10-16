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

/** How late the singer's first sound may be from where the first note was due, in seconds,
 * for the take to be timed by it. */
export const ONSET_WINDOW = 1;
/** And how early: a singer who starts early holds the first note until the cursor moves, so an
 * early sound says nothing of when the notes fall. */
export const ONSET_EARLY = 0.15;

/** When the take's first note starts, in seconds of the take: where the singer first sounded,
 * if that is within [`ONSET_EARLY`] before or [`ONSET_WINDOW`] after where the note was due
 * (`due`), else when it was due. The singer follows the guide or the cursor a little late, and
 * the first sound is the truest measure of how late. */
export function firstNoteAt(due: number, onset: number | null): number {
  return onset !== null && onset >= due - ONSET_EARLY && onset <= due + ONSET_WINDOW ? onset : due;
}

/** Voiced frames in a row that make a first sound, and not a click or a breath. */
const VOICED_RUN = 4;
/** How far before the first voiced frame's centre the first loud sample may be and still be
 * where the voice began, in seconds: half a frame and a hop. */
const SHARPEN = 0.1;

/** Where the singer first sounded, in seconds from `start` (the take's first sample, on the
 * frames' clock): the first of [`VOICED_RUN`] voiced frames in a row that begin at `from`
 * seconds or later, or the first loud sample (`loud`, in seconds of the take) when it falls
 * just before. Null when nothing was voiced then, or when the voice was already going at
 * `from` (a singer humming the opening notes through the lead), so the take is timed as due. */
export function firstSound(
  frames: readonly { t: number; midi: number | null }[],
  start: number,
  loud: number | null,
  from = 0,
): number | null {
  let run = 0;
  let before = false;
  for (const [i, frame] of frames.entries()) {
    if (frame.t < start + from) {
      before = frame.t >= start && frame.midi !== null;
      continue;
    }
    if (before && frame.midi !== null && run === 0) return null;
    before = false;
    run = frame.midi === null ? 0 : run + 1;
    if (run < VOICED_RUN) continue;
    const voiced = frames[i - VOICED_RUN + 1]!.t - start;
    return loud !== null && loud >= from && loud <= voiced && voiced - loud <= SHARPEN ? loud : voiced;
  }
  return null;
}

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
