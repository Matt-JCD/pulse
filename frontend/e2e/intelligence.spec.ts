import { test, expect } from '@playwright/test';

/**
 * Intelligence Dashboard tests.
 *
 * The page is a Server Component that fetches live data from the backend.
 * Tests are written to pass in both states:
 *   - Data present  → section content visible
 *   - No data / backend down → empty-state messages visible
 *
 * We never assert specific topic titles (they change daily); we assert
 * structural elements and section labels that are always rendered.
 */

test.describe('Intelligence Dashboard — structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/intelligence');
  });

  test('page loads without a crash or error overlay', async ({ page }) => {
    // nextjs-portal is always in the DOM in dev mode; the actual error dialog only
    // appears inside it when there is a real crash.
    await expect(page.locator('[data-nextjs-dialog]')).not.toBeAttached();
    await expect(page).toHaveURL('/intelligence');
  });

  test('header shows today\'s date and Run Now button', async ({ page }) => {
    const header = page.locator('h1');
    await expect(header).toBeVisible();
    await expect(header).toContainText('2026');

    const runButton = page.getByRole('button', { name: /Run Now/i });
    await expect(runButton).toBeVisible();
    await expect(runButton).toBeEnabled();
  });

  test('Trending Topics section is present with both category panels', async ({ page }) => {
    await expect(
      page.getByText('Trending Topics · Today', { exact: false }),
    ).toBeVisible();

    await expect(page.getByText('🌐 Ecosystem').first()).toBeVisible();
    await expect(page.getByText('🏢 Enterprise AI').first()).toBeVisible();
  });

  test('Topic Trends section is present', async ({ page }) => {
    await expect(page.getByText('Topic Trends', { exact: false })).toBeVisible();
  });

  test('Topic Threads section is present', async ({ page }) => {
    await expect(page.getByText('Topic Threads', { exact: false })).toBeVisible();
  });

  test('word cloud shows content or empty state — never silently blank', async ({ page }) => {
    // When words exist the CloudPanel renders its colour-key legend ("New / Rising").
    // When words are empty it renders the empty-state paragraph instead.
    // Either way, something meaningful must be visible — never a silent blank panel.
    const legend     = page.getByText('New / Rising').first();
    const emptyState = page.getByText('No topics yet — run the collector to populate.').first();

    const hasLegend = await legend.isVisible();
    const hasEmpty  = await emptyState.isVisible().catch(() => false);

    expect(hasLegend || hasEmpty, 'Word cloud panel: expected colour legend or empty-state text').toBe(true);
  });

  test('topic threads show cards or empty state — never silently blank', async ({ page }) => {
    const emptyState  = page.getByText('No topics yet — run the collector to populate.');
    const threadCards = page.locator('.space-y-3 > div');

    const hasEmpty = await emptyState.count() > 0;
    const hasCards = await threadCards.count() > 0;

    expect(hasEmpty || hasCards, 'Topic threads: expected cards or empty-state text').toBe(true);
  });

  test('last run info is shown in header (or "No runs recorded yet")', async ({ page }) => {
    const runInfo = page.locator('text=/Last run:|No runs recorded yet/');
    await expect(runInfo.first()).toBeVisible();
  });
});

test.describe('Intelligence Dashboard — Run Now button', () => {
  test('clicking Run Now shows spinner and poll counter', async ({ page }) => {
    // Mock the trigger so we don't kick off real agents during UI tests
    await page.route('**/api/intelligence/trigger-run', (route) => {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'started', platform: 'all' }),
      });
    });
    // Stable run-log — no new synthesizer entry so spinner stays visible
    await page.route('**/api/intelligence/run-log', (route) => {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, function_name: 'synthesizer', status: 'success',
            created_at: new Date(Date.now() - 3_600_000).toISOString(),
            date: '2026-02-27', error_msg: null },
        ]),
      });
    });

    await page.goto('/intelligence');
    await page.getByRole('button', { name: /Run Now/i }).click();

    await expect(page.getByRole('button', { name: /Running/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Running/i })).toBeDisabled();
    await expect(page.getByText(/poll \d+ \/ 30/i)).toBeVisible({ timeout: 15_000 });
  });

  test('run error message appears when an agent fails', async ({ page }) => {
    let callCount = 0;

    await page.route('**/api/intelligence/trigger-run', (route) => {
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'started' }),
      });
    });

    await page.route('**/api/intelligence/run-log', (route) => {
      callCount++;
      if (callCount === 1) {
        // Baseline — existing synthesizer id=1
        route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify([
            { id: 1, function_name: 'synthesizer', status: 'success',
              created_at: new Date(Date.now() - 7_200_000).toISOString(),
              date: '2026-02-27', error_msg: null },
          ]),
        });
      } else {
        // After run — new synthesizer (id=3) + failed reddit-collector (id=2)
        route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify([
            { id: 3, function_name: 'synthesizer',      status: 'success',
              created_at: new Date().toISOString(), date: '2026-02-27', error_msg: null },
            { id: 2, function_name: 'reddit-collector', status: 'error',
              created_at: new Date().toISOString(), date: '2026-02-27', error_msg: 'JSON parse error' },
            { id: 1, function_name: 'synthesizer',      status: 'success',
              created_at: new Date(Date.now() - 7_200_000).toISOString(),
              date: '2026-02-27', error_msg: null },
          ]),
        });
      }
    });

    await page.goto('/intelligence');
    await page.getByRole('button', { name: /Run Now/i }).click();

    await expect(
      page.getByText(/Run failed: reddit-collector/i),
    ).toBeVisible({ timeout: 20_000 });
  });
});
