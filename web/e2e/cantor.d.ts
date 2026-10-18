// The page's test hook (sing.ts, `?test=1`).
import type { Timeline } from "neuma";

declare global {
  interface Window {
    __cantor: {
      frames: Array<{ midi: number | null }>;
      timeline: Timeline;
      visited: number[];
      following: boolean;
      chunks: Array<[number, number, number]>;
      pitch: number[];
      cued: number[];
      drone: number | null;
      drones: number;
      centre: number | null;
      loop: [number, number] | null;
      replayed: { visited: number[]; playing: boolean; decodes: number };
      recorded: { visited: number[]; playing: boolean };
      played: { midi: number[]; plays: number };
      sung: Array<{ midi: number; start: number; duration: number }>;
      voice: "neutral" | "recorded" | "none";
      heard: () =>
        | Promise<{ seconds: number; sampleRate: number; frames: number; onset: number | null; startedAt: number | null; busy: number; stopMs: number }>
        | undefined;
      listen: () => Promise<void>;
      listenAgain: () => Promise<void>;
      showAgain: (first: number, last: number, pulse: number, offset: number) => Promise<string | null>;
      again: { run: [number, number]; key: number } | null;
      take: () => { due: number; sound: number | null; at: number } | null;
      practise: (gabc: string, pulse: number) => void;
      timed: (pulse: number) => Array<{ start: number; duration: number }>;
      show: (gabc: string, pulse: number, offset: number, through?: number | null) => Promise<string>;
    };
  }
}

export {};
