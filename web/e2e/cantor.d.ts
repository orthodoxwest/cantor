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
      heard: () => Promise<{ seconds: number; sampleRate: number; frames: number; onset: number | null; busy: number; stopMs: number }> | undefined;
      practise: (gabc: string, pulse: number) => void;
      timed: (pulse: number) => Array<{ start: number; duration: number }>;
      show: (gabc: string, pulse: number, offset: number) => Promise<string>;
    };
  }
}

export {};
