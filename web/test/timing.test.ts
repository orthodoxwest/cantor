import type { TimelineNote } from "neuma";
import { describe, expect, it } from "vitest";
import { headphonesIn, noteAt, RECITATION, throughHeard, timed } from "../src/timing";

const note = (start: number, duration: number, recitation = false) => ({ start, duration, recitation }) as TimelineNote;

describe("timing", () => {
  it("times notes as the core does: recitation at speech pace, pauses kept", () => {
    // Two recited notes, a pause of two pulses, then a sung note.
    const notes = [note(0, 1, true), note(1, 1, true), note(4, 2)];
    const at = timed(notes, 0.5);
    expect(at.map((a) => a.start)).toEqual([0, RECITATION * 0.5, 2 * RECITATION * 0.5 + 2 * 0.5]);
    expect(at.map((a) => a.duration)).toEqual([RECITATION * 0.5, RECITATION * 0.5, 1]);
  });

  it("finds the note sounding, or the last begun", () => {
    const at = timed([note(0, 1), note(1, 1), note(3, 1)], 1);
    expect([-0.1, 0, 0.99, 1, 2.5, 3.2, 9].map((t) => noteAt(at, t))).toEqual([-1, 0, 0, 1, 1, 2, 2]);
  });

  it("knows headphones by the output's name, and says when it cannot tell", () => {
    const out = (label: string, deviceId = "default") => ({ kind: "audiooutput" as const, label, deviceId });
    const mic = { kind: "audioinput" as const, label: "Headset microphone", deviceId: "default" };
    expect(headphonesIn([mic, out("Default - Headphones (Built-in)")])).toBe(true);
    expect(headphonesIn([out("Default - MacBook Pro Speakers"), out("AirPods Pro", "x")])).toBe(false);
    expect(headphonesIn([out("Galaxy Buds2", "x")])).toBe(true);
    expect(headphonesIn([out("")])).toBeNull();
    // A laptop's one output, named for both whatever is plugged in.
    expect(headphonesIn([out("Speakers/Headphones (Realtek(R) Audio)")])).toBeNull();
    // A headset whose output the system calls its speakers.
    expect(headphonesIn([out("Speakers (Logitech PRO X Gaming Headset)")])).toBe(true);
    expect(headphonesIn([mic])).toBeNull();
  });
});

describe("the last note sung whole", () => {
  // Two phrases of two half-second notes, half a second apart, from 0.2 s into the take: the
  // cases eval.rs's `through_heard` is held to, so that a take stopped is judged as the eval
  // judges one.
  const times = [
    { start: 0, duration: 0.5 },
    { start: 0.5, duration: 0.5 },
    { start: 1.5, duration: 0.5 },
    { start: 2, duration: 0.5 },
  ];
  const end = (i: number) => 0.2 + times[i]!.start + times[i]!.duration;
  const mid = (i: number) => 0.2 + times[i]!.start + times[i]!.duration / 2;

  it("is the last of the notes, in order, ended when the take was stopped", () => {
    expect(throughHeard(times, 0.2, 0)).toBeNull();
    expect(throughHeard(times, 0.2, mid(0))).toBeNull();
    expect(throughHeard(times, 0.2, end(0))).toBe(0);
    expect(throughHeard(times, 0.2, mid(3))).toBe(2);
    // In the pause after a phrase, and halfway through the next phrase's first note.
    expect(throughHeard(times, 0.2, end(1) + 0.25)).toBe(1);
    expect(throughHeard(times, 0.2, mid(2))).toBe(1);
    expect(throughHeard(times, 0.2, 1e4)).toBe(3);
    expect(throughHeard([], 0, 1e4)).toBeNull();
  });
});
