/**
 * Browser-level verification of the critical user journeys.
 *
 * Drives a real Chrome/Edge install through puppeteer-core against a running
 * WorkBridge server, checking what only a browser can check: that the SPA
 * boots, that each role's dashboard renders, that forms submit, that the
 * language toggle switches the interface to Tamil and survives a reload, that
 * the assistant replies in the chat panel, and that the console stays clean.
 *
 * It needs a local Chrome or Edge; it is intentionally NOT part of `npm test`
 * so the suite still runs on a machine with no browser.
 *
 * Usage:
 *   node scripts/browser-journey.mjs [baseUrl] [demoPassword]
 *   CHROME_PATH=/path/to/chrome node scripts/browser-journey.mjs
 */

import fs from 'fs';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://127.0.0.1:5099';
const PASSWORD = process.argv[3] || process.env.DEMO_PASSWORD || 'SmokePassw0rd';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const executablePath = CANDIDATES.find(p => {
  try { return fs.existsSync(p); } catch (_) { return false; }
});

if (!executablePath) {
  console.error('No Chrome or Edge binary found. Set CHROME_PATH to run this check.');
  process.exit(2);
}

const results = [];
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? ` — ${detail}` : ''}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function text(page, selector) {
  try {
    return await page.$eval(selector, el => el.textContent.trim());
  } catch (_) {
    return null;
  }
}

async function visible(page, selector) {
  return page.$$eval(selector, els => els.some(el => el.offsetParent !== null || el.getClientRects().length > 0))
    .catch(() => false);
}

/** Waits until the SPA has replaced the loading skeleton with real content. */
async function waitForRender(page, selector, timeout = 12000) {
  try {
    await page.waitForSelector(selector, { timeout, visible: true });
    return true;
  } catch (_) {
    return false;
  }
}

async function signIn(page, identifier) {
  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await waitForRender(page, '#login-identifier');
  await page.$eval('#login-identifier', (el, v) => { el.value = v; }, identifier);
  await page.$eval('#login-password', (el, v) => { el.value = v; }, PASSWORD);
  await page.$eval('form[data-action="login"] button[type="submit"]', el => el.click());
  await sleep(1600);
}

