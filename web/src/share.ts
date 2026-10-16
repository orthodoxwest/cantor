// The page's state in its address, so a pointing can be shared or bookmarked:
// #psalm=23&tone=8.G, plus the pointed text (deflated, base64url) once it has been edited.

export interface Shared {
  /** A psalter id ("23", "119-iv"), or "own" for typed text. */
  psalm: string;
  tone: string;
  gloria: boolean;
  /** Semitones. */
  transpose: number;
  /** The verses sung, by number, or null for the whole psalm. */
  verses?: [number, number] | null;
  /** Typed text, for the "own" psalm. */
  own?: string;
  /** The pointed text, when it differs from what pointing the source would give. */
  text?: string;
  /** A booklet setting's id, when its pointing is shown. */
  setting?: string;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  // In slices: String.fromCharCode takes a bounded number of arguments.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const fromBase64Url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function packText(text: string): Promise<string> {
  return toBase64Url(await pipe(new TextEncoder().encode(text), new CompressionStream("deflate-raw")));
}

export async function unpackText(packed: string): Promise<string> {
  return new TextDecoder().decode(await pipe(fromBase64Url(packed), new DecompressionStream("deflate-raw")));
}

export async function encode(state: Shared): Promise<string> {
  const params = new URLSearchParams({ psalm: state.psalm, tone: state.tone });
  if (!state.gloria) params.set("gloria", "0");
  if (state.transpose) params.set("pitch", String(state.transpose));
  if (state.verses) params.set("verses", state.verses.join("-"));
  if (state.setting) params.set("setting", state.setting);
  if (state.own !== undefined) params.set("own", await packText(state.own));
  if (state.text !== undefined) params.set("text", await packText(state.text));
  return "#" + params.toString();
}

/** The state in a hash, or null for one this page didn't write. */
export async function decode(hash: string): Promise<Shared | null> {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const psalm = params.get("psalm");
  const tone = params.get("tone");
  if (!psalm) return null;
  const transpose = Number(params.get("pitch") ?? 0);
  const range = params.get("verses")?.match(/^(\d+)-(\d+)$/);
  const verses: [number, number] | null = range ? [Number(range[1]), Number(range[2])] : null;
  const unpack = async (name: string) => {
    const packed = params.get(name);
    if (!packed) return undefined;
    try {
      return await unpackText(packed);
    } catch {
      return undefined;
    }
  };
  const text = await unpack("text");
  const own = await unpack("own");
  return {
    psalm,
    tone: tone ?? "",
    gloria: params.get("gloria") !== "0",
    transpose: Number.isInteger(transpose) && Math.abs(transpose) <= 7 ? transpose : 0,
    verses,
    ...(own !== undefined ? { own } : {}),
    ...(params.get("setting") ? { setting: params.get("setting")! } : {}),
    text,
  };
}
