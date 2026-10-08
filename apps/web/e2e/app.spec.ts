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

/**
 * Whatever is wider than the screen: the document, or the page's own scroll container (the document
 * never scrolls: the page does, inside the frame). Names what overflows, for the failure message.
 */
const widerThanItsFrame = (page: Page) =>
  page.evaluate(() => {
    const wide: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) wide.push(`document ${root.scrollWidth}px`);
    for (const scroller of document.querySelectorAll<HTMLElement>('[data-scroll="page"]')) {
      if (scroller.scrollWidth > scroller.clientWidth) {
        wide.push(`page ${scroller.scrollWidth}px in ${scroller.clientWidth}px`);
      }
    }
    return wide;
  });

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

// Nothing here sends the chief a message: the stack may have a real model, and these tests stay free.
test('opens the conversation with the chief of staff, following it live', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Chief of staff' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Chief of staff' })).toBeVisible();
  await expect(page).toHaveTitle('Chief of staff · superagent');
  // Shown only once the conversation's own stream is live ("Connecting…" or "Reconnecting…" before).
  await expect(page.getByText('Routes your work to the departments')).toBeVisible();
  const box = page.getByLabel('Message the chief of staff');
  await box.fill('A draft I won’t send');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await box.fill('');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
});

test("shows a task's transcript, empty until the task goes to its lead", async ({ page, request }) => {
  const team = await department(request);
  const created = await request.post('/v1/tasks', {
    headers: auth,
    data: { departmentId: team.id, title: 'Read the transcript', brief: 'Not sent yet.', dispatch: false },
  });
  const task = await created.json();
  expect((await request.get(`/v1/tasks/${task.id}/transcript`, { headers: auth })).status()).toBe(200);
  await signIn(page);
  await page.goto(`/tasks/${task.id}`);
  await page.getByRole('tab', { name: 'Transcript' }).click();
  await expect(page).toHaveURL(/view=transcript/);
  await expect(page.getByText('The transcript starts when the task goes to its lead.')).toBeVisible();
});

test('lists what needs you in the inbox, counted in the rail', async ({ page }) => {
  await signIn(page);
  const inbox = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /inbox/i });
  await expect(inbox).toContainText('waiting');
  await inbox.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await expect(page).toHaveTitle('Inbox · superagent');
  // The e2e stack runs without a model, and the inbox says what that stops.
  await expect(page.getByText('No default model is set: agents cannot run')).toBeVisible();
});

test('goes anywhere from the command palette', async ({ page }) => {
  await signIn(page);
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', { name: 'Search pages, tasks and actions' });
  await expect(search).toBeVisible();
  await search.fill('board');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Board' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();
});

test('can be added to a home screen', async ({ page, request }) => {
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  const body = await manifest.json();
  expect(body).toMatchObject({ name: 'superagent', start_url: '/', display: 'standalone' });
  for (const icon of body.icons as Array<{ src: string; type: string }>) {
    const res = await request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()['content-type'], icon.src).toBe(icon.type);
  }
  await page.goto('/sign-in');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
});

test('works on a phone: the rail becomes a drawer, and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  expect(await widerThanItsFrame(page)).toEqual([]);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: 'Board' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Board' })).toBeVisible();
  expect(await widerThanItsFrame(page)).toEqual([]);
});

