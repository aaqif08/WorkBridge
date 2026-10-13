'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

test.after(() => h.cleanup());

test('health endpoint reports dependency checks', async () => {
  const http = await h.agent();
  const res = await http.get('/health');
  assert.equal(res.status, 200);
  assert.ok(['healthy', 'degraded'].includes(res.body.status));
  assert.equal(res.body.checks.database.ok, true);
  assert.ok(res.body.checks.aiAssistant.mode);
});

test('registration rejects a weak password', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/register').send({
    name: 'Weak Password User',
    email: 'weak@example.com',
    password: 'short'
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'PASSWORD_TOO_SHORT');
});

test('registration rejects a password with no digit', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/register').send({
    name: 'No Digit User',
    email: 'nodigit@example.com',
    password: 'abcdefghijkl'
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'PASSWORD_NEEDS_NUMBER');
});

test('registration requires an email or a phone number', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/register').send({
    name: 'No Contact',
    password: 'ValidPass123'
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'CONTACT_REQUIRED');
});

test('registration rejects a malformed email', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/register').send({
    name: 'Bad Email',
    email: 'not-an-email',
    password: 'ValidPass123'
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'EMAIL_INVALID');
});

test('registration succeeds, never returns the password hash, and opens a session', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/register').send({
    name: 'Nila R',
    email: 'nila@example.com',
    phone: '+91 90000 55555',
    password: 'ValidPass123',
    confirmPassword: 'ValidPass123',
    role: 'Worker',
    language: 'ta',
    profile: { trade: 'Welder', experienceYears: 4, skills: ['MIG'], preferredCountries: ['UAE'] }
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'Worker');
  assert.equal(res.body.user.language, 'ta');
  assert.ok(res.body.token);
  assert.equal(res.body.user.password, undefined);
  assert.equal(res.body.user.passwordHash, undefined);
  assert.equal(JSON.stringify(res.body).includes('ValidPass123'), false);

  // Password must be stored hashed, never in clear text.
  const stored = h.findUser('nila@example.com');
  assert.ok(stored.passwordHash.startsWith('$2'));
  assert.equal(stored.passwordHash.includes('ValidPass123'), false);

  const me = await http.get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'nila@example.com');
});

test('duplicate email registration is rejected', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/register').send({
    name: 'Nila Again',
    email: 'nila@example.com',
    password: 'ValidPass123'
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'EMAIL_TAKEN');
});

test('duplicate phone registration is rejected regardless of formatting', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/register').send({
    name: 'Same Phone',
    phone: '9000055555',
    password: 'ValidPass123'
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'PHONE_TAKEN');
});

test('public signup cannot create an administrator', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/register').send({
    name: 'Would Be Admin',
    email: 'wannabe-admin@example.com',
    password: 'ValidPass123',
    role: 'Admin'
  });
  // 'Admin' is not in the public signup allow-list, so the request is rejected
  // rather than quietly downgraded.
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'FIELD_VALUE_INVALID');
  assert.equal(h.findUser('wannabe-admin@example.com'), undefined);
});

test('login works with email and with mobile number', async () => {
  const http = await h.agent();
  const byEmail = await http.post('/api/auth/login').send({ identifier: 'nila@example.com', password: 'ValidPass123' });
  assert.equal(byEmail.status, 200);

  const byPhone = await http.post('/api/auth/login').send({ identifier: '9000055555', password: 'ValidPass123' });
  assert.equal(byPhone.status, 200);
  assert.equal(byPhone.body.user.email, 'nila@example.com');
});

test('login with a wrong password fails with a generic message', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/login').send({ identifier: 'nila@example.com', password: 'WrongPass123' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'INVALID_CREDENTIALS');
});

test('login for an unknown account returns the same error as a wrong password', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/login').send({ identifier: 'ghost@example.com', password: 'WrongPass123' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'INVALID_CREDENTIALS');
});

test('repeated failures lock the account temporarily', async () => {
  const http = await h.agent();
  const victim = 'lockme@example.com';
  await http.post('/api/auth/register').send({ name: 'Lock Me', email: victim, password: 'ValidPass123' });

  let locked = null;
  for (let i = 0; i < 12; i += 1) {
    const res = await http.post('/api/auth/login').send({ identifier: victim, password: 'Wrong123456' });
    if (res.status === 429) { locked = res; break; }
  }
  assert.ok(locked, 'expected the account to lock after repeated failures');
  assert.equal(locked.body.error, 'ACCOUNT_TEMPORARILY_LOCKED');

  // The lockout applies even when the correct password is supplied.
  const correct = await http.post('/api/auth/login').send({ identifier: victim, password: 'ValidPass123' });
  assert.equal(correct.status, 429);
});

test('each login issues a new token and logout invalidates only that session', async () => {
  const http = await h.agent();
  const first = await http.post('/api/auth/login').send({ identifier: h.DEMO.worker, password: h.DEMO_PASSWORD });
  const second = await http.post('/api/auth/login').send({ identifier: h.DEMO.worker, password: h.DEMO_PASSWORD });
  assert.notEqual(first.body.token, second.body.token);

  const logout = await http.post('/api/auth/logout').set('Authorization', `Bearer ${first.body.token}`);
  assert.equal(logout.status, 200);

  const reuse = await http.get('/api/auth/me').set('Authorization', `Bearer ${first.body.token}`);
  assert.equal(reuse.status, 401);

  const stillValid = await http.get('/api/auth/me').set('Authorization', `Bearer ${second.body.token}`);
  assert.equal(stillValid.status, 200);
});

