// One AudioContext for the page, made on the first user gesture that needs it.
let context: AudioContext | undefined;

export async function audioContext(): Promise<AudioContext> {
  context ??= new AudioContext();
  if (context.state !== "running") await context.resume();
  return context;
}