test('sets up a department and its lead, then gives the lead a tool in a new version', async ({ page }) => {
  const suffix = Date.now().toString(36);
  await signIn(page);
  await page.goto('/departments');
  await page.getByRole('button', { name: 'New department' }).click();
  const dialog = page.getByRole('dialog', { name: 'New department' });
  await dialog.getByLabel('Name').fill(`Desk ${suffix}`);
  await expect(dialog.getByLabel('Slug')).toHaveValue(`desk-${suffix}`);
  await dialog.getByLabel('What it’s for').fill('Answers questions about the desk.');
  await dialog.getByRole('button', { name: 'Create department' }).click();
  await expect(page).toHaveURL(new RegExp(`/departments/desk-${suffix}\\?tab=team$`));

  await page.getByRole('button', { name: 'Add the lead' }).click();
  const lead = page.getByRole('dialog', { name: `A lead for Desk ${suffix}` });
  await lead.getByLabel('Name').fill('Dana');
  await lead.getByLabel('What it does').fill('Plans the desk’s work.');
  await lead.getByLabel('Instructions').fill('Answer briefly.');
  await lead.getByRole('button', { name: 'Add the lead' }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/desk-${suffix}-dana$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Dana' })).toBeVisible();

  await page.getByRole('switch', { name: /^Web search/ }).click();
  await page.getByRole('button', { name: 'Save as version 2' }).click();
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  await page.getByRole('tab', { name: /Versions/ }).click();
  await expect(page.getByRole('list', { name: 'Dana’s versions' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText('Changed tools.')).toBeVisible();
});

test('sets up a schedule in words, with its next runs', async ({ page, request }) => {
  const team = await department(request);
  await signIn(page);
  await page.goto(`/departments/${team.slug}?tab=schedules`);
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByLabel('Title').fill('Morning check');
  await dialog.getByLabel('Brief').fill('Look at what changed overnight.');
  await expect(dialog.getByRole('group', { name: 'When' }).getByRole('note')).toContainText(
    'Every weekday at',
  );
  await expect(dialog.getByRole('group', { name: 'When' }).getByRole('note')).toContainText('Next:');
  await dialog.getByRole('button', { name: 'Set up schedule' }).click();
  await expect(page.getByText('Schedule set up')).toBeVisible();
  const row = page.getByRole('listitem').filter({ hasText: 'Morning check' });
  await expect(row).toContainText('Every weekday at');
  await expect(row).toContainText('Set up by you');
});

test('uploads a document, then finds it as an agent would', async ({ page }) => {
  const word = `zebra${Date.now().toString(36)}`;
  await signIn(page);
  await page.goto('/knowledge');
  await page.locator('input[type="file"]').setInputFiles({
    name: `${word}.md`,
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# Field notes\n\nThe ${word} only shows up on Tuesdays.`),
  });
  await expect(page.getByRole('list', { name: 'Uploads' })).toContainText('to search');
  await page.getByRole('searchbox', { name: 'Search the documents' }).fill(word);
  const results = page.getByRole('list', { name: 'Search results' });
  await expect(results).toContainText(`${word}.md`);
  await expect(results.locator('mark').first()).toHaveText(word);
});

test('adds a provider, prices a model on it by hand, then deletes it', async ({ page, request }) => {
  const suffix = Date.now().toString(36);
  // A run that stopped half-way may have left its provider behind.
  const { items } = await (await request.get('/v1/providers', { headers: auth })).json();
  for (const provider of items as Array<{ id: string; slug: string }>) {
    if (provider.slug.startsWith('e2e-'))
      await request.delete(`/v1/providers/${provider.id}`, { headers: auth });
  }
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings\/models$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  await expect(page).toHaveTitle('Models · superagent');
  await page.getByRole('button', { name: 'Add a provider' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a provider' });
  await dialog.getByLabel('Name').fill(`E2E ${suffix}`);
  await expect(dialog.getByLabel('Slug')).toHaveValue(`e2e-${suffix}`);
  // Nothing answers there: its models can't be listed, so one is added by hand.
  await dialog.getByLabel('Base URL').fill('http://127.0.0.1:9/v1');
  await dialog.getByRole('button', { name: 'Add provider' }).click();
  await expect(page.getByText(/Its models couldn’t be listed/)).toBeVisible();

  const panel = page.getByRole('group', { name: new RegExp(`^E2E ${suffix}`) });
  await panel.getByLabel('Model id to add').fill('e2e-model');
  await panel.getByRole('button', { name: 'Add', exact: true }).click();
  const models = panel.getByRole('list', { name: 'Models' });
  await expect(models).toContainText('Added by hand');
  await models.getByRole('button', { name: 'Set price' }).click();
  const price = page.getByRole('dialog', { name: 'Price of e2e-model' });
  await price.getByLabel('Input', { exact: true }).fill('1');
  await price.getByLabel('Output', { exact: true }).fill('2');
  await price.getByRole('button', { name: 'Save price' }).click();
  await expect(models).toContainText('$1.00 in · $2.00 out');

  // Its model is one to pick for a role (not picked: the other tests run without a model).
  await page.getByRole('combobox', { name: 'Fast model' }).click();
  await expect(page.getByRole('option', { name: `E2E ${suffix} · e2e-model` })).toBeVisible();
  await page.keyboard.press('Escape');

  await panel.getByRole('button', { name: `More for E2E ${suffix}` }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await page
    .getByRole('dialog', { name: `Delete E2E ${suffix}?` })
    .getByRole('button', { name: 'Delete provider' })
    .click();
  await expect(panel).toBeHidden();
});

test('manages devices with the admin token, which only the page keeps', async ({ page, request }) => {
  const name = `E2E tablet ${Date.now().toString(36)}`;
  await signIn(page);
  await page.goto('/settings/devices');
  await page.getByLabel('Admin token').fill(ADMIN_TOKEN);
  await page.getByRole('button', { name: 'Show devices' }).click();
  const devices = page.getByRole('list', { name: 'Devices' });
  await expect(devices.getByRole('listitem').filter({ hasText: 'This browser' })).toHaveCount(1);

  await page.getByRole('button', { name: 'New device token' }).click();
  const dialog = page.getByRole('dialog', { name: 'New device token' });
  await dialog.getByLabel('Device').fill(name);
  await dialog.getByRole('button', { name: 'Create token' }).click();
  const shown = page.getByRole('dialog', { name: 'Copy it now' });
  const token = await shown.getByLabel('Its token').inputValue();
  expect(token).toMatch(/^sa_/);
  const asIt = { authorization: `Bearer ${token}` };
  expect((await request.get('/v1/me', { headers: asIt })).status()).toBe(200);
  await shown.getByRole('button', { name: 'Done' }).click();

  await devices
    .getByRole('listitem')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await page
    .getByRole('dialog', { name: `Revoke “${name}”?` })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(page.getByText(`“${name}” revoked`)).toBeVisible();
  expect((await request.get('/v1/me', { headers: asIt })).status()).toBe(401);
  expect(JSON.stringify(await page.evaluate(() => ({ ...window.localStorage })))).not.toContain(ADMIN_TOKEN);
});

test('shows what model calls cost, over the period chosen', async ({ page }) => {
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Usage' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Usage' })).toBeVisible();
  await expect(page).toHaveTitle('Usage · superagent');
  // The stack may have made no model calls yet: either way the page says what it has.
  const chart = page.getByRole('list', { name: /by day$/ });
  await expect(page.getByText('No model calls yet').or(chart)).toBeVisible();
  await page.getByRole('button', { name: '7 days' }).click();
  await expect(page).toHaveURL(/\/usage\?range=7$/);
  await expect(page.getByText('No model calls yet').or(chart)).toBeVisible();
  if (await chart.isVisible()) await expect(chart.getByRole('listitem')).toHaveCount(7);
});

test('settings on a phone: the sections are a row above the page, and nothing scrolls sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  await page.goto('/settings/skills');
  const row = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(row.getByRole('link', { name: 'Skills' })).toHaveAttribute('aria-current', 'page');
  await expect(row.getByRole('link', { name: 'Skills' })).toBeInViewport();
  expect(await widerThanItsFrame(page)).toEqual([]);
  await row.getByRole('link', { name: 'Secrets' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Secrets' })).toBeVisible();
  expect(await widerThanItsFrame(page)).toEqual([]);

  // Usage over 90 days: each day keeps a visible bar.
  await page.goto('/usage?range=90');
  const chart = page.getByRole('list', { name: /by day$/ });
  await expect(page.getByText(/^No model calls/).or(chart)).toBeVisible();
  if (await chart.isVisible()) {
    const widths = await chart
      .getByRole('listitem')
      .evaluateAll((items) => items.map((item) => item.querySelector('[aria-hidden]')?.clientWidth ?? 0));
    expect(widths).toHaveLength(90);
    expect(Math.min(...widths)).toBeGreaterThan(0);
  }
  expect(await widerThanItsFrame(page)).toEqual([]);
});