test('unauthenticated access to a protected route is 401', async () => {
  const http = await h.agent();
  for (const url of ['/api/auth/me', '/api/applications', '/api/documents', '/api/visa/my-status', '/api/admin/stats']) {
    const res = await http.get(url);
    assert.equal(res.status, 401, `${url} should require authentication`);
    assert.equal(res.body.error, 'AUTH_REQUIRED');
  }
});

test('a forged bearer token is rejected', async () => {
  const http = await h.agent();
  const res = await http.get('/api/auth/me').set('Authorization', 'Bearer not-a-real-token');
  assert.equal(res.status, 401);
});

test('a client cannot change its own role or status through the profile endpoint', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.patch('/api/auth/me', { name: 'Karthik M', role: 'Admin', status: 'suspended' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, 'Worker');
  assert.equal(res.body.user.status, 'active');
});

test('an employer cannot mark itself verified', async () => {
  const employer = await h.as(h.DEMO.employer);
  const res = await employer.patch('/api/auth/me', {
    profile: { companyName: 'ABC Constructions (demo)', verificationStatus: 'verified' }
  });
  assert.equal(res.status, 200);
  assert.notEqual(res.body.user.profile.verificationStatus, 'verified');
});

test('changing the password revokes other sessions and issues a new one', async () => {
  const http = await h.agent();
  const email = 'rotate@example.com';
  await http.post('/api/auth/register').send({ name: 'Rotate Me', email, password: 'ValidPass123' });

  const sessionA = await http.post('/api/auth/login').send({ identifier: email, password: 'ValidPass123' });
  const sessionB = await http.post('/api/auth/login').send({ identifier: email, password: 'ValidPass123' });

  const change = await http.post('/api/auth/change-password')
    .set('Authorization', `Bearer ${sessionB.body.token}`)
    .send({ currentPassword: 'ValidPass123', newPassword: 'BrandNewPass456' });
  assert.equal(change.status, 200);
  assert.ok(change.body.token);

  const oldSession = await http.get('/api/auth/me').set('Authorization', `Bearer ${sessionA.body.token}`);
  assert.equal(oldSession.status, 401);

  const newSession = await http.get('/api/auth/me').set('Authorization', `Bearer ${change.body.token}`);
  assert.equal(newSession.status, 200);

  const oldPassword = await http.post('/api/auth/login').send({ identifier: email, password: 'ValidPass123' });
  assert.equal(oldPassword.status, 401);
});

test('change-password requires the current password', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/auth/change-password', {
    currentPassword: 'NotMyPassword1',
    newPassword: 'AnotherPass123'
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'INVALID_CREDENTIALS');
});

test('password reset reports that no delivery provider is configured and never returns the token', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/forgot-password').send({ identifier: h.DEMO.worker });
  assert.equal(res.status, 202);
  assert.equal(res.body.delivery, 'not_configured');
  assert.equal(JSON.stringify(res.body).includes('tokenHash'), false);
  assert.equal(res.body.token, undefined);

  // The token exists server side (hashed) so the flow can complete once a
  // provider is wired up.
  const stored = h.findUser(h.DEMO.worker);
  assert.ok(stored.passwordReset && stored.passwordReset.tokenHash);

  const bad = await http.post('/api/auth/reset-password').send({ token: 'wrong', newPassword: 'ValidPass123' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'RESET_TOKEN_INVALID');
});

test('a suspended account cannot sign in or use an existing session', async () => {
  const http = await h.agent();
  const email = 'tosuspend@example.com';
  await http.post('/api/auth/register').send({ name: 'To Suspend', email, password: 'ValidPass123' });
  const session = await http.post('/api/auth/login').send({ identifier: email, password: 'ValidPass123' });
  const target = h.findUser(email);

  const admin = await h.as(h.DEMO.admin);
  const suspend = await admin.patch(`/api/admin/users/${target.id}/status`, {
    status: 'suspended',
    reason: 'Automated test suspension'
  });
  assert.equal(suspend.status, 200);

  const afterSuspend = await http.get('/api/auth/me').set('Authorization', `Bearer ${session.body.token}`);
  assert.equal(afterSuspend.status, 401, 'suspension should revoke live sessions');

  const login = await http.post('/api/auth/login').send({ identifier: email, password: 'ValidPass123' });
  assert.equal(login.status, 403);
  assert.equal(login.body.error, 'ACCOUNT_SUSPENDED');
});

test('malformed JSON bodies produce a 400, not a crash', async () => {
  const http = await h.agent();
  const res = await http.post('/api/auth/login')
    .set('Content-Type', 'application/json')
    .send('{"identifier": ');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'MALFORMED_JSON');
});

test('unknown API routes return a JSON 404', async () => {
  const http = await h.agent();
  const res = await http.get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'ROUTE_NOT_FOUND');
});

test('backend source and runtime data are not reachable over HTTP', async () => {
  const http = await h.agent();
  for (const url of ['/backend/lib/auth.js', '/.env', '/backend/data/workbridge.json', '/package.json']) {
    const res = await http.get(url);
    // Unknown non-API paths fall through to the SPA shell; what matters is that
    // the file's own content is never served.
    assert.equal(
      /passwordHash|SESSION_SECRET|"dependencies"|bcrypt\.compare/.test(res.text || ''),
      false,
      `${url} leaked file content`
    );
  }
});
