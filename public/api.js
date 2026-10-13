/**
 * Thin API client.
 *
 * Responsibilities:
 *  - attach the CSRF header that cookie-authenticated mutations require
 *  - turn every non-2xx response into a typed ApiError carrying the server's
 *    machine-readable code, so views can translate it
 *  - never fabricate a successful result when a request fails
 */

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function csrfFromCookie() {
  const match = /(?:^|;\s*)wb_csrf=([^;]+)/.exec(document.cookie || '');
  return match ? decodeURIComponent(match[1]) : null;
}

async function request(method, path, { body, formData, query } = {}) {
  const url = new URL(path.replace(/^\//, ''), `${location.origin}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    }
  }

  const headers = { Accept: 'application/json' };
  if (MUTATING.has(method)) {
    const csrf = csrfFromCookie();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const init = { method, headers, credentials: 'same-origin' };
  if (formData) {
    init.body = formData; // the browser sets the multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url.toString(), init);
  } catch (err) {
    throw new ApiError(0, 'NETWORK_ERROR', err && err.message);
  }

  if (res.status === 204) return {};

  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch (_) { payload = null; }
  }

  if (!res.ok) {
    const code = (payload && payload.error) || `HTTP_${res.status}`;
    throw new ApiError(res.status, code, payload && payload.message, payload && payload.details);
  }
  return payload || {};
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, body) => request('POST', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  del: (path, body) => request('DELETE', path, { body }),
  upload: (path, formData) => request('POST', path, { formData })
};
