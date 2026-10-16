import type { TimelineNote } from "neuma";
import { describe, expect, it } from "vitest";
import { headphonesIn, noteAt, RECITATION, timed } from "../src/timing";

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
