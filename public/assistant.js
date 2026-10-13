/**
 * WorkBridge AI assistant UI.
 *
 * One state object drives two surfaces: the floating panel (available on every
 * signed-in page) and the full-page view. Both talk to POST /api/ai/chat; the
 * reply's `mode` field decides whether the header says "live AI" or "offline
 * answer mode", so the interface never implies a model answered when one did
 * not.
 */

import { api, ApiError } from './api.js';
import { t, lang, tError } from './i18n.js';
import { esc, attr, toast } from './ui.js';

const state = {
  open: false,
  loaded: false,
  loading: false,
  sending: false,
  messages: [],
  suggestions: [],
  provider: 'fallback',
  model: null,
  lastMode: null,
  lastNote: null,
  error: null,
  lastFailedMessage: null
};

let getUser = () => null;

export function configureAssistant({ currentUser }) {
  getUser = currentUser;
}

export function assistantState() {
  return state;
}

export function resetAssistantCache() {
  state.loaded = false;
  state.messages = [];
  state.error = null;
  state.lastMode = null;
}

async function loadHistory() {
  if (state.loaded || state.loading) return;
  state.loading = true;
  renderAll();
  try {
    const res = await api.get('/api/ai/chat', { lang: lang() });
    state.messages = (res.messages || []).map(m => ({
      role: m.role,
      content: m.content,
      mode: m.mode || null,
      at: m.at
    }));
    state.suggestions = res.suggestions || [];
    state.provider = res.provider;
    state.model = res.model;
    state.loaded = true;
    state.error = null;
  } catch (err) {
    state.error = err instanceof ApiError ? tError(err.code, err.message) : t('validation.unknownError');
  } finally {
    state.loading = false;
    renderAll();
  }
}

export async function sendAssistantMessage(text) {
  const message = String(text || '').trim();
  if (!message || state.sending) return;

  state.messages.push({ role: 'user', content: message, at: new Date().toISOString() });
  state.sending = true;
  state.error = null;
  state.lastFailedMessage = null;
  renderAll();

  try {
    const res = await api.post('/api/ai/chat', { message, lang: lang() });
    state.messages.push({
      role: 'assistant',
      content: res.reply,
      mode: res.mode,
      at: res.timestamp
    });
    state.lastMode = res.mode;
    state.lastNote = res.providerNote || null;
    state.suggestions = res.suggestions || state.suggestions;
  } catch (err) {
    // The failed question stays on screen with a retry affordance rather than
    // being replaced by an invented answer.
    state.error = err instanceof ApiError ? tError(err.code, err.message) : t('validation.unknownError');
    state.lastFailedMessage = message;
    toast(state.error, 'error');
  } finally {
    state.sending = false;
    renderAll();
    focusInput();
  }
}

export async function clearConversation() {
  try {
    await api.del('/api/ai/chat');
    state.messages = [];
    state.error = null;
    state.lastMode = null;
    toast(t('assistant.cleared'), 'success');
  } catch (err) {
    toast(err instanceof ApiError ? tError(err.code, err.message) : t('validation.unknownError'), 'error');
  }
  renderAll();
}

export function toggleAssistant(force) {
  state.open = force === undefined ? !state.open : Boolean(force);
  if (state.open) loadHistory();
  renderAll();
  if (state.open) focusInput();
}

function focusInput() {
  const input = document.querySelector('[data-assistant-input]:not([disabled])');
  if (input) input.focus();
}

function modeBanner() {
  const live = state.provider === 'anthropic' && state.lastMode !== 'fallback';
  if (live) {
    return `<div class="assistant-mode live">${esc(t('assistant.modeLive', { model: state.model || '' }))}</div>`;
  }
  const note = state.lastNote && state.lastNote !== 'AI_PROVIDER_NOT_CONFIGURED'
    ? t('assistant.fallbackDegraded')
    : t('assistant.fallbackExplainer');
  return `<div class="assistant-mode fallback">
    <strong>${esc(t('assistant.modeFallback'))}</strong>
    <span>${esc(note)}</span>
  </div>`;
}

