'use strict';

/**
 * Live-provider path tests.
 *
 * No real API key is available in this environment, so the Anthropic SDK module
 * is replaced in the require cache with a stub before backend/lib/ai builds its
 * client. That exercises the real code path - request assembly, system prompt,
 * grounding, response parsing, refusal handling and failure fallback - without
 * a network call and without spending anything.
 *
 * What this does NOT prove: that the live API accepts the request body. That
 * needs a real key and is listed as an outstanding item in the report.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Must be configured before backend/config is first required.
process.env.AI_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'sk-ant-stub-key-for-tests';
process.env.AI_MODEL = 'claude-opus-5-5';
process.env.AI_MAX_TOKENS = '512';
process.env.AI_EFFORT = 'low';

const calls = [];
let behaviour = { type: 'text', text: 'Indicative guidance from the stubbed model.' };

class StubAnthropic {
  constructor(options) {
    this.options = options;
    this.messages = {
      create: async params => {
        calls.push(params);
        if (behaviour.type === 'throw') {
          const err = new Error(behaviour.message || 'stub failure');
          err.status = behaviour.status || 500;
          throw err;
        }
        if (behaviour.type === 'refusal') {
          return { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] };
        }
        if (behaviour.type === 'empty') {
          return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] };
        }
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: behaviour.text }],
          usage: { input_tokens: 120, output_tokens: 40 }
        };
      }
    };
  }
}

const sdkPath = require.resolve('@anthropic-ai/sdk');
require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  path: path.dirname(sdkPath),
  loaded: true,
  exports: StubAnthropic,
  children: [],
  paths: []
};

const h = require('./helpers');
const config = require('../backend/config');
const ai = require('../backend/lib/ai');

test.after(() => h.cleanup());

test('the provider is considered live once a key is present', () => {
  assert.equal(config.ai.live, true);
  assert.equal(ai.available(), true);
});

test('a live reply is returned and labelled as live', async () => {
  calls.length = 0;
  behaviour = { type: 'text', text: 'Indicative guidance from the stubbed model.' };

  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', { message: 'How does the visa process work?', lang: 'en' });

  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'live');
  assert.equal(res.body.model, 'claude-opus-5-5');
  assert.equal(res.body.providerNote, null);
  assert.equal(res.body.reply, 'Indicative guidance from the stubbed model.');
  assert.equal(res.body.indicative, true);
});

test('the request uses the configured model, token cap and effort', () => {
  const params = calls[calls.length - 1];
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.max_tokens, 512);
  assert.deepEqual(params.output_config, { effort: 'low' });
  // Thinking is not configured: on this model it is always on and a budget is
  // rejected, so the parameter is deliberately omitted.
  assert.equal(params.thinking, undefined);
  assert.equal(params.temperature, undefined);
});

test('the system prompt is sent and constrains the model', () => {
  const params = calls[calls.length - 1];
  assert.equal(typeof params.system, 'string');
  assert.match(params.system, /WorkBridge AI Assistant/);
  assert.match(params.system, /Never invent a job listing/);
  assert.match(params.system, /indicative/i);
  assert.match(params.system, /placement fee/i);
});

test('the user turn carries knowledge-base grounding and real platform data', () => {
  const params = calls[calls.length - 1];
  const last = params.messages[params.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.match(last.content, /WORKBRIDGE KNOWLEDGE:/);
  assert.match(last.content, /PLATFORM DATA \(live, from the WorkBridge database\):/);
  assert.match(last.content, /USER QUESTION:/);
  assert.match(last.content, /publishedJobCount/);
  // The caller's own case is included; nothing from another account is.
  assert.equal(last.content.includes(h.DEMO.worker2), false);
  assert.equal(/passwordHash|\$2[aby]\$/.test(last.content), false);
  assert.equal(last.content.includes(config.ai.apiKey), false);
});

test('a Tamil question instructs the model to answer in Tamil', async () => {
  calls.length = 0;
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', { message: 'விசா நடைமுறை எப்படி?' });
  assert.equal(res.status, 200);
  assert.equal(res.body.lang, 'ta');
  assert.match(calls[0].system, /Reply in Tamil/);
});

test('prior turns are replayed so the conversation has context', async () => {
  calls.length = 0;
  const worker = await h.as(h.DEMO.worker);
  await worker.post('/api/ai/chat', { message: 'First question about driver jobs', lang: 'en' });
  await worker.post('/api/ai/chat', { message: 'And what about the salary?', lang: 'en' });

  const second = calls[calls.length - 1];
  assert.ok(second.messages.length >= 3, 'the follow-up must include earlier turns');
  assert.ok(second.messages.some(m => m.role === 'assistant'));
  assert.ok(second.messages.some(m => m.role === 'user' && m.content.includes('First question about driver jobs')));
});

test('one user\'s history never leaks into another user\'s request', async () => {
  calls.length = 0;
  const other = await h.as(h.DEMO.worker2);
  await other.post('/api/ai/chat', { message: 'A question only worker two asked', lang: 'en' });
  const params = calls[calls.length - 1];
  const serialised = JSON.stringify(params.messages);
  assert.equal(serialised.includes('First question about driver jobs'), false);
  assert.equal(serialised.includes('A question only worker two asked'), true);
});

test('a provider failure falls back to the knowledge base and says so', async () => {
  behaviour = { type: 'throw', message: 'connection reset', status: 503 };
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', { message: 'How can I identify a recruitment scam?', lang: 'en' });

  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'fallback');
  assert.equal(res.body.providerNote, 'AI_PROVIDER_UNAVAILABLE');
  assert.ok(res.body.sources.includes('scam-warning-signs'));
  // The internal error text is never shown to the user.
  assert.equal(res.body.reply.includes('connection reset'), false);
  assert.equal(JSON.stringify(res.body).includes('sk-ant'), false);
});

test('a provider refusal falls back rather than returning an empty reply', async () => {
  behaviour = { type: 'refusal' };
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', { message: 'What documents are needed for Saudi Arabia?', lang: 'en' });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'fallback');
  assert.equal(res.body.providerNote, 'AI_PROVIDER_DECLINED');
  assert.ok(res.body.reply.length > 40);
});

test('an empty model response falls back rather than showing a blank answer', async () => {
  behaviour = { type: 'empty' };
  const worker = await h.as(h.DEMO.worker);
  const res = await worker.post('/api/ai/chat', { message: 'How does the visa process work?', lang: 'en' });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'fallback');
  assert.equal(res.body.providerNote, 'AI_PROVIDER_EMPTY_RESPONSE');
  assert.ok(res.body.reply.length > 40);
});

test('the health endpoint reports the live provider and never the key', async () => {
  const http = await h.agent();
  const res = await http.get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.checks.aiAssistant.mode, 'live');
  assert.equal(res.body.checks.aiAssistant.provider, 'anthropic');
  assert.equal(res.body.checks.aiAssistant.model, 'claude-opus-5-5');
  assert.equal(JSON.stringify(res.body).includes('sk-ant'), false);
});

test('the key is read from the environment and never leaves the server', () => {
  assert.match(config.ai.apiKey, /^sk-ant-/);
  // No request handler or response shape references the key: the only consumer
  // is the SDK client constructed inside backend/lib/ai.js.
  const fs = require('fs');
  const aiSource = fs.readFileSync(require.resolve('../backend/lib/ai'), 'utf8');
  assert.match(aiSource, /new Anthropic\(\{ apiKey: config\.ai\.apiKey \}\)/);
  const routeSource = fs.readFileSync(require.resolve('../backend/routes/ai.routes'), 'utf8');
  assert.equal(/apiKey/.test(routeSource), false, 'the route layer must not touch the key');
});
