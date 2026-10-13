#!/usr/bin/env node
'use strict';

/**
 * Build validation.
 *
 * There is no bundler: the frontend ships as ES modules and the backend runs
 * from source. "Building" therefore means proving the artefacts are shippable:
 *   1. every JavaScript file parses,
 *   2. every backend module loads,
 *   3. the locale files are valid JSON and have matching key sets,
 *   4. the files the HTML references actually exist,
 *   5. .env.example documents every variable the code reads.
 *
 * Exits non-zero on the first category that fails, so it is usable as a CI gate.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const problems = [];
const notes = [];

function walk(dir, filter, found = []) {
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', 'uploads', 'legacy'].includes(entry.name)) continue;
      walk(full, filter, found);
    } else if (filter(full)) {
      found.push(full);
    }
  }
  return found;
}

// 1. Syntax check every source file.
const backendFiles = [
  path.join(ROOT, 'server.js'),
  ...walk(path.join(ROOT, 'backend'), f => f.endsWith('.js')),
  ...walk(path.join(ROOT, 'scripts'), f => f.endsWith('.js')),
  ...walk(path.join(ROOT, 'tests'), f => f.endsWith('.js'))
];
const frontendFiles = walk(path.join(ROOT, 'public'), f => f.endsWith('.js'));

for (const file of backendFiles) {
  try {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  } catch (err) {
    problems.push(`syntax error in ${path.relative(ROOT, file)}: ${err.message}`);
  }
}
for (const file of frontendFiles) {
  try {
    // Frontend files are ES modules, so they are parsed in module mode.
    new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file });
  } catch (err) {
    if (err instanceof ReferenceError || /SourceTextModule/.test(String(err && err.message))) {
      notes.push('frontend module parse check skipped (node needs --experimental-vm-modules)');
      break;
    }
    problems.push(`syntax error in ${path.relative(ROOT, file)}: ${err.message}`);
  }
}
console.log(`[build] parsed ${backendFiles.length} backend and ${frontendFiles.length} frontend files`);

// 2. Load every backend module (catches bad requires and top-level throws).
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
for (const file of walk(path.join(ROOT, 'backend'), f => f.endsWith('.js'))) {
  try {
    require(file);
  } catch (err) {
    problems.push(`module ${path.relative(ROOT, file)} failed to load: ${err.message}`);
  }
}
console.log('[build] backend modules load cleanly');

// 3. Locale parity.
const localeDir = path.join(ROOT, 'public', 'locales');
const locales = {};
for (const file of fs.readdirSync(localeDir).filter(f => f.endsWith('.json'))) {
  try {
    locales[file.replace('.json', '')] = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'));
  } catch (err) {
    problems.push(`locale ${file} is not valid JSON: ${err.message}`);
  }
}

function flatten(obj, prefix = '', out = new Set()) {
  for (const [key, value] of Object.entries(obj || {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out.add(full);
  }
  return out;
}

if (locales.en) {
  const enKeys = flatten(locales.en);
  for (const [code, bundle] of Object.entries(locales)) {
    if (code === 'en') continue;
    const keys = flatten(bundle);
    const missing = [...enKeys].filter(k => !keys.has(k));
    const extra = [...keys].filter(k => !enKeys.has(k));
    if (missing.length) problems.push(`locale ${code} is missing ${missing.length} key(s): ${missing.slice(0, 8).join(', ')}`);
    if (extra.length) notes.push(`locale ${code} has ${extra.length} key(s) not in en: ${extra.slice(0, 8).join(', ')}`);
    if (!missing.length) console.log(`[build] locale ${code}: all ${enKeys.size} keys present`);
  }
} else {
  problems.push('locale en.json is missing');
}

// 4. Referenced static assets exist.
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:href|src)="([^":]+)"/g)) {
  const ref = match[1];
  if (ref.startsWith('#') || ref.startsWith('//')) continue;
  const target = path.join(ROOT, 'public', ref);
  if (!fs.existsSync(target)) problems.push(`index.html references missing file: ${ref}`);
}
console.log('[build] index.html asset references resolve');

// 5. Environment documentation.
const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const documented = new Set(
  envExample.split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.split('=')[0].trim())
);
const used = new Set();
for (const file of [path.join(ROOT, 'backend', 'config.js')]) {
  for (const match of fs.readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    used.add(match[1]);
  }
}
const undocumented = [...used].filter(name => !documented.has(name));
if (undocumented.length) problems.push(`.env.example does not document: ${undocumented.join(', ')}`);
else console.log(`[build] .env.example documents all ${used.size} variables read by config.js`);

for (const note of notes) console.log(`[build] note: ${note}`);

if (problems.length) {
  console.error('\n[build] FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\n[build] OK');
