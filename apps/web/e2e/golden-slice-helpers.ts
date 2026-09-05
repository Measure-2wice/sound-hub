// BG7 (ticket #65) — Golden Slice Playwright helpers.
//
// Shared assertion used by the integrated browser journey to
// strengthen the audio playback evidence beyond a bare `<audio
// src=...>` element. The journey in `golden-slice.spec.ts` is the
// single source of truth for the BG7 acceptance; this module is
// only a thin typed wrapper around the same Playwright primitives.
//
// Helpers exported here:
//   - assertAudioPlaybackUsable: wait for the GET playback
//     response, assert 200 + audio/mpeg, drive the <audio>
//     element to HAVE_FUTURE_DATA via `loadeddata`/`canplay`,
//     best-effort attempt play(). NEVER asserts physical speaker
//     output.
//
// This module is the single implementation of that proof.

import { expect, type Page } from "@playwright/test";

export interface AudioUsabilityResult {
  readonly status: number;
  readonly contentType: string;
  readonly readyState: number;
  readonly playOutcome: "ok" | "autoplay-blocked" | "error";
}

export async function assertAudioPlaybackUsable(input: {
  readonly page: Page;
  readonly playerLocator: ReturnType<Page["getByTestId"]>;
  readonly timeoutMs?: number;
}): Promise<AudioUsabilityResult> {
  const timeoutMs = input.timeoutMs ?? 15_000;

  const playbackUrl = await input.playerLocator.evaluate((el: HTMLAudioElement) => el.src);
  const playbackResponsePromise = input.page.waitForResponse(
    (response) => response.url() === playbackUrl,
    { timeout: timeoutMs },
  );
  const readyStatePromise = input.playerLocator.evaluate((el: HTMLAudioElement) => {
    return new Promise<number>((resolve, reject) => {
      if (el.readyState >= 3) {
        resolve(el.readyState);
        return;
      }
      const onReady = () => {
        cleanup();
        resolve(el.readyState);
      };
      const onError = () => {
        cleanup();
        reject(new Error(`audio error: code=${el.error?.code ?? "unknown"}`));
      };
      const t = setTimeout(() => {
        cleanup();
        reject(new Error("audio loadability timeout"));
      }, 10_000);
      function cleanup(): void {
        clearTimeout(t);
        el.removeEventListener("loadeddata", onReady);
        el.removeEventListener("canplay", onReady);
        el.removeEventListener("error", onError);
      }
      el.addEventListener("loadeddata", onReady);
      el.addEventListener("canplay", onReady);
      el.addEventListener("error", onError);
      el.load();
    });
  });
  const [playbackResponse, readyState] = await Promise.all([
    playbackResponsePromise,
    readyStatePromise,
  ]);
  expect(playbackResponse.status()).toBe(200);
  const contentType = playbackResponse.headers()["content-type"] ?? "";
  expect(contentType).toMatch(/audio\/mpeg/);
  expect(readyState).toBeGreaterThanOrEqual(3);

  const playOutcome = await input.playerLocator.evaluate(async (el: HTMLAudioElement) => {
    try {
      await el.play();
      return "ok" as const;
    } catch (err) {
      const name = (err as { name?: string }).name ?? "unknown";
      return name === "NotAllowedError" ? ("autoplay-blocked" as const) : ("error" as const);
    }
  });
  expect(playOutcome).not.toBe("error");

  return {
    status: playbackResponse.status(),
    contentType,
    readyState,
    playOutcome,
  };
}
