'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const config = require('../backend/config');
const knowledge = require('../backend/lib/knowledge');

test.after(() => h.cleanup());

// The suite runs with AI_PROVIDER=none unless the environment overrides it, so
// these assertions describe the documented fallback behaviour.
const LIVE = config.ai.live;

test('the chat endpoint requires authentication', async () => {
  const http = await h.agent();
  const res = await http.post('/api/ai/chat').send({ message: 'Hello' });
  assert.equal(res.status, 401);
});

test('an empty or oversized message is rejected', async () => {
  const worker = await h.as(h.DEMO.worker);

  const empty = await worker.post('/api/ai/chat', { message: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'FIELD_REQUIRED');

  const huge = await worker.post('/api/ai/chat', { message: 'a'.repeat(5000) });
  assert.equal(huge.status, 400);
  assert.equal(huge.body.error, 'FIELD_TOO_LONG');
});

test('a reply is produced and labels which engine answered', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', { message: 'How does the visa process work?' });
  assert.equal(res.status, 200);
  assert.ok(res.body.reply.length > 40);
  assert.ok(['live', 'fallback'].includes(res.body.mode));
  assert.equal(res.body.indicative, true);

  if (LIVE) {
    assert.equal(res.body.mode, 'live');
    assert.equal(res.body.model, config.ai.model);
  } else {
    // With no provider configured the API must say so rather than imply a model.
    assert.equal(res.body.mode, 'fallback');
    assert.equal(res.body.providerNote, 'AI_PROVIDER_NOT_CONFIGURED');
    assert.equal(res.body.model, null);
  }
});

test('the fallback answer is drawn from the knowledge base, not invented', async () => {
  if (LIVE) return; // a live model phrases its own answer
  const worker = await h.as(h.DEMO.worker);
  // The demo worker's saved language is Tamil, so English is requested
  // explicitly here - an explicit lang always wins over the account default.
  const res = await worker.post('/api/ai/chat', {
    message: 'What documents are needed to work in Saudi Arabia?',
    lang: 'en'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.lang, 'en');
  assert.ok(res.body.sources.includes('documents-saudi'));
  assert.match(res.body.reply, /GAMCA|passport/i);
  // The disclaimer about confirming with official sources must be present.
  assert.match(res.body.reply, /confirm|embassy|agency/i);
});

test('no API key is ever returned to the client', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', { message: 'What is the salary for a welder in the UAE?' });
  const body = JSON.stringify(res.body);
  assert.equal(/sk-ant|ANTHROPIC_API_KEY/.test(body), false);
  if (config.ai.apiKey) assert.equal(body.includes(config.ai.apiKey), false);
});

test('a Tamil question is answered in Tamil', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', { message: 'வெளிநாட்டில் வேலை பெறுவது எப்படி?' });
  assert.equal(res.status, 200);
  assert.equal(res.body.lang, 'ta');
  // Tamil Unicode must be present in the reply.
  assert.match(res.body.reply, /[஀-௿]/);
  assert.ok(res.body.suggestions.some(s => /[஀-௿]/.test(s)));
});

test('an explicit language flag overrides script detection', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', {
    message: 'சவுதி அரேபியாவில் வேலை செய்ய என்ன ஆவணங்கள் தேவை?',
    lang: 'en'
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.lang, 'en');
});

test('a mixed Tamil-English question still matches the right article', async () => {
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', { message: 'visa process பற்றி சொல்லுங்க' });
  assert.equal(res.status, 200);
  assert.equal(res.body.lang, 'ta');
  if (!LIVE) assert.ok(res.body.sources.includes('visa-process'));
});

test('an unmatched question gets an honest capability answer, not a fabricated one', async () => {
  if (LIVE) return;
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', { message: 'qwertyuiop zxcvbnm' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.sources, []);
  assert.match(res.body.reply, /WorkBridge/);
  // The count quoted is the real published listing count.
  const published = h.db().jobs.filter(j => j.status === 'published').length;
  assert.ok(res.body.reply.includes(String(published)));
});

test('conversation history is stored per user and isolated between accounts', async () => {
  const workerOne = await h.as(h.DEMO.worker);
  const workerTwo = await h.as(h.DEMO.worker2);

  await workerOne.post('/api/ai/chat', { message: 'My private question about Dubai driver jobs' });
  await workerTwo.post('/api/ai/chat', { message: 'A different question about welding in Riyadh' });

  const mine = await workerOne.get('/api/ai/chat');
  assert.equal(mine.status, 200);
  assert.ok(mine.body.messages.some(m => m.content.includes('My private question')));
  assert.equal(mine.body.messages.some(m => m.content.includes('A different question')), false);

  const theirs = await workerTwo.get('/api/ai/chat');
  assert.equal(theirs.body.messages.some(m => m.content.includes('My private question')), false);
});

