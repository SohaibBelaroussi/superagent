// The web app as the server runs it: the API image serving the built app, in a real browser.
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

const ADMIN_TOKEN = process.env.SUPERAGENT_ADMIN_TOKEN ?? '';
const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('API token').fill(ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening)/ }),
  ).toBeVisible();
}

async function department(request: APIRequestContext): Promise<{ id: string; slug: string; name: string }> {
  const suffix = Date.now().toString(36);
  const res = await request.post('/v1/departments', {
    headers: auth,
    data: { slug: `e2e-web-${suffix}`, name: `Web ${suffix}` },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

/** Every Content-Security-Policy violation on a page is recorded; any one fails the test (afterEach). */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
});

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []).catch(() => []);

test.afterEach(async ({ page, request }) => {
  const seen = await violations(page);
  // A test that ends signed in leaves a device token behind: revoke it, so local runs don't pile them up.
  const stored = await page.evaluate(() => window.localStorage.getItem('superagent.token')).catch(() => null);
  if (stored) {
    const me = await request.get('/v1/me', { headers: { authorization: `Bearer ${stored}` } });
    if (me.ok()) await request.delete(`/v1/tokens/${(await me.json()).token.id}`, { headers: auth });
  }
  expect(seen, 'Content-Security-Policy violations').toEqual([]);
});

test('serves the app under its CSP, and the API next to it', async ({ page, request }) => {
  const res = await request.get('/board');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/html');
  expect(res.headers()['content-security-policy']).toContain("script-src 'self'");
  expect((await request.get('/health')).status()).toBe(200);
  expect((await request.get('/v1/nothing-here', { headers: auth })).status()).toBe(404);

  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Board' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Board' })).toBeVisible();
  await expect(page).toHaveTitle('Board · superagent');
  // Base UI's select injects a style element unless told not to: open one under the CSP.
  await page.getByRole('combobox', { name: 'Department' }).click();
  await expect(page.getByRole('option', { name: 'All departments' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('signs in with the admin token but keeps only a device token, revoked on sign-out', async ({
  page,
  request,
}) => {
  await signIn(page);
  const stored = await page.evaluate(() => window.localStorage.getItem('superagent.token'));
  expect(stored).toMatch(/^sa_/);
  expect(stored).not.toBe(ADMIN_TOKEN);
  expect(JSON.stringify(await page.evaluate(() => ({ ...window.localStorage })))).not.toContain(ADMIN_TOKEN);

  const me = await (await request.get('/v1/me', { headers: { authorization: `Bearer ${stored}` } })).json();
  expect(me.token.name).toMatch(/^Web: /);

  await page.getByRole('button', { name: 'Account and theme' }).click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect((await request.get('/v1/me', { headers: { authorization: `Bearer ${stored}` } })).status()).toBe(
    401,
  );
});

test('shows a task created elsewhere without a reload, then edits and cancels it', async ({
  page,
  request,
}) => {
  const team = await department(request);
  await signIn(page);
  await page.goto(`/board?department=${team.slug}`);
  await expect(page.getByRole('heading', { level: 1, name: team.name })).toBeVisible();
  await expect(page.getByText('Nothing on the board')).toBeVisible();
  // The live stream is connected before the task appears, so it can only arrive that way.
  await expect(page.getByText('Live', { exact: true })).toBeVisible();

  const created = await request.post('/v1/tasks', {
    headers: auth,
    data: {
      departmentId: team.id,
      title: 'Check the browser tests',
      brief: 'Created by Playwright.',
      dispatch: false,
    },
  });
  expect(created.status()).toBe(201);
  const card = page.getByRole('article', { name: 'Check the browser tests' });
  await expect(card).toBeVisible();

  await card.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Check the browser tests' })).toBeVisible();
  // Tooltips are positioned with inline styles set from script, which the CSP allows: show one.
  await page.getByRole('button', { name: 'More actions' }).hover();
  // The icon button's name is an aria-label, so this text is the tooltip's.
  await expect(page.getByText('More actions', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /edit title/i }).click();
  const edit = page.getByRole('dialog');
  await edit.getByLabel('Title').fill('Check the browser tests, edited');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Check the browser tests, edited' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /cancel task/i }).click();
  const confirm = page.getByRole('dialog');
  await confirm.getByLabel('Reason').fill('Only a test.');
  await confirm.getByRole('button', { name: 'Cancel task' }).click();
  await expect(page.getByText('This task was cancelled.')).toBeVisible();
  await expect(page.getByText('You moved it from Inbox to Cancelled')).toBeVisible();
});

test('works on a phone: the rail becomes a drawer, and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: 'Board' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Board' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
