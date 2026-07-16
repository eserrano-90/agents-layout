import fs from 'node:fs';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect, test } from '../../../fixtures/standalone';

/**
 * e2e coverage for the animated pet system (standalone browser harness).
 *
 * Pets render only on the canvas (no DOM nodes) and the heart bubble is pure
 * runtime state that is never persisted, so the live assertions read pet state
 * through `window.__pixelAgentsTestHooks.getPets()` / `.petClick()` — the same
 * state-driving approach `selectAgent` uses for characters (see
 * webview-ui/src/testHooks.ts and the comment on closeAgentFromOverlay in
 * e2e/helpers/office.ts). Pets spawn at a random walkable tile, so tests never
 * compute screen coordinates; they read pet ids/state back instead.
 *
 * Placement itself goes through the REAL UI path: clicking the Pets-tab
 * carousel button → onPetToggle → handlePetToggle → applyEdit. Only the
 * canvas-only interactions (hit-test geometry of getPetAt) are bypassed.
 *
 * Pets are a UI/webview feature with no hook dependency, so this spec runs
 * against the lighter standalone browser fixture: the UI *is* `page` (the SPA
 * served by `npx pixel-agents`) and server → client traffic is asserted via the
 * WebSocket recorder (`standalone.drainMessages()`). It lives under hooks-off
 * only for directory grouping; it never installs or drives hooks.
 */

interface PetSnapshot {
  id: string;
  name: string;
  petType: number;
  state: 'idle' | 'walk' | 'follow';
  x: number;
  y: number;
  bubbleType: 'heart' | null;
}

interface PetTestHooks {
  getPets?: () => PetSnapshot[];
  petClick?: (petId: string) => void;
}

type PetWindow = Window & { __pixelAgentsTestHooks?: PetTestHooks };

const PETS_CAROUSEL = '[data-testid="pets-carousel"]';

/**
 * Dismiss the first-run tooltips ("Instant Detection Active", "Updated to vN")
 * that overlay the top toolbar and would otherwise intercept the Layout click.
 * Mirrors the layout-editor smoke test in hooks-on/lifecycle.spec.ts.
 */
async function dismissFirstRunTooltips(page: Page): Promise<void> {
  for (const tooltipText of ['Instant Detection Active', 'Updated to v']) {
    const tooltip = page.locator('div', { hasText: tooltipText }).first();
    if (await tooltip.isVisible().catch(() => false)) {
      const closeBtn = tooltip.locator('button', { hasText: 'x' }).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click().catch(() => {});
      }
    }
  }
}

/** Enter edit mode and open the Pets tab; returns the carousel locator. */
async function openPetsTab(page: Page): Promise<Locator> {
  await dismissFirstRunTooltips(page);
  await page.locator('button[title="Edit office layout"]').click();
  await page.locator('button[title="Place pets"]').click();
  const carousel = page.locator(PETS_CAROUSEL);
  await expect(carousel).toBeVisible({ timeout: 15_000 });
  return carousel;
}

/** Point-in-time snapshot of every live pet, read from the test hook. */
async function readPets(page: Page): Promise<PetSnapshot[]> {
  return page.evaluate(() => {
    const w = window as PetWindow;
    return w.__pixelAgentsTestHooks?.getPets?.() ?? [];
  });
}

/** Toggle a pet's heart bubble exactly as a canvas click would. */
async function petClick(page: Page, petId: string): Promise<void> {
  await page.evaluate((id) => {
    (window as PetWindow).__pixelAgentsTestHooks?.petClick?.(id);
  }, petId);
}

/** Wait for the SPA shell to be interactive (Settings button rendered). */
async function waitForApp(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
}

