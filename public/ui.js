/**
 * Rendering and interaction helpers shared by every view.
 *
 * Views build HTML strings, so `esc` is applied to every interpolated value.
 * Nothing attaches inline event handlers: actions are declared with
 * `data-action` attributes and handled by one delegated listener in app.js,
 * which is what lets the page run under a `script-src 'self'` CSP.
 */

import { t } from './i18n.js';

export function esc(value) {
  return String(value === undefined || value === null ? '' : value).replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

export function attr(value) {
  return esc(value).replace(/\n/g, ' ');
}

export function badge(text, variant = '') {
  return `<span class="badge ${variant}">${esc(text)}</span>`;
}

export function chip(text) {
  return `<span class="chip">${esc(text)}</span>`;
}

export function progressBar(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<div class="progress" role="progressbar" aria-valuenow="${safe}" aria-valuemin="0" aria-valuemax="100">
    <span style="width:${safe}%"></span>
  </div>`;
}

export function skeleton(rows = 3) {
  return `<div class="skeleton-wrap" aria-busy="true" aria-label="${attr(t('a11y.loadingRegion'))}">
    ${Array.from({ length: rows }).map(() => '<div class="skeleton"></div>').join('')}
  </div>`;
}

export function emptyState(title, copy, actionLabel, actionAttrs = '') {
  return `<div class="card">
    <div class="empty">
      <h3>${esc(title)}</h3>
      ${copy ? `<p class="muted">${esc(copy)}</p>` : ''}
      ${actionLabel ? `<button class="btn primary" ${actionAttrs}>${esc(actionLabel)}</button>` : ''}
    </div>
  </div>`;
}

export function errorState(message, retryAttrs = '') {
  return `<div class="card danger-card">
    <div class="empty">
      <h3>${esc(message)}</h3>
      ${retryAttrs ? `<button class="btn" ${retryAttrs}>${esc(t('common.retry'))}</button>` : ''}
    </div>
  </div>`;
}

export function field({ id, label, type = 'text', value = '', placeholder = '', hint = '', required = false, autocomplete = '', attrs = '' }) {
  return `<div class="field">
    <label for="${attr(id)}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
    <input class="input" id="${attr(id)}" name="${attr(id)}" type="${attr(type)}"
      value="${attr(value)}" placeholder="${attr(placeholder)}"
      ${required ? 'required aria-required="true"' : ''}
      ${autocomplete ? `autocomplete="${attr(autocomplete)}"` : ''} ${attrs}>
    ${hint ? `<small class="muted">${esc(hint)}</small>` : ''}
    <small class="field-error" id="${attr(id)}-error" role="alert"></small>
  </div>`;
}

export function textarea({ id, label, value = '', placeholder = '', rows = 4, required = false, hint = '' }) {
  return `<div class="field">
    <label for="${attr(id)}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
    <textarea class="textarea" id="${attr(id)}" name="${attr(id)}" rows="${rows}"
      placeholder="${attr(placeholder)}" ${required ? 'required aria-required="true"' : ''}>${esc(value)}</textarea>
    ${hint ? `<small class="muted">${esc(hint)}</small>` : ''}
    <small class="field-error" id="${attr(id)}-error" role="alert"></small>
  </div>`;
}

export function select({ id, label, options, value = '', required = false, hint = '' }) {
  return `<div class="field">
    <label for="${attr(id)}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
    <select class="select" id="${attr(id)}" name="${attr(id)}" ${required ? 'required aria-required="true"' : ''}>
      ${options.map(o => `<option value="${attr(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>
    ${hint ? `<small class="muted">${esc(hint)}</small>` : ''}
    <small class="field-error" id="${attr(id)}-error" role="alert"></small>
  </div>`;
}

export function passwordField({ id, label, hint = '', autocomplete = 'current-password', required = true }) {
  return `<div class="field">
    <label for="${attr(id)}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
    <div class="password-wrap">
      <input class="input" id="${attr(id)}" name="${attr(id)}" type="password"
        autocomplete="${attr(autocomplete)}" ${required ? 'required aria-required="true"' : ''}>
      <button type="button" class="btn small ghost-inline" data-action="toggle-password" data-target="${attr(id)}"
        aria-label="${attr(t('a11y.togglePassword'))}">${esc(t('common.show'))}</button>
    </div>
    ${hint ? `<small class="muted">${esc(hint)}</small>` : ''}
    <small class="field-error" id="${attr(id)}-error" role="alert"></small>
  </div>`;
}

export function checkbox({ id, label, checked = false }) {
  return `<label class="checkbox"><input type="checkbox" id="${attr(id)}" name="${attr(id)}" ${checked ? 'checked' : ''}> <span>${esc(label)}</span></label>`;
}

// --- transient UI -----------------------------------------------------------

let toastTimer = null;

export function toast(message, variant = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${variant}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 4200);
}

export function setFieldError(id, message) {
  const input = document.getElementById(id);
  const error = document.getElementById(`${id}-error`);
  if (error) error.textContent = message || '';
  if (input) {
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    input.classList.toggle('has-error', Boolean(message));
  }
}

export function clearFieldErrors(scope = document) {
  scope.querySelectorAll('.field-error').forEach(el => { el.textContent = ''; });
  scope.querySelectorAll('[aria-invalid="true"]').forEach(el => {
    el.setAttribute('aria-invalid', 'false');
    el.classList.remove('has-error');
  });
}

export function setButtonBusy(button, busy, busyLabel) {
  if (!button) return;
  if (busy) {
    button.dataset.idleLabel = button.dataset.idleLabel || button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyLabel) button.textContent = busyLabel;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
  }
}

/**
 * Accessible modal dialogue. Resolves with the collected values, or null when
 * dismissed. Used for every destructive confirmation, so no action that
 * deletes or suspends happens without one.
 */
export function dialog({ title, body = '', fields = [], confirmLabel, cancelLabel, danger = false }) {
  return new Promise(resolve => {
    const host = document.getElementById('modal-root');
    const previouslyFocused = document.activeElement;

    host.innerHTML = `
      <div class="modal-backdrop" data-modal-backdrop>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="modal-head">
            <h2 id="modal-title">${esc(title)}</h2>
            <button class="btn small" data-modal-cancel aria-label="${attr(t('a11y.closeDialog'))}">✕</button>
          </div>
          ${body ? `<p class="muted">${esc(body)}</p>` : ''}
          ${fields.length ? `<div class="modal-fields">${fields.map(f => {
      if (f.type === 'textarea') return textarea({ id: `modal-${f.name}`, label: f.label, placeholder: f.placeholder || '', rows: 3, required: f.required });
      if (f.type === 'select') return select({ id: `modal-${f.name}`, label: f.label, options: f.options, value: f.value || '', required: f.required });
      return field({ id: `modal-${f.name}`, label: f.label, type: f.inputType || 'text', value: f.value || '', placeholder: f.placeholder || '', required: f.required });
    }).join('')}</div>` : ''}
          <div class="modal-actions">
            <button class="btn" data-modal-cancel>${esc(cancelLabel || t('common.cancel'))}</button>
            <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-modal-confirm>${esc(confirmLabel || t('common.confirm'))}</button>
          </div>
        </div>
      </div>`;

    const close = result => {
      host.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(result);
    };

    const collect = () => {
      const values = {};
      let valid = true;
      for (const f of fields) {
        const input = document.getElementById(`modal-${f.name}`);
        const value = input ? input.value.trim() : '';
        if (f.required && !value) {
          setFieldError(`modal-${f.name}`, t('validation.FIELD_REQUIRED'));
          valid = false;
        } else {
          setFieldError(`modal-${f.name}`, '');
        }
        values[f.name] = value;
      }
      return valid ? values : null;
    };

    function onKey(event) {
      if (event.key === 'Escape') close(null);
      if (event.key === 'Tab') {
        // Keep keyboard focus inside the dialogue.
        const focusables = host.querySelectorAll('button, input, select, textarea, [href]');
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    host.querySelectorAll('[data-modal-cancel]').forEach(b => b.addEventListener('click', () => close(null)));
    host.querySelector('[data-modal-confirm]').addEventListener('click', () => {
      const values = collect();
      if (values) close(values);
    });
    host.querySelector('[data-modal-backdrop]').addEventListener('click', event => {
      if (event.target === event.currentTarget) close(null);
    });
    document.addEventListener('keydown', onKey);

    const firstInput = host.querySelector('input, textarea, select') || host.querySelector('[data-modal-confirm]');
    if (firstInput) firstInput.focus();
  });
}

export function confirmDialog(title, body, { danger = true, confirmLabel } = {}) {
  return dialog({ title, body, confirmLabel, danger }).then(result => result !== null);
}

export function formatDate(value, withTime = false) {
  if (!value) return t('common.notAvailable');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const opts = withTime
    ? { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  try {
    return date.toLocaleDateString(document.documentElement.lang || 'en', opts);
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0])
    .join('')
    .toUpperCase();
}
