import { test, expect } from '@playwright/test';

test.describe('Intelligence Dashboard - structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/intelligence');
  });

  test('page loads without a crash or error overlay', async ({ page }) => {
    await expect(page.locator('[data-nextjs-dialog]')).not.toBeAttached();
    await expect(page).toHaveURL('/intelligence');
  });

  test('header shows current year and Run Now button', async ({ page }) => {
    const header = page.locator('h1');
    await expect(header).toBeVisible();

    const currentYear = new Date().getFullYear().toString();
    await expect(header).toContainText(currentYear);

    const runButton = page.getByRole('button', { name: /Run Now/i });
    await expect(runButton).toBeVisible();
    await expect(runButton).toBeEnabled();
  });

  test('Trending Topics section is present with both category panels', async ({ page }) => {
    await expect(page.getByText('Trending Topics', { exact: false })).toBeVisible();
    await expect(page.getByText('Ecosystem').first()).toBeVisible();
    await expect(page.getByText('Enterprise AI').first()).toBeVisible();
  });

  test('Topic Trends split model is present', async ({ page }) => {
    await expect(page.getByText('Topic Trends', { exact: false })).toBeVisible();
    await expect(page.getByText('Top 5 New Today')).toHaveCount(2);
    await expect(page.getByText('Top 5 Trending Overall')).toHaveCount(2);
  });

  test('Topic Threads section is present', async ({ page }) => {
    await expect(page.getByText('Topic Threads', { exact: false })).toBeVisible();
  });

  test('word cloud shows content or empty state - never silently blank', async ({ page }) => {
    const legend = page.getByText('New / Rising').first();
    const emptyState = page.getByText(/No topics yet.*run the collector to populate\./i).first();

    const hasLegend = await legend.isVisible();
    const hasEmpty = await emptyState.isVisible().catch(() => false);

    expect(hasLegend || hasEmpty, 'Word cloud panel: expected color legend or empty-state text').toBe(true);
  });

  test('topic threads show cards or empty state - never silently blank', async ({ page }) => {
    const emptyState = page.getByText(/No topics yet.*run the collector to populate\./i);
    const threadCards = page.locator('.space-y-3 > div');

    const hasEmpty = (await emptyState.count()) > 0;
    const hasCards = (await threadCards.count()) > 0;

    expect(hasEmpty || hasCards, 'Topic threads: expected cards or empty-state text').toBe(true);
  });

  test('last run info is shown in header (or no runs yet)', async ({ page }) => {
    const runInfo = page.locator('text=/Last run:|No runs recorded yet/');
    await expect(runInfo.first()).toBeVisible();
  });
});

test.describe('Intelligence Dashboard - Run Now button', () => {
  test('clicking Run Now shows spinner and poll counter', async ({ page }) => {
    await page.route('**/api/intelligence/trigger-run', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'started', platform: 'all' }),
      });
    });

    await page.route('**/api/intelligence/run-log', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 1,
            function_name: 'synthesizer',
            status: 'success',
            created_at: new Date(Date.now() - 3_600_000).toISOString(),
            date: '2026-02-27',
            error_msg: null,
          },
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
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'started' }),
      });
    });

    await page.route('**/api/intelligence/run-log', (route) => {
      callCount++;
      if (callCount === 1) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 1,
              function_name: 'synthesizer',
              status: 'success',
              created_at: new Date(Date.now() - 7_200_000).toISOString(),
              date: '2026-02-27',
              error_msg: null,
            },
          ]),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 3,
              function_name: 'synthesizer',
              status: 'success',
              created_at: new Date().toISOString(),
              date: '2026-02-27',
              error_msg: null,
            },
            {
              id: 2,
              function_name: 'reddit-collector',
              status: 'error',
              created_at: new Date().toISOString(),
              date: '2026-02-27',
              error_msg: 'JSON parse error',
            },
            {
              id: 1,
              function_name: 'synthesizer',
              status: 'success',
              created_at: new Date(Date.now() - 7_200_000).toISOString(),
              date: '2026-02-27',
              error_msg: null,
            },
          ]),
        });
      }
    });

    await page.goto('/intelligence');
    await page.getByRole('button', { name: /Run Now/i }).click();

    await expect(page.getByText(/Run failed: reddit-collector/i)).toBeVisible({ timeout: 20_000 });
  });
});
