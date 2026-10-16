// /diagnostics: whether this browser can be trusted with a take. On one tap it opens the
// microphone as the practice page does, then the audio context, and reports what the browser
// says of both; then it plays three beeps through the speaker and hears them with the ear,
// which times the round trip and gives the levels. The table may be copied, or sent to the
// Worker with nothing but the browser's name beside it.
import { audioContext } from "./audio";
import { asText, browserOf, echoes, level, median, ms, processing } from "./diagnose";
import { Listener } from "./listen";
import { headphonesIn } from "./timing";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const checkButton = byId<HTMLButtonElement>("check");
const statusLine = byId<HTMLParagraphElement>("status");
const report = byId<HTMLElement>("report");
const table = byId<HTMLTableElement>("table");
const sent = byId<HTMLSpanElement>("sent");
const sendButton = byId<HTMLButtonElement>("send");
const actions = byId<HTMLParagraphElement>("actions");

/** The beeps: A5, in the ear's range and clear of a voice's fundamental. */
const BEEP_HZ = 880;
const BEEP_MIDI = 81;
const BEEPS = 3;
const BEEP_S = 0.2;
/** From one beep's start to the next's; a beep later than this is not heard as its own. Not a
 * whole number of the ear's 30 ms hops, so the beeps fall at different places between frames
 * and their mean is closer than any one. */
const EVERY_S = 1.21;
/** How long the room is heard before the first beep, and listening goes on after the last. */
const ROOM_S = 1.2;
const TAIL_S = 1.0;

type Row = [string, string];
let rows: Row[] = [];
const newListener = () =>
  new Listener(
    () => {},
    (error) => (failure = error),
  );
/** Replaced when its ear does not finish, since the next take would wait on it. */
let listener = newListener();
let failure: Error | undefined;

function setStatus(text: string, error = false): void {
  statusLine.textContent = text;
  statusLine.classList.toggle("error", error);
}

function show(): void {
  table.replaceChildren(
    ...rows.map(([label, value]) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = label;
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(th, td);
      return tr;
    }),
  );
  report.hidden = rows.length === 0;
}

const wait = (s: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, s) * 1000));
const hz = (x: unknown) => (typeof x === "number" && x > 0 ? `${x} Hz` : "not said");

/** The context, or null when it does not start within a few seconds (a browser that wants a
 * tap it no longer counts). */
async function context(): Promise<AudioContext | null> {
  return Promise.race([audioContext(), wait(4).then(() => null)]);
}

async function check(): Promise<void> {
  checkButton.disabled = true;
  failure = undefined;
  actions.hidden = true;
  sent.textContent = "";
  sendButton.hidden = false;
  rows = [
    ["Browser", browserOf(navigator.userAgent, navigator.maxTouchPoints > 1)],
    ["User agent", navigator.userAgent],
  ];
  // Chromium's user agent freezes the system's version; it says it when asked.
  const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ platform?: string; platformVersion?: string }> } }).userAgentData;
  const platform = await data?.getHighEntropyValues(["platformVersion"]).catch(() => undefined);
  // Windows gives its own numbering: 13 and later is Windows 11.
  const version = platform?.platformVersion;
  if (version)
    rows.push([
      "System version",
      platform?.platform === "Windows" ? (parseInt(version) >= 13 ? "Windows 11" : "Windows 10 or earlier") : `${platform?.platform ?? ""} ${version}`.trim(),
    ]);
  show();
  setStatus("Opening the microphone…");
  let stream: MediaStream | undefined;
  try {
    // As the practice page asks for it.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (error) {
    rows.push(["Microphone", `not opened: ${(error as Error).name || error}`]);
    show();
    setStatus("The microphone could not be opened, so nothing more can be checked.", true);
    actions.hidden = false;
    checkButton.disabled = false;
    return;
  }
  try {
    await measure(stream);
    // Set by the listener while measuring, which the compiler does not see.
    const failed = failure as Error | undefined;
    setStatus(failed ? `The ear failed: ${failed.message}` : "Done. Copy the table, or send it.", failed !== undefined);
  } catch (error) {
    rows.push(["Stopped by", String((error as Error).message || error)]);
    setStatus(`The check stopped: ${(error as Error).message || error}`, true);
  } finally {
    listener.stop();
    stream.getTracks().forEach((track) => track.stop());
    show();
    actions.hidden = false;
    checkButton.textContent = "Check again";
    checkButton.disabled = false;
  }
}