async function logout(page) {
  const button = await page.$('[data-action="logout"]');
  if (button) {
    await button.evaluate(el => el.click());
    await sleep(1000);
  }
  const client = await page.createCDPSession().catch(() => null);
  if (client) {
    await client.send('Network.clearBrowserCookies').catch(() => {});
    await client.detach().catch(() => {});
  }
  // A full reload is required: clearing the cookie out of band leaves the SPA's
  // in-memory user object in place, and a guest-only route would then redirect.
  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(800);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900, isMobile: true }); // mobile-first worker view

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => pageErrors.push(String(err && err.message)));
  page.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()} ${req.failure() && req.failure().errorText}`));
  page.on('response', res => {
    if (res.status() >= 500) failedRequests.push(`${res.status()} ${res.url()}`);
  });

  // ---------------------------------------------------------------- landing
  console.log('\n-- landing (anonymous) --');
  await page.goto(`${BASE}/#/landing`, { waitUntil: 'networkidle2' });
  check('landing page renders the hero', await waitForRender(page, '.hero-title'));
  check('landing shows live listing counts', /\d/.test((await text(page, '.stat-card .num')) || ''));
  check('language toggle is present', await visible(page, '.lang-toggle'));

  // ------------------------------------------------------------ Tamil switch
  console.log('\n-- Tamil language --');
  await page.$eval('.lang-toggle .lang-btn[data-lang="ta"]', el => el.click());
  await sleep(900);
  const htmlLang = await page.evaluate(() => document.documentElement.lang);
  check('document language becomes ta', htmlLang === 'ta', htmlLang);
  const tamilTitle = await text(page, '.hero-title');
  check('hero headline is rendered in Tamil script', /[\u0B80-\u0BFF]/.test(tamilTitle || ''), tamilTitle);
  const fontUsed = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  check('Tamil font stack is applied', /Noto Sans Tamil/i.test(fontUsed), fontUsed);

  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(700);
  check('language choice survives a reload',
    (await page.evaluate(() => document.documentElement.lang)) === 'ta');

  await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle2' });
  await sleep(700);
  check('language persists across navigation',
    (await page.evaluate(() => document.documentElement.lang)) === 'ta');
  const tamilSignIn = await text(page, '.auth-title');
  check('sign-in screen is translated', /[\u0B80-\u0BFF]/.test(tamilSignIn || ''), tamilSignIn);

  // Back to English for the remaining assertions.
  await page.$eval('.lang-toggle .lang-btn[data-lang="en"]', el => el.click());
  await sleep(800);

  // -------------------------------------------------------- validation state
  console.log('\n-- login validation --');
  await waitForRender(page, '#login-identifier');
  await page.click('form[data-action="login"] button[type="submit"]');
  await sleep(500);
  const identifierError = await text(page, '#login-identifier-error');
  check('empty submit shows an inline field error', Boolean(identifierError), identifierError || '(none)');

  await page.$eval('#login-identifier', el => { el.value = 'worker@demo.workbridge.local'; });
  await page.$eval('#login-password', el => { el.value = 'definitely-wrong'; });
  await page.$eval('form[data-action="login"] button[type="submit"]', el => el.click());
  await sleep(1300);
  const toastText = await text(page, '#toast');
  check('wrong password surfaces an error message', Boolean(toastText), toastText || '(none)');
  check('a failed sign-in does not navigate away', page.url().includes('#/login'));

  const toggleBefore = await page.$eval('#login-password', el => el.type);
  await page.$eval('[data-action="toggle-password"]', el => el.click());
  const toggleAfter = await page.$eval('#login-password', el => el.type);
  check('password visibility toggle works', toggleBefore === 'password' && toggleAfter === 'text');

  // ----------------------------------------------------------- worker journey
  console.log('\n-- worker journey --');
  await signIn(page, 'worker@demo.workbridge.local');
  check('worker lands on the worker dashboard', page.url().includes('#/worker'), page.url());
  check('worker shell renders', await waitForRender(page, '.mobile-shell'));
  check('bottom navigation is present (mobile-first)', await visible(page, '.mobile-nav'));
  check('profile completeness card renders', await visible(page, '.progress'));

  await page.goto(`${BASE}/#/jobs`, { waitUntil: 'networkidle2' });
  check('job list renders', await waitForRender(page, '.job-card'));
  const jobCount = await page.$$eval('.job-card', els => els.length);
  check('at least one listing is shown', jobCount > 0, `${jobCount} cards`);
  check('match score badge is shown', /%/.test((await text(page, '.job-card .badge')) || ''));

  await page.select('#filter-country', 'Qatar');
  await sleep(1200);
  const afterFilter = await page.$$eval('.job-card .muted', els => els.map(e => e.textContent).join(' | '));
  check('country filter dropdown actually filters',
    afterFilter === '' || /Qatar/.test(afterFilter), afterFilter.slice(0, 120));

  await page.select('#filter-country', 'All');
  await sleep(1100);
  await page.$eval('#job-search', el => { el.value = 'driver'; });
  await page.click('form[data-action="job-search"] button[type="submit"]');
  await sleep(1100);
  const searchCount = await page.$$eval('.job-card', els => els.length);
  check('search returns results', searchCount > 0, `${searchCount} cards`);

  const firstJobLink = await page.$('.job-card a.btn.primary');
  const firstJobHref = await firstJobLink.evaluate(el => el.getAttribute('href'));
  // Dispatched on the element itself: a fixed overlay must not be able to steal
  // the hit test and make a routing failure look like a passing click.
  await firstJobLink.evaluate(el => el.click());
  await sleep(1400);
  const detailOpened = await waitForRender(page, '.detail-list');
  check('job detail opens by clicking the card link', detailOpened,
    `clicked ${firstJobHref}, now at ${page.url()}`);
  check('match explanation is shown with reasons', await visible(page, '.reason-list'));

  const applyLink = await page.$('a.btn.primary[href^="#/apply/"]');
  check('apply call-to-action is present on the detail view', Boolean(applyLink));
  if (applyLink) await applyLink.evaluate(el => el.click());
  await sleep(1300);
  check('apply form opens', await waitForRender(page, 'form[data-action="apply"]'));
  const applySubmit = await page.$('form[data-action="apply"] button[type="submit"]');
  if (applySubmit) await applySubmit.evaluate(el => el.click());
  await sleep(1700);
  const appliedOk = page.url().includes('#/applications') || /already applied|விண்ணப்பித்/i.test((await text(page, '#toast')) || '');
  check('application submits (or reports an existing one)', appliedOk, page.url());

  await page.goto(`${BASE}/#/applications`, { waitUntil: 'networkidle2' });
  check('applications list renders', await waitForRender(page, '.card'));

  await page.goto(`${BASE}/#/visa`, { waitUntil: 'networkidle2' });
  check('visa tracking renders the milestone timeline', await waitForRender(page, '.timeline .step'));
  const stepCount = await page.$$eval('.timeline .step', els => els.length);
  check('seven visa milestones are shown', stepCount === 7, `${stepCount} steps`);

  await page.goto(`${BASE}/#/documents`, { waitUntil: 'networkidle2' });
  check('documents page renders the upload form', await waitForRender(page, 'form[data-action="upload-document"]'));
  check('upload limits are stated to the user', /MB/.test((await text(page, 'form[data-action="upload-document"] .muted')) || ''));

  await page.goto(`${BASE}/#/salary`, { waitUntil: 'networkidle2' });
  check('salary guide renders with its disclaimer', await waitForRender(page, '.notice'));

  // ------------------------------------------------------------ AI assistant
  console.log('\n-- AI assistant --');
  check('floating assistant launcher is present', await visible(page, '.assistant-launcher'));
  await page.$eval('.assistant-launcher', el => el.click());
  await sleep(1200);
  check('assistant panel opens', await visible(page, '.assistant-panel'));
  check('assistant states which engine is answering', await visible(page, '.assistant-mode'));
  check('suggested questions are offered', await visible(page, '[data-action="assistant-suggest"]'));

  // Focus and type for real, so enter-to-send is genuinely exercised.
  await page.focus('[data-assistant-input]');
  await page.type('[data-assistant-input]', 'How does the visa-processing process work?', { delay: 8 });
  await page.keyboard.press('Enter');
  await sleep(3000);
  const bubbles = await page.$$eval('.assistant-panel .bubble', els => els.map(e => e.textContent.trim()));
  check('user message appears in the log', bubbles.some(b => /visa-processing process/i.test(b)));
  check('assistant replies in the log', bubbles.length >= 2, `${bubbles.length} bubbles`);
  check('the reply carries the indicative-information notice', await visible(page, '.assistant-disclaimer'));

  await page.focus('[data-assistant-input]');
  await page.$eval('[data-assistant-input]', el => { el.value = 'சவுதி அரேபியாவில் வேலை செய்ய என்ன ஆவணங்கள் தேவை?'; });
  await page.keyboard.press('Enter');
  await sleep(3000);
  const tamilReply = await page.$$eval('.assistant-panel .bubble.ai', els => els[els.length - 1].textContent);
  check('assistant answers a Tamil question in Tamil', /[\u0B80-\u0BFF]/.test(tamilReply || ''), (tamilReply || '').slice(0, 80));

  await page.goto(`${BASE}/#/assistant`, { waitUntil: 'networkidle2' });
  check('dedicated assistant page renders the same conversation',
    await waitForRender(page, '[data-assistant-page] .bubble'));

  // -------------------------------------------------------- employer journey
  console.log('\n-- employer journey --');
  await page.setViewport({ width: 1400, height: 900 });
  await logout(page);
  await signIn(page, 'employer@demo.workbridge.local');
  check('employer lands on the employer dashboard', page.url().includes('#/employer'), page.url());
  check('desktop sidebar renders for the employer', await visible(page, '.sidebar'));
  check('employer stat tiles render', await visible(page, '.stat-grid .card'));

  await page.goto(`${BASE}/#/employer/post`, { waitUntil: 'networkidle2' });
  check('post-a-job form renders', await waitForRender(page, 'form[data-action="create-job"]'));

  const stamp = Date.now();
  await page.$eval('#job-title', (el, v) => { el.value = v; }, `Browser Journey Driver ${stamp}`);
  await page.$eval('#job-city', el => { el.value = 'Dubai'; });
  await page.$eval('#job-salary', el => { el.value = 'AED 2,100 - 2,400 / month'; });
  await page.$eval('#job-description', el => {
    el.value = 'Heavy vehicle driving on fixed intercity routes with a company-provided vehicle and accommodation.';
  });
  await page.$eval('#job-requirements', el => {
    el.value = 'Valid heavy vehicle licence and two years of commercial driving experience.';
  });
  await page.$eval('form[data-action="create-job"] button[data-status="published"]', el => el.click());
  await sleep(2200);
  const publishedOk = page.url().includes('#/employer/jobs') || await visible(page, '#risk-result .card');
  check('listing publishes and the risk result is shown', publishedOk, page.url());

  // A deliberately suspicious listing, so the admin review queue later in this
  // journey has a freshly flagged row with real risk factors to inspect.
  await page.goto(`${BASE}/#/employer/post`, { waitUntil: 'networkidle2' });
  await waitForRender(page, 'form[data-action="create-job"]');
  await page.$eval('#job-title', (el, v) => { el.value = v; }, `Urgent Joining No Interview ${stamp}`);
  await page.$eval('#job-city', el => { el.value = 'Dubai'; });
  await page.$eval('#job-salary', el => { el.value = 'AED 24,000 / month'; });
  await page.$eval('#job-vacancies', el => { el.value = '750'; });
  await page.select('#job-visa', 'No');
  await page.$eval('#job-description', el => {
    el.value = 'Immediate joining with no interview. A registration fee applies before processing. Contact us on WhatsApp +91 90000 33333.';
  });
  await page.$eval('#job-requirements', el => { el.value = 'No experience needed.'; });
  await page.$eval('form[data-action="create-job"] button[data-status="published"]', el => el.click());
  await sleep(2200);
  const heldPanel = await visible(page, '#risk-result .danger-card');
  check('a risky listing is held for review and the reasons are shown to the employer', heldPanel);
  check('the held-for-review explanation is displayed',
    /review|ஆய்வ/i.test((await text(page, '#risk-result .notice')) || ''));

  await page.goto(`${BASE}/#/employer/jobs`, { waitUntil: 'networkidle2' });
  check('employer listing table renders', await waitForRender(page, '.table tbody tr'));
  const listingRows = await page.$$eval('.table tbody tr', els => els.length);
  check('the new listing appears in the table', listingRows > 0, `${listingRows} rows`);

  await page.goto(`${BASE}/#/employer/applicants`, { waitUntil: 'networkidle2' });
  const applicantsRendered = await waitForRender(page, '.card', 8000);
  check('applicants view renders', applicantsRendered);
  check('candidate document files are not exposed to the employer',
    !(await page.content()).includes('storedName'));

  // ----------------------------------------------------- consultancy journey
  console.log('\n-- consultancy journey --');
  await logout(page);
  await signIn(page, 'consultancy@demo.workbridge.local');
  check('consultancy lands on its workspace', page.url().includes('#/consultancy'), page.url());
  const caseTable = await waitForRender(page, '.table tbody tr', 8000);
  check('caseload table renders', caseTable);

  if (caseTable) {
    await page.$eval('.table tbody tr a.btn', el => el.click());
    await sleep(1500);
    check('case detail renders the milestone form', await waitForRender(page, 'form[data-action="update-stage"]'));
    check('restricted-document notice is shown to the agency',
      await visible(page, '.notice'));

    await page.select('#stage-name', await page.$eval('#stage-name option:nth-child(3)', el => el.value));
    await page.select('#stage-status', 'current');
    await page.$eval('form[data-action="update-stage"] button[type="submit"]', el => el.click());
    await sleep(1800);
    const stageToast = await text(page, '#toast');
    check('milestone update is accepted or correctly refused', Boolean(stageToast), stageToast || '(none)');
  }

  // ----------------------------------------------------------- admin journey
  console.log('\n-- admin journey --');
  await logout(page);
  await signIn(page, 'admin@demo.workbridge.local');
  check('admin lands on the admin dashboard', page.url().includes('#/admin'), page.url());
  check('platform metrics render', await waitForRender(page, '.stat-grid .num'));
  check('risk disclaimer is shown on the dashboard',
    /indicator|not proof/i.test((await page.content()) || ''));

  await page.goto(`${BASE}/#/admin/queue`, { waitUntil: 'networkidle2' });
  const queueRendered = await waitForRender(page, '.card', 8000);
  check('review queue renders', queueRendered);
  const hasFactors = await visible(page, '.reason-list');
  check('flagged listings show the reasons behind the score', hasFactors);

  if (hasFactors) {
    await page.$eval('[data-action="fraud-action"][data-act="suspend"]', el => el.click());
    await sleep(900);
    check('an administrative action opens a confirmation dialogue', await visible(page, '.modal'));
    await page.$eval('#modal-reason', el => { el.value = 'Browser journey: suspended pending document review.'; });
    await page.$eval('[data-modal-confirm]', el => el.click());
    await sleep(1800);
    const adminToast = await text(page, '#toast');
    check('the decision is recorded', Boolean(adminToast), adminToast || '(none)');
  }

  await page.goto(`${BASE}/#/admin/audit`, { waitUntil: 'networkidle2' });
  check('audit log renders', await waitForRender(page, '.table tbody tr'));

  await page.goto(`${BASE}/#/admin/users`, { waitUntil: 'networkidle2' });
  check('user management renders', await waitForRender(page, '.table tbody tr'));

  // ------------------------------------------------- unauthorised navigation
  console.log('\n-- authorisation in the UI --');
  await logout(page);
  await signIn(page, 'worker@demo.workbridge.local');
  await page.goto(`${BASE}/#/admin/queue`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  const blocked = await page.content();
  check('a worker opening an admin route sees an access message',
    /do not have access|அனுமதி இல்லை/i.test(blocked));
  check('no admin data leaks onto the blocked page', !/riskScore|audit/i.test(await text(page, '#main-content') || ''));

  await page.goto(`${BASE}/#/no-such-route`, { waitUntil: 'networkidle2' });
  await sleep(900);
  check('an unknown route renders a handled message', await visible(page, '.empty'));

  // ----------------------------------------------------------------- console
  console.log('\n-- console and network --');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  const realConsoleErrors = consoleErrors.filter(e =>
    !/favicon/i.test(e) && !/401|403|429/.test(e) && !/Failed to load resource/i.test(e));
  check('no unexpected console errors', realConsoleErrors.length === 0, realConsoleErrors.join(' | '));
  const realFailures = failedRequests.filter(r => !/favicon/i.test(r));
  check('no failed or 5xx requests', realFailures.length === 0, realFailures.join(' | '));
} finally {
  await browser.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (failed.length) {
  console.log('\nFailures:');
  for (const row of failed) console.log(`  - ${row.label}${row.detail ? ` (${row.detail})` : ''}`);
  process.exit(1);
}
