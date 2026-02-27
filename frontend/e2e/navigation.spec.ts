import { test, expect } from '@playwright/test';

/**
 * Navigation tests — sidebar links, routing, page-level smoke checks.
 * These tests verify that every route renders without a crash and that
 * the sidebar correctly reflects the active page.
 */

test.describe('Sidebar navigation', () => {
  test('root / redirects to /intelligence', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/intelligence');
  });

  test('sidebar is visible on every page', async ({ page }) => {
    const routes = [
      '/intelligence',
      '/composer',
      '/scheduler',
      '/inbox',
      '/analytics',
      '/admin',
      '/settings',
    ];

    for (const route of routes) {
      await page.goto(route);
      // Logo
      await expect(page.getByText('Pulse').first()).toBeVisible();
      // All main nav labels present
      await expect(page.getByRole('link', { name: 'Intelligence' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Composer' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
    }
  });

  test('active nav item is highlighted on /intelligence', async ({ page }) => {
    await page.goto('/intelligence');
    const intelligenceLink = page.getByRole('link', { name: 'Intelligence' });
    await expect(intelligenceLink).toHaveClass(/text-aqua/);
  });

  test('placeholder pages render their heading without crashing', async ({ page }) => {
    const placeholders = [
      { route: '/composer',  heading: 'Composer' },
      { route: '/scheduler', heading: 'Scheduler' },
      { route: '/inbox',     heading: 'Inbox' },
      { route: '/analytics', heading: 'Analytics' },
      { route: '/admin',     heading: 'Admin' },
      { route: '/settings',  heading: 'Settings' },
    ];

    for (const { route, heading } of placeholders) {
      await page.goto(route);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      // nextjs-portal is always present in dev mode; actual error dialog must not appear
      await expect(page.locator('[data-nextjs-dialog]')).not.toBeAttached();
    }
  });

  test('clicking sidebar links navigates correctly', async ({ page }) => {
    await page.goto('/intelligence');

    await page.getByRole('link', { name: 'Composer' }).click();
    await expect(page).toHaveURL('/composer');

    await page.getByRole('link', { name: 'Admin' }).click();
    await expect(page).toHaveURL('/admin');

    await page.getByRole('link', { name: 'Intelligence' }).click();
    await expect(page).toHaveURL('/intelligence');
  });
});