async function measure(stream: MediaStream): Promise<void> {
  const track = stream.getAudioTracks()[0];
  const settings = (track?.getSettings() ?? {}) as MediaTrackSettings & { latency?: number };
  const can = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
  // After the microphone: a phone may set its audio up differently once it is capturing.
  const ctx = await context();
  rows.push(
    ["Microphone rate", hz(settings.sampleRate)],
    ["Audio context rate", ctx ? hz(ctx.sampleRate) : "would not start"],
    ["Input latency", ms(settings.latency)],
    ["Base latency", ms(ctx?.baseLatency)],
    ["Output latency", ms(ctx?.outputLatency)],
    ["Echo cancellation", processing(settings.echoCancellation, can.echoCancellation)],
    ["Noise suppression", processing(settings.noiseSuppression, can.noiseSuppression)],
    ["Auto gain", processing(settings.autoGainControl, can.autoGainControl)],
  );
  let route = "not said";
  try {
    const worn = headphonesIn(await navigator.mediaDevices.enumerateDevices());
    if (worn !== null) route = worn ? "headphones" : "speaker";
  } catch {
    // Not said.
  }
  rows.push(["Output", route]);
  const session = (navigator as Navigator & { audioSession?: { type?: string } }).audioSession?.type;
  if (session) rows.push(["Audio session", session]);
  show();
  if (!ctx) throw new Error("the audio context would not start");
  // The ear opens the microphone again as a take does; one capture at a time.
  stream.getTracks().forEach((track) => track.stop());

  setStatus("Listening to the room, then three beeps…");
  await listener.start();
  const first = ctx.currentTime + ROOM_S;
  const beeps = Array.from({ length: BEEPS }, (_, i) => first + i * EVERY_S);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const osc = ctx.createOscillator();
  osc.frequency.value = BEEP_HZ;
  osc.connect(gain).connect(ctx.destination);
  for (const at of beeps) {
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.5, at + 0.01);
    gain.gain.setValueAtTime(0.5, at + BEEP_S - 0.01);
    gain.gain.linearRampToValueAtTime(0, at + BEEP_S);
  }
  const end = beeps.at(-1)! + EVERY_S;
  osc.start(first);
  osc.stop(end);
  // Waits on the audio clock, and no longer than twice the check's length by the wall's: a
  // phone call or a locked screen stops the clock.
  const deadline = performance.now() + 2000 * (end + TAIL_S - ctx.currentTime);
  try {
    while (ctx.currentTime < end + TAIL_S && listener.listening) {
      if (ctx.state !== "running" || performance.now() > deadline) throw new Error(`the audio stopped (${ctx.state})`);
      await wait(Math.min(0.25, end + TAIL_S - ctx.currentTime));
    }
  } finally {
    osc.disconnect();
    gain.disconnect();
    listener.stop();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const heard = await Promise.race([
    listener.heard?.catch((error: Error) => {
      failure ??= error;
      return undefined;
    }),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        failure ??= new Error("the ear did not finish");
        listener = newListener();
        resolve(undefined);
      }, 10_000);
    }),
  ]);
  clearTimeout(timer);

  const frames = listener.frames;
  const times = echoes(frames, beeps, BEEP_MIDI, EVERY_S - BEEP_S);
  const found = times.filter((t): t is number => t !== null);
  // The mean of those near the median, so a stray frame at the beep's pitch does not move it.
  const middle = median(found);
  const near = found.filter((t) => middle !== null && Math.abs(t - middle) <= 0.06);
  const trip = near.length ? near.reduce((a, b) => a + b) / near.length : null;
  rows.push([
    "Round trip",
    trip === null
      ? "beeps not heard (headphones in, the volume low, the room too loud, or the speaker cancelled)"
      : `${ms(trip)} (${found.length} of ${BEEPS} beeps heard${near.length < found.length ? `, ${found.length - near.length} set aside as stray` : ""})`,
  ]);
  const room = frames.filter((f) => f.t < first);
  rows.push(["Room level", level(median(room.map((f) => f.rms)))]);
  const beepFrames = frames.filter((f) => beeps.some((at) => f.t >= at && f.t < at + EVERY_S - BEEP_S) && f.midi !== null && Math.abs(f.midi - BEEP_MIDI) <= 1);
  rows.push(["Beeps heard at", level(median(beepFrames.map((f) => f.rms)))]);
  rows.push(["Loudest heard", level(frames.length ? Math.max(...frames.map((f) => f.rms)) : null)]);
  if (heard) rows.push(["Ear's load", `${Math.round(heard.busy * 100)}% of real time at ${heard.sampleRate} Hz`]);
}

checkButton.addEventListener("click", () => void check());

byId<HTMLButtonElement>("copy").addEventListener("click", async () => {
  const text = asText(rows);
  try {
    await navigator.clipboard.writeText(text);
    sent.textContent = "Copied.";
  } catch {
    sent.textContent = "This browser would not copy; select the table instead.";
  }
});

sendButton.addEventListener("click", async () => {
  sendButton.disabled = checkButton.disabled = true;
  sent.textContent = "Sending…";
  try {
    const res = await fetch("/api/diagnostics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    sent.textContent = "Sent. Thank you.";
    sendButton.hidden = true;
  } catch (error) {
    sent.textContent = `Not sent: ${(error as Error).message}`;
  } finally {
    sendButton.disabled = checkButton.disabled = false;
  }
});
