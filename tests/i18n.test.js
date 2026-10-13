'use strict';

/**
 * Interface-language tests.
 *
 * The UI is rendered in the browser, so these tests verify the contract the UI
 * depends on: both locale bundles exist, cover the same keys, actually contain
 * Tamil script, and are reachable over HTTP. Browser-level rendering checks are
 * listed as not executed in the report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');

test.after(() => h.cleanup());

const localeDir = path.join(__dirname, '..', 'public', 'locales');
const en = JSON.parse(fs.readFileSync(path.join(localeDir, 'en.json'), 'utf8'));
const ta = JSON.parse(fs.readFileSync(path.join(localeDir, 'ta.json'), 'utf8'));

function flatten(obj, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(obj || {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out.set(full, value);
  }
  return out;
}

const enKeys = flatten(en);
const taKeys = flatten(ta);

test('both locales are present and declare themselves', () => {
  assert.equal(en.meta.code, 'en');
  assert.equal(ta.meta.code, 'ta');
  assert.equal(ta.meta.language, 'தமிழ்');
});

test('the Tamil bundle covers every English key', () => {
  const missing = [...enKeys.keys()].filter(key => !taKeys.has(key));
  assert.deepEqual(missing, [], `Tamil translations missing for: ${missing.join(', ')}`);
});

test('the Tamil bundle has no keys the English bundle lacks', () => {
  const extra = [...taKeys.keys()].filter(key => !enKeys.has(key));
  assert.deepEqual(extra, [], `Tamil-only keys: ${extra.join(', ')}`);
});

test('no translated string is left as the English original', () => {
  // Brand names, language labels and a few technical tokens are intentionally
  // identical in both bundles.
  const allowedIdentical = new Set([
    'meta.dir', 'brand.name', 'common.appName', 'common.english', 'common.tamil',
    'common.of', 'employer.salaryPlaceholder', 'admin.factorWeight', 'admin.salaryBandUsed'
  ]);
  const untranslated = [];
  for (const [key, value] of enKeys) {
    if (allowedIdentical.has(key)) continue;
    if (typeof value !== 'string') continue;
    if (taKeys.get(key) === value) untranslated.push(key);
  }
  assert.deepEqual(untranslated, [], `still in English: ${untranslated.join(', ')}`);
});

test('every Tamil string actually contains Tamil script', () => {
  const skip = new Set([
    'meta.dir', 'meta.code', 'brand.name', 'common.appName', 'common.english', 'common.tamil',
    // Pure placeholder/number formats with no words to translate.
    'common.of', 'admin.factorWeight'
  ]);
  const suspicious = [];
  for (const [key, value] of taKeys) {
    if (skip.has(key) || typeof value !== 'string') continue;
    // Pure placeholder/punctuation strings are acceptable.
    if (/^[\s\p{P}{}\w]*$/u.test(value) && !/[a-zA-Z]{4,}/.test(value)) continue;
    if (!/[஀-௿]/.test(value)) suspicious.push(key);
  }
  assert.deepEqual(suspicious, [], `no Tamil script in: ${suspicious.join(', ')}`);
});

test('interpolation placeholders match between locales', () => {
  const mismatched = [];
  for (const [key, value] of enKeys) {
    if (typeof value !== 'string') continue;
    const taValue = taKeys.get(key);
    if (typeof taValue !== 'string') continue;
    const names = str => (str.match(/\{\{(\w+)\}\}/g) || []).sort().join(',');
    if (names(value) !== names(taValue)) mismatched.push(`${key} (en: ${names(value)} / ta: ${names(taValue)})`);
  }
  assert.deepEqual(mismatched, [], `placeholder mismatch: ${mismatched.join('; ')}`);
});

test('every server error code the API can return has a translation', () => {
  // Codes are collected from the backend source so a new code without a
  // translation fails the build rather than showing a raw code to a user.
  const backendDir = path.join(__dirname, '..', 'backend');
  const codes = new Set();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(full, 'utf8');
        for (const match of source.matchAll(/fail\(res,\s*\d+,\s*'([A-Z0-9_]+)'/g)) codes.add(match[1]);
        for (const match of source.matchAll(/badRequest\('([A-Z0-9_]+)'/g)) codes.add(match[1]);
      }
    }
  };
  walk(backendDir);

  const untranslated = [...codes].filter(code => !enKeys.has(`validation.${code}`));
  assert.deepEqual(untranslated, [], `no English message for: ${untranslated.join(', ')}`);

  const noTamil = [...codes].filter(code => !taKeys.has(`validation.${code}`));
  assert.deepEqual(noTamil, [], `no Tamil message for: ${noTamil.join(', ')}`);
});

test('locale files and frontend modules are served over HTTP', async () => {
  const http = await h.agent();
  for (const file of ['/locales/en.json', '/locales/ta.json', '/app.js', '/i18n.js', '/ui.js', '/assistant.js', '/api.js', '/style.css', '/components.css']) {
    const res = await http.get(file);
    assert.equal(res.status, 200, `${file} should be served`);
  }

  const taBundle = await http.get('/locales/ta.json');
  assert.match(JSON.stringify(taBundle.body), /[஀-௿]/);
});

test('the served HTML loads a Tamil-capable font and declares a language', async () => {
  const http = await h.agent();
  const res = await http.get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /Noto\+Sans\+Tamil/);
  assert.match(res.text, /<html lang="en" data-lang="en">/);
  // No inline event handlers, which is what allows the strict script CSP.
  assert.equal(/on(click|submit|change)=/.test(res.text), false);
});

test('the response carries a strict script CSP', async () => {
  const http = await h.agent();
  const res = await http.get('/');
  const csp = res.headers['content-security-policy'];
  assert.ok(csp, 'expected a Content-Security-Policy header');
  assert.match(csp, /script-src 'self'/);
  assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false);
  assert.match(csp, /frame-ancestors 'none'/);
});

test('the account language is stored and returned', async () => {
  const http = await h.agent();
  await http.post('/api/auth/register').send({
    name: 'Tamil Speaker',
    email: 'tamil-user@example.com',
    password: 'ValidPass123',
    role: 'Worker',
    language: 'ta'
  });

  const worker = await h.as('tamil-user@example.com', 'ValidPass123');
  const me = await worker.get('/api/auth/me');
  assert.equal(me.body.user.language, 'ta');

  const switched = await worker.patch('/api/auth/me', { language: 'en' });
  assert.equal(switched.body.user.language, 'en');

  // The preference survives a new sign-in, which is what makes it persist
  // across devices rather than only in one browser.
  const again = await h.as('tamil-user@example.com', 'ValidPass123');
  const me2 = await again.get('/api/auth/me');
  assert.equal(me2.body.user.language, 'en');
});

test('an unsupported language value is rejected', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.patch('/api/auth/me', { language: 'fr' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'FIELD_VALUE_INVALID');
});

test('user-generated content is not translated or altered', async () => {
  const employer = await h.as(h.DEMO.employer);
  const description = 'Mixed content: driver needed, வாகன ஓட்டுநர் தேவை, salary AED 2,000.';
  const created = await employer.post('/api/jobs', {
    title: 'Bilingual Listing',
    company: 'Bilingual Co',
    category: 'Driver',
    country: 'UAE',
    city: 'Dubai',
    salary: 'AED 2,000 / month',
    exp: '1+ year',
    hours: '8 hours',
    vacancies: 2,
    visa: 'Yes',
    description,
    requirements: 'Valid licence · செல்லுபடியாகும் உரிமம்'
  });
  assert.equal(created.status, 201);
  // Stored and returned byte-for-byte: employer copy is never machine-touched.
  assert.equal(created.body.data.description, description);
  assert.equal(created.body.data.requirements, 'Valid licence · செல்லுபடியாகும் உரிமம்');
});

test('the metadata endpoint advertises both languages', async () => {
  const http = await h.agent();
  const res = await http.get('/api/meta');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.languages, ['en', 'ta']);
  assert.deepEqual(res.body.data.signupRoles, ['Worker', 'Employer', 'Consultancy']);
  assert.equal(res.body.data.signupRoles.includes('Admin'), false);
});
