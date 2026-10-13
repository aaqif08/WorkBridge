/**
 * Translation layer.
 *
 * All user-facing text comes from locales/<code>.json. Views call t('key') and
 * never embed a language conditional, so adding a third language is a matter of
 * adding one file plus one entry in SUPPORTED.
 */

export const SUPPORTED = [
  { code: 'en', label: 'English' },
  { code: 'ta', label: 'தமிழ்' }
];

const STORAGE_KEY = 'wb_lang';
const bundles = new Map();

let current = 'en';
const listeners = new Set();

function readStored() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED.some(l => l.code === stored)) return stored;
  } catch (_) { /* private mode */ }
  // Fall back to the browser's own preference before defaulting to English.
  const navLang = (navigator.language || '').slice(0, 2).toLowerCase();
  return SUPPORTED.some(l => l.code === navLang) ? navLang : 'en';
}

async function loadBundle(code) {
  if (bundles.has(code)) return bundles.get(code);
  const res = await fetch(`locales/${code}.json`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Could not load locale ${code}`);
  const bundle = await res.json();
  bundles.set(code, bundle);
  return bundle;
}

function lookup(bundle, key) {
  return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), bundle);
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
    (params[name] === undefined || params[name] === null ? match : String(params[name])));
}

/** Translate `key`. Missing keys fall back to English, then to the key itself. */
export function t(key, params) {
  const bundle = bundles.get(current);
  let value = bundle ? lookup(bundle, key) : undefined;
  if (typeof value !== 'string') {
    const fallback = bundles.get('en');
    value = fallback ? lookup(fallback, key) : undefined;
  }
  if (typeof value !== 'string') {
    if (window.__WB_DEBUG_I18N) console.warn(`[i18n] missing key: ${key}`);
    return key;
  }
  return interpolate(value, params);
}

/** Translate a server error code into a sentence in the active language. */
export function tError(code, fallbackMessage) {
  if (!code) return t('validation.unknownError');
  const translated = t(`validation.${code}`);
  if (translated !== `validation.${code}`) return translated;
  return fallbackMessage || t('validation.unknownError');
}

export function lang() {
  return current;
}

export function languageLabel(code = current) {
  const entry = SUPPORTED.find(l => l.code === code);
  return entry ? entry.label : code;
}

export function onLanguageChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function applyDocumentLanguage() {
  const bundle = bundles.get(current);
  document.documentElement.lang = current;
  document.documentElement.dir = (bundle && bundle.meta && bundle.meta.dir) || 'ltr';
  // Drives the Tamil-aware font stack in style.css.
  document.documentElement.dataset.lang = current;
}

/** Switch language, loading the bundle on demand. */
export async function setLanguage(code, { persist = true } = {}) {
  if (!SUPPORTED.some(l => l.code === code)) return current;
  await loadBundle(code);
  current = code;
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, code); } catch (_) { /* private mode */ }
  }
  applyDocumentLanguage();
  for (const listener of listeners) listener(code);
  return current;
}

/**
 * Loads English (the fallback bundle) plus the preferred language.
 * `preferred` lets the signed-in account's saved language win over the device.
 */
export async function initI18n(preferred) {
  await loadBundle('en');
  const target = preferred && SUPPORTED.some(l => l.code === preferred) ? preferred : readStored();
  await setLanguage(target, { persist: Boolean(preferred) });
  return current;
}