function messageList() {
  if (state.loading) {
    return `<div class="assistant-empty"><p class="muted">${esc(t('common.loading'))}</p></div>`;
  }
  if (!state.messages.length) {
    return `<div class="assistant-empty">
      <h3>${esc(t('assistant.emptyTitle'))}</h3>
      <p class="muted">${esc(t('assistant.emptyCopy'))}</p>
    </div>`;
  }
  return state.messages.map(message => {
    const isUser = message.role === 'user';
    const label = isUser ? t('assistant.you') : t('assistant.assistant');
    return `<div class="bubble-row ${isUser ? 'user' : 'ai'}">
      <span class="bubble-label">${esc(label)}</span>
      <div class="bubble ${isUser ? 'user' : 'ai'}">${esc(message.content).replace(/\n/g, '<br>')}</div>
    </div>`;
  }).join('');
}

function suggestionChips() {
  if (!state.suggestions.length) return '';
  // Suggestions stay available for the whole conversation, not only on an empty
  // one; the list is just trimmed once a conversation is under way.
  const shown = state.messages.length ? state.suggestions.slice(0, 3) : state.suggestions;
  return `<div class="assistant-suggestions">
    <span class="muted suggestion-title">${esc(t('assistant.suggestions'))}</span>
    <div class="chips">
      ${shown.map(s => `<button type="button" class="chip chip-button" data-action="assistant-suggest" data-text="${attr(s)}">${esc(s)}</button>`).join('')}
    </div>
  </div>`;
}

function composer() {
  return `<form class="assistant-composer" data-action="assistant-send">
    <label class="visually-hidden" for="assistant-input">${esc(t('assistant.inputPlaceholder'))}</label>
    <input class="input" id="assistant-input" data-assistant-input autocomplete="off"
      placeholder="${attr(t('assistant.inputPlaceholder'))}" ${state.sending ? 'disabled' : ''}>
    <button class="btn primary" type="submit" ${state.sending ? 'disabled aria-busy="true"' : ''}>
      ${esc(state.sending ? t('assistant.thinking') : t('assistant.send'))}
    </button>
  </form>`;
}

function statusRow() {
  const parts = [];
  if (state.sending) {
    parts.push(`<div class="assistant-typing" role="status" aria-live="polite">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span>${esc(t('assistant.thinking'))}</span>
    </div>`);
  }
  if (state.error) {
    parts.push(`<div class="assistant-error" role="alert">
      <strong>${esc(t('assistant.errorTitle'))}</strong>
      <span>${esc(state.error)}</span>
      ${state.lastFailedMessage ? `<button class="btn small" data-action="assistant-retry">${esc(t('assistant.errorRetry'))}</button>` : ''}
    </div>`);
  }
  return parts.join('');
}

export function assistantBody({ compact = false } = {}) {
  return `
    ${modeBanner()}
    <div class="assistant-log" data-assistant-log aria-live="polite" ${compact ? 'style="max-height:46vh"' : ''}>
      ${messageList()}
    </div>
    ${statusRow()}
    ${suggestionChips()}
    <p class="assistant-disclaimer">${esc(t('assistant.indicativeNote'))}</p>
    ${composer()}`;
}

export function assistantPanel() {
  const user = getUser();
  if (!user) return '';
  return `
    <button class="assistant-launcher" data-action="assistant-toggle"
      aria-expanded="${state.open ? 'true' : 'false'}" aria-controls="assistant-panel"
      aria-label="${attr(t('assistant.launcherLabel'))}">
      <span aria-hidden="true">💬</span>
      <span class="assistant-launcher-text">${esc(t('assistant.open'))}</span>
    </button>
    <section id="assistant-panel" class="assistant-panel ${state.open ? 'open' : ''}"
      ${state.open ? '' : 'hidden'} aria-label="${attr(t('assistant.title'))}">
      <header class="assistant-head">
        <div>
          <strong>${esc(t('assistant.title'))}</strong>
          <div class="muted assistant-sub">${esc(t('assistant.subtitle'))}</div>
        </div>
        <div class="row">
          <button class="btn small" data-action="assistant-reset" title="${attr(t('assistant.reset'))}">↺</button>
          <button class="btn small" data-action="assistant-toggle" aria-label="${attr(t('assistant.close'))}">✕</button>
        </div>
      </header>
      ${assistantBody({ compact: true })}
    </section>`;
}

function renderAll() {
  const panelHost = document.getElementById('assistant-root');
  if (panelHost) panelHost.innerHTML = assistantPanel();

  const pageHost = document.querySelector('[data-assistant-page]');
  if (pageHost) pageHost.innerHTML = assistantBody();

  document.querySelectorAll('[data-assistant-log]').forEach(log => {
    log.scrollTop = log.scrollHeight;
  });
}

export function ensureAssistantLoaded() {
  return loadHistory();
}

export function renderAssistant() {
  renderAll();
}
