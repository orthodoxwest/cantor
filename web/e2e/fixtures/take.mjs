// Writes a synthetic take for the fake microphone with `cantor take`, and what `cantor eval`
// heard of it: student-notes' first take, its faults planted, with silence either side.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TAKE_WAV = fileURLToPath(new URL("take.wav", import.meta.url));
export const TAKE_JSON = fileURLToPath(new URL("take.json", import.meta.url));
export const PAD_S = 2;

export function makeTake() {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const json = execFileSync(
    "cargo",
    ["run", "-q", "-p", "cantor-cli", "--", "take", "student-notes", "0", "--pad", String(PAD_S), "-o", TAKE_WAV],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  writeFileSync(TAKE_JSON, json);
}

/** The take's chant and timing, and what the eval heard. */
export const readTake = () => JSON.parse(readFileSync(TAKE_JSON, "utf8"));

/** The take's length in seconds, from its WAV header. */
export function takeSeconds() {
  const wav = readFileSync(TAKE_WAV);
  return wav.readUInt32LE(40) / wav.readUInt32LE(28);
}
