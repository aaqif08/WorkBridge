'use strict';

/**
 * Static verification of the browser bundle.
 *
 * No headless browser is available in this environment, so these tests check
 * the invariants that would otherwise only fail at runtime in the user's face:
 * every translation key the views ask for exists, every declared action has a
 * handler, every static route target is routable, and no inline event handler
 * sneaks in (which would break under the strict script CSP).
 *
 * Interactive rendering, layout and keyboard behaviour are NOT covered here -
 * see the report's "browser-level checks not executed" section.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const read = file => fs.readFileSync(path.join(publicDir, file), 'utf8');

const sources = {
  'app.js': read('app.js'),
  'ui.js': read('ui.js'),
  'assistant.js': read('assistant.js'),
  'api.js': read('api.js'),
  'i18n.js': read('i18n.js')
};
const allSource = Object.values(sources).join('\n');

const en = JSON.parse(read('locales/en.json'));

function flatten(obj, prefix = '', out = new Set()) {
  for (const [key, value] of Object.entries(obj || {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out.add(full);
  }
  return out;
}
const enKeys = flatten(en);

test('every translation key used by the frontend exists in the English bundle', () => {
  const used = new Set();
  for (const match of allSource.matchAll(/\bt\(\s*'([^']+)'/g)) used.add(match[1]);
  for (const match of allSource.matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(match[1]);

  assert.ok(used.size > 80, `expected many translated strings, found ${used.size}`);

  const missing = [...used].filter(key => {
    if (key.includes('${')) return false;          // template-built key, checked below
    if (/^[a-z]+$/i.test(key) && !key.includes('.')) return false; // not a dotted key
    return !enKeys.has(key);
  });
  assert.deepEqual(missing, [], `frontend asks for keys that do not exist: ${missing.join(', ')}`);
});

test('dynamically built translation keys resolve for every documented value', () => {
  // The views build a few keys from data, e.g. t(`worker.documentTypes.${type}`).
  const documentTypes = require('../backend/routes/documents.routes').DOC_TYPES;
  for (const type of documentTypes) {
    assert.ok(enKeys.has(`worker.documentTypes.${type}`), `missing worker.documentTypes.${type}`);
  }

  const listingStatuses = ['draft', 'published', 'under_review', 'suspended', 'closed'];
  for (const status of listingStatuses) {
    assert.ok(enKeys.has(`employer.listingStatus.${status}`), `missing employer.listingStatus.${status}`);
  }

  // Notification keys come from the API as titleKey values.
  const misc = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'misc.routes.js'), 'utf8');
  for (const match of misc.matchAll(/titleKey:\s*'([^']+)'/g)) {
    assert.ok(enKeys.has(match[1]), `API returns titleKey ${match[1]} with no translation`);
  }
});

function objectKeys(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} not found`);
  // Read to the line that closes the object literal at column 0.
  const rest = source.slice(start);
  const end = rest.indexOf('\n};');
  const block = rest.slice(0, end === -1 ? rest.length : end);
  const keys = new Set();
  for (const match of block.matchAll(/^ {2}(?:async )?(?:'([^']+)'|([A-Za-z$_][\w$]*))\(/gm)) {
    keys.add(match[1] || match[2]);
  }
  return keys;
}

function allHandlers() {
  return new Set([
    ...objectKeys(sources['app.js'], 'const actions = {'),
    ...objectKeys(sources['app.js'], 'const changeActions = {'),
    ...objectKeys(sources['app.js'], 'const submitActions = {')
  ]);
}

test('every declared data-action has a handler', () => {
  const clickHandlers = objectKeys(sources['app.js'], 'const actions = {');
  const submitHandlers = objectKeys(sources['app.js'], 'const submitActions = {');
  assert.ok(clickHandlers.size > 15, `expected many click handlers, found ${clickHandlers.size}`);
  assert.ok(submitHandlers.size > 8, `expected many submit handlers, found ${submitHandlers.size}`);

  const handlers = allHandlers();
  const declared = new Set();
  for (const match of allSource.matchAll(/data-action="([a-z-]+)"/g)) declared.add(match[1]);

  const orphans = [...declared].filter(name => !handlers.has(name));
  assert.deepEqual(orphans, [], `data-action values with no handler: ${orphans.join(', ')}`);
});

test('every handler is actually reachable from markup', () => {
  const declared = new Set();
  for (const match of allSource.matchAll(/data-action="([a-z-]+)"/g)) declared.add(match[1]);

  const unused = [...allHandlers()].filter(name => !declared.has(name));
  assert.deepEqual(unused, [], `handlers never referenced by markup: ${unused.join(', ')}`);
});

test('click, change and submit events are all delegated', () => {
  const app = sources['app.js'];
  for (const type of ['click', 'change', 'submit']) {
    assert.ok(app.includes(`document.addEventListener('${type}'`), `${type} is not delegated`);
  }
});

function routePatterns() {
  const patterns = [];
  const routesBlock = sources['app.js'].slice(sources['app.js'].indexOf('const ROUTES = ['));
  for (const match of routesBlock.matchAll(/pattern:\s*\/((?:\\.|\[[^\]]*\]|[^/\\])+)\//g)) {
    patterns.push(new RegExp(match[1]));
  }
  return patterns;
}

test('every static in-app link points at a route that exists', () => {
  const patterns = routePatterns();
  assert.ok(patterns.length > 20, `expected the route table to be parsed, found ${patterns.length}`);

  const targets = new Set();
  for (const match of allSource.matchAll(/href="(#\/[^"${]*)"/g)) targets.add(match[1]);
  for (const match of allSource.matchAll(/go\('(#\/[^'${]*)'\)/g)) targets.add(match[1]);
  for (const match of allSource.matchAll(/data-href="(#\/[^"${]*)"/g)) targets.add(match[1]);

  assert.ok(targets.size > 12, `expected many static links, found ${targets.size}`);

  const unroutable = [...targets].filter(target => {
    const path = target.replace(/^#/, '');
    return !patterns.some(pattern => pattern.test(path));
  });
  assert.deepEqual(unroutable, [], `links with no matching route: ${unroutable.join(', ')}`);
});

test('every role home target is routable and role-guarded', () => {
  const patterns = routePatterns();
  for (const home of ['/worker', '/employer', '/consultancy', '/admin']) {
    assert.ok(patterns.some(p => p.test(home)), `${home} has no route`);
  }
  // Each protected route declares the roles allowed to open it.
  const routesBlock = sources['app.js'].slice(sources['app.js'].indexOf('const ROUTES = ['));
  const entries = routesBlock.split('{ pattern:').slice(1);
  const unguarded = entries.filter(entry => !/public:\s*true/.test(entry) && !/roles:\s*\[/.test(entry));
  assert.deepEqual(unguarded, [], 'every non-public route must declare roles');
});

test('no inline event handlers are generated anywhere', () => {
  // Inline handlers would require script-src 'unsafe-inline'; the whole point
  // of the delegated action system is that none exist.
  for (const [file, source] of Object.entries(sources)) {
    const matches = [...source.matchAll(/\son(click|submit|change|input|keydown|load|error)\s*=/g)];
    assert.deepEqual(matches.map(m => m[0]), [], `${file} contains an inline handler`);
  }
  const html = read('index.html');
  assert.equal(/\son[a-z]+\s*=/.test(html), false, 'index.html contains an inline handler');
});

test('interpolated values in templates go through the HTML escaper', () => {
  // Spot-check: no template literal writes a bare ${...} straight into an
  // attribute without esc()/attr() around it.
  const risky = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/(?:href|src|value|placeholder|data-[\w-]+)="\$\{([^}]+)\}"/g)) {
      const expression = match[1];
      // Number() counts as safe: it coerces to a numeric value, so nothing
      // attacker-controlled can reach the attribute.
      if (!/\b(esc|attr|encodeURIComponent|Number)\(/.test(expression)) {
        risky.push(`${file}: ${match[0]}`);
      }
    }
  }
  assert.deepEqual(risky, [], `unescaped attribute interpolation: ${risky.join(' | ')}`);
});

test('the API client sends the CSRF header on mutating requests only', () => {
  const api = sources['api.js'];
  assert.match(api, /X-CSRF-Token/);
  assert.match(api, /MUTATING\s*=\s*new Set\(\['POST', 'PUT', 'PATCH', 'DELETE'\]\)/);
  assert.match(api, /credentials: 'same-origin'/);
  // Errors must surface, never be swallowed into a fake success.
  assert.match(api, /throw new ApiError/);
});

test('the frontend never stores a session token in browser storage', () => {
  // The session lives in an httpOnly cookie; only the language preference is
  // kept client-side.
  const storageWrites = [...allSource.matchAll(/localStorage\.setItem\(([^,)]+)/g)].map(m => m[1].trim());
  assert.deepEqual(storageWrites, ['STORAGE_KEY'], `unexpected localStorage writes: ${storageWrites.join(', ')}`);
  assert.match(sources['i18n.js'], /STORAGE_KEY = 'wb_lang'/);
  assert.equal(/localStorage[^\n]*token/i.test(allSource), false);
  assert.equal(/localStorage[^\n]*password/i.test(allSource), false);
});

test('the assistant UI reports its mode from the server response', () => {
  const assistant = sources['assistant.js'];
  assert.match(assistant, /assistant\.modeLive/);
  assert.match(assistant, /assistant\.modeFallback/);
  assert.match(assistant, /state\.lastMode/);
  // The disclaimer is rendered on every view of the panel.
  assert.match(assistant, /assistant\.indicativeNote/);
  // A failed request keeps the question and offers a retry.
  assert.match(assistant, /lastFailedMessage/);
});

test('destructive actions go through a confirmation dialogue', () => {
  const app = sources['app.js'];
  for (const action of ['delete-document', 'delete-job', 'user-status']) {
    const index = app.indexOf(`'${action}'(el)`);
    assert.notEqual(index, -1, `${action} handler not found`);
    const body = app.slice(index, index + 900);
    assert.match(body, /confirmDialog|dialog\(/, `${action} must confirm before acting`);
  }
  // Removing a listing from the review queue confirms twice: once for the
  // irreversible delete and once for the recorded reason.
  const fraudIndex = app.indexOf("'fraud-action'(el)");
  const fraudBody = app.slice(fraudIndex, fraudIndex + 1200);
  assert.match(fraudBody, /confirmDialog/);
  assert.match(fraudBody, /actionReason/);
});

test('forms carry labels and required markers', () => {
  const ui = sources['ui.js'];
  // Every generated control is label-bound by id.
  assert.match(ui, /<label for="\$\{attr\(id\)\}">/);
  assert.match(ui, /aria-required="true"/);
  assert.match(ui, /aria-invalid/);
  assert.match(ui, /role="alert"/);
  // The modal traps focus and restores it.
  assert.match(ui, /aria-modal="true"/);
  assert.match(ui, /previouslyFocused/);
});

test('loading, empty and error states exist for list views', () => {
  const ui = sources['ui.js'];
  assert.match(ui, /export function skeleton/);
  assert.match(ui, /export function emptyState/);
  assert.match(ui, /export function errorState/);

  const app = sources['app.js'];
  assert.match(app, /skeleton\(/);
  assert.match(app, /emptyState\(/);
  assert.match(app, /errorState\(/);
  // A failed view render shows the error state rather than a blank page.
  assert.match(app, /catch \(err\) \{[\s\S]{0,800}errorState/);
});

test('the stylesheet defines the Tamil font stack and mobile rules', () => {
  const css = read('components.css');
  assert.match(css, /Noto Sans Tamil/);
  assert.match(css, /html\[data-lang="ta"\]/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.visually-hidden/);
});
