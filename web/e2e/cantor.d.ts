// The page's test hook (sing.ts, `?test=1`).
import type { Timeline } from "neuma";

declare global {
  interface Window {
    __cantor: {
      frames: Array<{ midi: number | null }>;
      timeline: Timeline;
      visited: number[];
      chunks: Array<[number, number, number]>;
      voice: "neutral" | "recorded" | "none";
      heard: () => Promise<{ seconds: number; frames: number; onset: number | null; swiftFrames: number; swiftMs: number }> | undefined;
      judge: (gabc: string, pulse: number, offset: number) => Promise<string>;
    };
  }
}

export {};
