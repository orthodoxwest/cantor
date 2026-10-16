import type { TimelineNote } from "neuma";
import { describe, expect, it } from "vitest";
import { firstNoteAt, firstSound, headphonesIn, noteAt, RECITATION, timed } from "../src/timing";

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

  it("times the take by the singer's first sound when it is near where the note was due", () => {
    expect(firstNoteAt(1.6, 2.0)).toBe(2.0);
    expect(firstNoteAt(1.6, 1.5)).toBe(1.5);
    // Early, the singer holds the first note until the cursor moves.
    expect(firstNoteAt(1.6, 1.0)).toBe(1.6);
    expect(firstNoteAt(1.6, 2.7)).toBe(1.6);
    expect(firstNoteAt(1.6, null)).toBe(1.6);
  });

  it("hears the first sound where the voice holds, not at a click or a breath", () => {
    // Frames every 30 ms from 10.0 s on the audio clock: a click at frame 10, the voice from
    // frame 34 (1.02 s).
    const frames = Array.from({ length: 60 }, (_, i) => ({ t: 10 + i * 0.03, midi: i === 10 || i >= 34 ? 57 : null }));
    expect(firstSound(frames, 10, null)).toBeCloseTo(1.02, 6);
    // The first loud sample just before the first voiced frame sharpens it; one long before
    // (the room's noise) does not.
    expect(firstSound(frames, 10, 0.96)).toBe(0.96);
    expect(firstSound(frames, 10, 0.01)).toBeCloseTo(1.02, 6);
    // Times are from the take's own start.
    expect(firstSound(frames, 10.5, null)).toBeCloseTo(0.52, 6);
    expect(firstSound(frames.map((f) => ({ ...f, midi: null })), 10, 0.5)).toBeNull();
    // Humming through the lead is not the entry; the voice from 1.02 s is, when the first note
    // was due a little before it.
    const hummed = frames.map((f, i) => (i >= 10 && i < 20 ? { ...f, midi: 57 } : f));
    expect(firstSound(hummed, 10, null, 0.8)).toBeCloseTo(1.02, 6);
    // A voice already going when the note fell due gives no entry; a flicker across the bound
    // does not hide the entry after it.
    expect(firstSound(frames, 10, null, 1.1)).toBeNull();
    const flicker = frames.map((f, i) => (i === 26 || i === 27 ? { ...f, midi: 57 } : f));
    expect(firstSound(flicker, 10, null, 0.8)).toBeCloseTo(1.02, 6);
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
