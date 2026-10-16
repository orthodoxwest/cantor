// Writes the fake microphone's input: a 440 Hz sine, 3 s, 48 kHz, 16-bit mono WAV.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WAV_PATH = fileURLToPath(new URL("sine-440.wav", import.meta.url));

export function makeSine(path = WAV_PATH, f = 440, seconds = 3, sampleRate = 48000) {
  const frames = seconds * sampleRate;
  const buf = Buffer.alloc(44 + frames * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * f * i) / sampleRate)), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

/** Playwright's globalSetup: the sine, and the synthetic take (see take.mjs). */
export default async () => {
  makeSine();
  (await import("./take.mjs")).makeTake();
};
