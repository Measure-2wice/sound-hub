import { expect, test } from "@playwright/test";
import { assertAudioPlaybackUsable } from "./golden-slice-helpers";

test("BG7 audio proof rejects a truncated audio/mpeg response", async ({ page }) => {
  const fixturePath = "/__bg7-truncated-audio.mp3";
  await page.route(`**${fixturePath}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      body: Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    });
  });

  await page.goto("/");
  await page.locator("body").evaluate((body, src) => {
    const audio = document.createElement("audio");
    audio.dataset.testid = "truncated-audio-player";
    audio.src = src;
    body.append(audio);
  }, fixturePath);

  await expect(
    assertAudioPlaybackUsable({
      page,
      playerLocator: page.getByTestId("truncated-audio-player"),
    }),
  ).rejects.toThrow(/audio error|loadability timeout/);
});
