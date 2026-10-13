/**
 * Live API smoke test against a running WorkBridge instance.
 *
 * Exercises every documented endpoint over the cookie transport, which also
 * covers the CSRF double-submit path that the node:test suite bypasses by
 * using bearer tokens. Run it against a development instance:
 *   npm start
 *   npm run verify:api -- http://127.0.0.1:5000 <demo password>
 *
 * It signs in as the seeded demo accounts, so it needs an instance started
 * with SEED_DEMO_DATA=true. It exits non-zero if any check fails.
 */

const BASE = process.argv[2] || 'http://127.0.0.1:5000';
const PASSWORD = process.argv[3] || process.env.DEMO_PASSWORD || 'SmokePassw0rd';

const results = [];
let cookies = {};

function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function captureCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (value === '' ) delete cookies[name];
    else cookies[name] = value;
  }
}

async function call(method, path, { body, form, expect } = {}) {
  const headers = { Accept: 'application/json' };
  if (Object.keys(cookies).length) headers.Cookie = cookieHeader();
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && cookies.wb_csrf) {
    headers['X-CSRF-Token'] = decodeURIComponent(cookies.wb_csrf);
  }
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
  captureCookies(res);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* html or binary */ }

  const ok = expect === undefined ? res.ok : (Array.isArray(expect) ? expect.includes(res.status) : res.status === expect);
  results.push({ label: `${method} ${path}`, status: res.status, ok });
  if (!ok) {
    console.error(`  !! ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return { status: res.status, json, text };
}

function logout() { cookies = {}; }

async function login(identifier) {
  logout();
  const res = await call('POST', '/api/auth/login', { body: { identifier, password: PASSWORD }, expect: 200 });
  if (!cookies.wb_session) throw new Error(`no session cookie set for ${identifier}`);
  return res.json && res.json.user;
}

(async () => {
  console.log(`Smoke testing ${BASE}\n`);

  // --- public surface ---
  await call('GET', '/health', { expect: 200 });
  await call('GET', '/', { expect: 200 });
  await call('GET', '/locales/ta.json', { expect: 200 });
  await call('GET', '/api/jobs', { expect: 200 });
  await call('GET', '/api/salary-guide', { expect: 200 });
  await call('GET', '/api/meta', { expect: 200 });
  await call('GET', '/api/ai/suggestions?lang=ta', { expect: 200 });
  await call('GET', '/api/applications', { expect: 401 });
  await call('GET', '/api/admin/stats', { expect: 401 });

  const jobsRes = await call('GET', '/api/jobs?pageSize=1', { expect: 200 });
  const someJobId = jobsRes.json.data[0].id;
  await call('GET', `/api/jobs/${someJobId}`, { expect: 200 });
  await call('GET', '/api/jobs/999999', { expect: 404 });

  // --- CSRF behaviour on the cookie transport ---
  console.log('\n-- cookie/CSRF --');
  await login('worker@demo.workbridge.local');
  const savedCsrf = cookies.wb_csrf;
  delete cookies.wb_csrf;
  await call('POST', '/api/ai/chat', { body: { message: 'csrf check' }, expect: 403 });
  cookies.wb_csrf = savedCsrf;
  await call('POST', '/api/ai/chat', { body: { message: 'How does the visa process work?', lang: 'en' }, expect: 200 });

  // --- worker surface ---
  console.log('\n-- worker --');
  await call('GET', '/api/auth/me', { expect: 200 });
  await call('GET', '/api/applications', { expect: 200 });
  await call('GET', '/api/visa/my-status', { expect: 200 });
  await call('GET', '/api/documents', { expect: 200 });
  await call('GET', '/api/messages', { expect: 200 });
  await call('GET', '/api/notifications', { expect: 200 });
  await call('GET', '/api/ai/chat', { expect: 200 });

  const taChat = await call('POST', '/api/ai/chat', { body: { message: 'வெளிநாட்டில் வேலை பெறுவது எப்படி?' }, expect: 200 });
  const tamilOk = /[஀-௿]/.test(taChat.json.reply) && taChat.json.lang === 'ta';
  results.push({ label: 'AI replies in Tamil', status: tamilOk ? 'yes' : 'no', ok: tamilOk });

  // multipart upload over the cookie transport
  const form = new FormData();
  form.append('name', 'Smoke test passport');
  form.append('type', 'passport');
  form.append('file', new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])], { type: 'application/pdf' }), 'smoke.pdf');
  const uploaded = await call('POST', '/api/documents/upload', { form, expect: 201 });
  if (uploaded.json && uploaded.json.data) {
    await call('GET', `/api/documents/${uploaded.json.data.id}/file`, { expect: 200 });
    await call('PATCH', `/api/documents/${uploaded.json.data.id}`, { body: { status: 'Verified' }, expect: 403 });
    await call('DELETE', `/api/documents/${uploaded.json.data.id}`, { expect: 200 });
  }

  await call('POST', '/api/jobs', { body: { title: 'Worker should not post' }, expect: 403 });

  // --- employer surface ---
  console.log('\n-- employer --');
  await login('employer@demo.workbridge.local');
  await call('GET', '/api/jobs?scope=mine', { expect: 200 });
  const created = await call('POST', '/api/jobs', {
    body: {
      title: 'Smoke Test Electrician',
      company: 'Smoke Test Co',
      category: 'Electrician',
      country: 'Qatar',
      city: 'Doha',
      salary: 'QAR 1,900 - 2,200 / month',
      exp: '3+ years',
      hours: '8 hours',
      vacancies: 4,
      visa: 'Yes',
      benefits: ['Accommodation'],
      description: 'Industrial electrician for a commercial fit-out project in Doha, reporting to the site engineer.',
      requirements: 'ITI electrical certificate and three years of site experience.'
    },
    expect: 201
  });
  const newJobId = created.json.data.id;
  await call('PATCH', `/api/jobs/${newJobId}`, { body: { vacancies: 6 }, expect: 200 });
  await call('GET', `/api/jobs/${newJobId}/applicants`, { expect: 200 });
  await call('GET', '/api/applications', { expect: 200 });
  await call('GET', '/api/admin/fraud-queue', { expect: 403 });
  await call('DELETE', `/api/jobs/${newJobId}`, { expect: 200 });

  // --- consultancy surface ---
  console.log('\n-- consultancy --');
  await login('consultancy@demo.workbridge.local');
  const cases = await call('GET', '/api/visa/cases', { expect: 200 });
  await call('GET', '/api/consultancy/cases', { expect: 200 });
  if (cases.json.data.length) {
    const caseId = cases.json.data[0].id;
    await call('GET', `/api/visa/cases/${caseId}`, { expect: 200 });
    await call('PATCH', '/api/visa/stages', {
      body: { caseId, stageName: 'Visa Stamping', status: 'done', note: 'Smoke test update' },
      expect: 200
    });
    await call('PATCH', '/api/visa/stages', {
      body: { caseId, stageName: 'Departure', status: 'done' },
      expect: 409
    });
  }
  await call('GET', '/api/visa/my-status', { expect: 403 });

  // --- admin surface ---
  console.log('\n-- admin --');
  await login('admin@demo.workbridge.local');
  await call('GET', '/api/admin/stats', { expect: 200 });
  const queue = await call('GET', '/api/admin/fraud-queue', { expect: 200 });
  await call('GET', '/api/admin/users', { expect: 200 });
  await call('GET', '/api/admin/jobs', { expect: 200 });
  await call('GET', '/api/admin/audit-log?limit=20', { expect: 200 });
  if (queue.json.data.length) {
    const target = queue.json.data[0].id;
    await call('POST', '/api/admin/fraud-action', { body: { id: target, action: 'suspend' }, expect: 400 });
    await call('POST', '/api/admin/fraud-action', {
      body: { id: target, action: 'suspend', reason: 'Smoke test: suspended for review' },
      expect: 200
    });
    await call('POST', `/api/admin/jobs/${target}/reassess`, { expect: 200 });
  }

  // --- logout ---
  console.log('\n-- logout --');
  await call('POST', '/api/auth/logout', { expect: 200 });
  await call('GET', '/api/auth/me', { expect: 401 });

  // --- report ---
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const row of results) {
    console.log(`  ${row.ok ? 'PASS' : 'FAIL'}  ${String(row.status).padEnd(4)} ${row.label}`);
  }
  if (failed.length) process.exit(1);
})().catch(err => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