test('a conversation can be cleared and only affects the caller', async () => {
  const workerOne = await h.as(h.DEMO.worker);
  const workerTwo = await h.as(h.DEMO.worker2);

  const cleared = await workerOne.del('/api/ai/chat');
  assert.equal(cleared.status, 200);

  const mine = await workerOne.get('/api/ai/chat');
  assert.deepEqual(mine.body.messages, []);

  const theirs = await workerTwo.get('/api/ai/chat');
  assert.ok(theirs.body.messages.length > 0);
});

test('suggested questions are available in both languages without authentication', async () => {
  const http = await h.agent();
  const en = await http.get('/api/ai/suggestions').query({ lang: 'en' });
  const ta = await http.get('/api/ai/suggestions').query({ lang: 'ta' });

  assert.equal(en.status, 200);
  assert.ok(en.body.suggestions.length >= 6);
  assert.equal(en.body.suggestions.every(s => !/[஀-௿]/.test(s)), true);

  assert.equal(ta.body.suggestions.every(s => /[஀-௿]/.test(s)), true);
  assert.ok(ta.body.suggestions.includes('வெளிநாட்டில் வேலை பெறுவது எப்படி?'));
  assert.ok(ta.body.suggestions.includes('சவுதி அரேபியாவில் வேலை செய்ய என்ன ஆவணங்கள் தேவை?'));
});

test('the per-user rate limit applies and reports a retry delay', async () => {
  const http = await h.agent();
  await http.post('/api/auth/register').send({
    name: 'Rate Limited User',
    email: 'ratelimit@example.com',
    password: 'ValidPass123',
    role: 'Worker'
  });
  const worker = await h.as('ratelimit@example.com', 'ValidPass123');

  let limited = null;
  for (let i = 0; i < config.ai.rateMax + 3; i += 1) {
    const res = await worker.post('/api/ai/chat', { message: `Question number ${i}` });
    if (res.status === 429) { limited = res; break; }
  }
  assert.ok(limited, `expected a 429 within ${config.ai.rateMax + 3} requests`);
  assert.equal(limited.body.error, 'AI_RATE_LIMIT');
  assert.ok(limited.body.details.retryAfterSeconds > 0);
});

test('every knowledge-base article has English and Tamil content', () => {
  assert.ok(knowledge.ENTRIES.length >= 6);
  for (const entry of knowledge.ENTRIES) {
    assert.ok(entry.en && entry.en.title && entry.en.body.length, `${entry.id} is missing English content`);
    assert.ok(entry.ta && entry.ta.title && entry.ta.body.length, `${entry.id} is missing Tamil content`);
    assert.match(entry.ta.title, /[஀-௿]/, `${entry.id} Tamil title is not in Tamil script`);
    for (const paragraph of entry.ta.body) {
      assert.match(paragraph, /[஀-௿]/, `${entry.id} has a Tamil paragraph with no Tamil text`);
    }
  }
});

test('the grounding context given to a model carries no credentials or other users\' data', () => {
  const ai = require('../backend/lib/ai');
  const worker = h.findUser(h.DEMO.worker);
  const facts = ai.platformFacts(worker);
  const serialised = JSON.stringify(facts);

  assert.equal(serialised.includes('passwordHash'), false);
  assert.equal(serialised.includes('$2a$'), false);
  assert.equal(serialised.includes('$2b$'), false);
  assert.equal(serialised.includes(h.DEMO.worker2), false);
  assert.equal(serialised.includes('storedName'), false);
  // It does carry real platform figures, which is the point of grounding.
  assert.equal(typeof facts.publishedJobCount, 'number');
  assert.ok(facts.myVisaCase);
});

test('the system prompt forbids fabrication and verification claims', () => {
  const ai = require('../backend/lib/ai');
  const prompt = ai.systemPrompt('en');
  assert.match(prompt, /Never invent/i);
  assert.match(prompt, /indicative/i);
  assert.match(prompt, /verified/i);
  assert.match(ai.systemPrompt('ta'), /Tamil/i);
});