test.describe('Pets', () => {
  test('pet sprites load, broadcast, and expose manifest names in the editor @area:pets', async ({
    page,
    standalone,
  }) => {
    // petSpritesLoaded is (re)broadcast on every webviewReady. The standalone
    // fixture drains the initial handshake during setup, so reload to force a
    // fresh handshake and capture the broadcast off the recorded WebSocket
    // stream. (The VS Code version read window.__pixelAgentsTestHooks.messageLog,
    // which the webview never populates; the recorder is the real message log.)
    await standalone.drainMessages();
    await page.reload();
    await waitForApp(page);
    await expect
      .poll(
        async () => {
          const messages = await standalone.drainMessages();
          return messages.some((message) => message.type === 'petSpritesLoaded');
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // The two bundled pets (claudio, gitcat) render as carousel thumbnails in
    // alphabetical order, each titled with its manifest `name`. Asserting the
    // count + both names covers "loaded" and "manifest names" together.
    const carousel = await openPetsTab(page);
    await expect(carousel.locator('button')).toHaveCount(2);
    await expect(carousel.locator('button[title="Claudio"]')).toBeVisible();
    await expect(carousel.locator('button[title="Gitcat"]')).toBeVisible();
  });

  test('placing a pet toggles it on/off and persists across a reload @area:pets', async ({
    page,
    standalone,
  }) => {
    const carousel = await openPetsTab(page);
    const claudio = carousel.locator('button[title="Claudio"]');
    const gitcat = carousel.locator('button[title="Gitcat"]');

    // Toggle ON: clicking the carousel button drives the real placement path.
    await claudio.click();
    await page.waitForFunction(() => {
      const pets = (window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? [];
      return pets.length === 1 && pets[0]?.petType === 0;
    });

    // Toggle OFF: clicking the same (now-active) button removes it.
    await claudio.click();
    await page.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 0,
    );

    // Place both pets, then persist via the EditActionBar Save button.
    await claudio.click();
    await gitcat.click();
    await page.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 2,
    );

    const saveBtn = page.locator('button', { hasText: 'Save' });
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
    await saveBtn.click();

    // The save round-trips through layoutPersistence to ~/.pixel-agents/layout.json
    // (under the standalone fixture's isolated HOME). Pets are opaque pass-through
    // server-side.
    const layoutPath = path.join(standalone.tmpHome, '.pixel-agents', 'layout.json');
    await expect
      .poll(
        () => {
          if (!fs.existsSync(layoutPath)) return -1;
          try {
            const parsed = JSON.parse(fs.readFileSync(layoutPath, 'utf8')) as {
              pets?: unknown[];
            };
            return Array.isArray(parsed.pets) ? parsed.pets.length : -1;
          } catch {
            return -1;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(2);

    // Reload the SPA. The WebSocket reconnects, the server re-sends layoutLoaded
    // from ~/.pixel-agents/layout.json, and the pets rehydrate from disk. (The VS
    // Code version toggled the bottom panel to force a fresh resolveWebviewView;
    // a full page reload is the standalone equivalent.)
    await page.reload();
    await waitForApp(page);
    await page.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 2,
      undefined,
      { timeout: 15_000 },
    );
  });

  test('clicking a pet shows a heart bubble that auto-dismisses and dismisses on re-click @area:pets', async ({
    page,
  }) => {
    // Place one pet through the editor, then read its id back (spawn tile is
    // random, so the id is the only stable handle).
    const carousel = await openPetsTab(page);
    await carousel.locator('button[title="Claudio"]').click();
    await page.waitForFunction(
      () => ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).length === 1,
    );
    const pets = await readPets(page);
    const petId = pets[0]!.id;

    // Click → heart bubble appears.
    await petClick(page, petId);
    await page.waitForFunction((id) => {
      const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
        (x) => x.id === id,
      );
      return p?.bubbleType === 'heart';
    }, petId);

    // It auto-dismisses after WAITING_BUBBLE_DURATION_SEC (2s); the rAF loop
    // nulls bubbleType once the timer elapses. Timeout sits above 2s.
    await page.waitForFunction(
      (id) => {
        const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
          (x) => x.id === id,
        );
        return p?.bubbleType === null;
      },
      petId,
      { timeout: 6_000 },
    );

    // Show it again, then click while showing → fast-fade dismiss (0.3s). The
    // tight 1500ms window excludes the 2s auto-dismiss path, proving the click
    // collapsed the timer rather than the bubble timing out on its own.
    await petClick(page, petId);
    await page.waitForFunction((id) => {
      const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
        (x) => x.id === id,
      );
      return p?.bubbleType === 'heart';
    }, petId);

    await petClick(page, petId);
    await page.waitForFunction(
      (id) => {
        const p = ((window as PetWindow).__pixelAgentsTestHooks?.getPets?.() ?? []).find(
          (x) => x.id === id,
        );
        return p?.bubbleType === null;
      },
      petId,
      { timeout: 1_500 },
    );
  });
});
