// Pitch arithmetic shared by the guide and the readout. MIDI 69 is A4 at 440 Hz.

/** The MIDI number of the clef's do: C4. */
export const DO = 60;

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

export const midiToFreq = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** A pitch as its nearest note name and the offset from it in cents, "A4 +3¢". */
export function describePitch(midi: number): string {
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  const name = `${NAMES[((nearest % 12) + 12) % 12]}${Math.floor(nearest / 12) - 1}`;
  return `${name} ${cents >= 0 ? "+" : "−"}${Math.abs(cents)}¢`;
}
