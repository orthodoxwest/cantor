// A chant's aligned recording as a third voice beside the guide and the singer's take: its sound,
// which the Worker gives a signed-in singer, played over the notes chosen with the cursor where
// the recording sang each, as its ribbon's bands time them (`cantor recording`).
import { span, type Band } from "./ribbon";
import type { Timed } from "./timing";

/** When the recording sang each of a chant's `count` notes, in seconds of its sound, from its
 * `bands`: the whole note, or for bands seeded with only the sustained part, that part. None when
 * the bands are not the chant's notes, one a note in order. */
export function recordedTimes(bands: readonly Band[], count: number): Timed[] | null {
  if (count === 0 || bands.length !== count || bands.some((band, i) => band.index !== i)) return null;
  return bands.map((band) => {
    const [start, end] = span(band);
    return { start, duration: Math.max(end - start, 0) };
  });
}

/** The recording's sound at `url`, fetched and decoded the first time it is heard and kept for
 * the next (`kept` once it is in hand); one that failed is fetched again the next time. */
export function recordingSound(url: string): { sound: (ctx: BaseAudioContext) => Promise<AudioBuffer>; kept: () => boolean } {
  let decoded: Promise<AudioBuffer> | null = null;
  let kept = false;
  return {
    kept: () => kept,
    sound: (ctx) => {
      if (!decoded) {
        const pending = fetch(url).then(async (res) => {
          if (!res.ok) throw new Error(`the library answered ${res.status}`);
          return ctx.decodeAudioData(await res.arrayBuffer());
        });
        pending.then(
          () => {
            kept = decoded === pending;
          },
          () => {
            if (decoded === pending) decoded = null;
          },
        );
        decoded = pending;
      }
      return decoded;
    },
  };
}
