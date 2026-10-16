import { defineConfig } from "@playwright/test";
import { WAV_PATH } from "./e2e/fixtures/make-sine.mjs";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/fixtures/make-sine.mjs",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    browserName: "chromium",
    permissions: ["microphone"],
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${WAV_PATH}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: {
    command: "npm run build && npm run preview",
    url: "http://localhost:4173/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
