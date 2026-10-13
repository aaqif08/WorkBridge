'use strict';

const express = require('express');
const config = require('../config');
const store = require('../lib/store');
const ai = require('../lib/ai');
const knowledge = require('../lib/knowledge');
const mw = require('../lib/middleware');
const { ok, fail, asyncRoute, str, oneOf } = require('../lib/http');

const router = express.Router();

const MAX_STORED_TURNS = 40;

/** Per-user sliding-window rate limit kept in the conversation record. */
function rateCheck(conversation) {
  const cutoff = Date.now() - config.ai.rateWindowMs;
  const recent = (conversation.requestTimes || []).filter(t => t > cutoff);
  if (recent.length >= config.ai.rateMax) {
    const retryAfter = Math.ceil((recent[0] + config.ai.rateWindowMs - Date.now()) / 1000);
    return { allowed: false, retryAfter, recent };
  }
  return { allowed: true, recent };
}

function conversationFor(userId) {
  return store.read().aiConversations.find(c => String(c.userId) === String(userId)) || null;
}

router.get('/chat', mw.requireAuth, asyncRoute(async (req, res) => {
  const lang = oneOf(req.query.lang, ['en', 'ta'], { field: 'lang', fallback: req.auth.user.language || 'en' });
  const conversation = conversationFor(req.auth.user.id);
  return ok(res, {
    provider: ai.available() ? 'anthropic' : 'fallback',
    model: ai.available() ? config.ai.model : null,
    suggestions: knowledge.suggestions(lang),
    // Conversations are keyed by user id, so one account never sees another's.
    messages: conversation ? conversation.messages.slice(-MAX_STORED_TURNS) : []
  });
}));

router.post('/chat', mw.requireAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const message = str(body.message, {
    field: 'message', required: true, min: 1, max: config.ai.maxMessageChars
  });
  const requestedLang = oneOf(body.lang, ['en', 'ta'], { field: 'lang', fallback: null });
  // Explicit choice wins; otherwise Tamil script in the question is honoured,
  // falling back to the account's saved preference.
  const lang = requestedLang || knowledge.detectLanguage(message, req.auth.user.language || 'en');

  const userId = req.auth.user.id;
  const existing = conversationFor(userId);
  const limit = rateCheck(existing || {});
  if (!limit.allowed) {
    return fail(res, 429, 'AI_RATE_LIMIT', 'Too many assistant requests. Please wait a moment.', {
      retryAfterSeconds: limit.retryAfter
    });
  }

  const history = existing ? existing.messages.slice(-config.ai.historyTurns) : [];
  const result = await ai.reply({
    message,
    lang,
    user: req.auth.user,
    history: history.map(m => ({ role: m.role, content: m.content }))
  });

  const now = new Date().toISOString();
  await store.mutate(db => {
    let conversation = db.aiConversations.find(c => String(c.userId) === String(userId));
    if (!conversation) {
      conversation = { userId, messages: [], requestTimes: [], createdAt: now };
      db.aiConversations.push(conversation);
    }
    conversation.messages.push({ role: 'user', content: message, lang, at: now });
    conversation.messages.push({
      role: 'assistant', content: result.text, lang, at: new Date().toISOString(),
      mode: result.mode, model: result.model
    });
    if (conversation.messages.length > MAX_STORED_TURNS) {
      conversation.messages = conversation.messages.slice(-MAX_STORED_TURNS);
    }
    conversation.requestTimes = [...limit.recent, Date.now()];
    conversation.updatedAt = now;
  });

  return ok(res, {
    reply: result.text,
    lang,
    mode: result.mode,
    model: result.model,
    providerNote: result.reason,
    indicative: result.indicative,
    sources: result.sources,
    suggestions: knowledge.suggestions(lang),
    timestamp: new Date().toISOString()
  });
}));

router.delete('/chat', mw.requireAuth, asyncRoute(async (req, res) => {
  await store.mutate(db => {
    db.aiConversations = db.aiConversations.filter(c => String(c.userId) !== String(req.auth.user.id));
  });
  return ok(res, { message: 'Conversation cleared' });
}));

router.get('/suggestions', asyncRoute(async (req, res) => {
  const lang = oneOf(req.query.lang, ['en', 'ta'], { field: 'lang', fallback: 'en' });
  return ok(res, { suggestions: knowledge.suggestions(lang), provider: ai.available() ? 'anthropic' : 'fallback' });
}));

module.exports = router;
