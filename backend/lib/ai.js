'use strict';

/**
 * WorkBridge AI Assistant backend.
 *
 * Two modes, and the API response always says which one produced the reply:
 *  - `live`     : the configured Anthropic model answered, grounded on the
 *                 knowledge base plus real platform figures.
 *  - `fallback` : no provider is configured (or the provider call failed), so
 *                 the deterministic knowledge base answered.
 *
 * Nothing in this module invents job listings, salaries, visa statuses or
 * approvals: the figures handed to the model come from the database, and the
 * system prompt forbids going beyond them.
 */

const config = require('../config');
const store = require('./store');
const knowledge = require('./knowledge');

let anthropicClient = null;
function client() {
  if (!config.ai.live) return null;
  if (!anthropicClient) {
    // Required lazily so the dependency is not loaded in fallback-only installs.
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey: config.ai.apiKey });
  }
  return anthropicClient;
}

function available() {
  return Boolean(config.ai.live);
}

/**
 * Real platform figures the assistant may quote. Deliberately narrow: counts
 * and reference ranges, plus the caller's own case summary. No other user's
 * data, no documents, no credentials.
 */
function platformFacts(user) {
  const db = store.read();
  const published = db.jobs.filter(j => j.status === 'published');

  const byCountry = {};
  const byCategory = {};
  for (const job of published) {
    const country = job.country || 'Unspecified';
    const category = job.category || 'Other';
    byCountry[country] = (byCountry[country] || 0) + 1;
    byCategory[category] = (byCategory[category] || 0) + 1;
  }

  const facts = {
    publishedJobCount: published.length,
    jobsByCountry: byCountry,
    jobsByCategory: byCategory,
    salaryGuide: db.salaryGuide.map(row => ({
      role: row.role,
      country: row.country,
      indicativeRange: row.range,
      indicativeInr: row.inr
    })),
    visaMilestones: require('./rbac').VISA_STAGES
  };

  if (user && user.role === 'Worker') {
    const myApplications = db.applications.filter(a => String(a.workerId) === String(user.id));
    facts.myApplicationCount = myApplications.length;
    facts.myApplicationStages = myApplications.map(a => ({ job: a.jobTitle, stage: a.status }));
    const myCase = db.visaCases.find(v => String(v.workerId) === String(user.id));
    if (myCase) {
      facts.myVisaCase = {
        destination: myCase.destination,
        progressPercent: myCase.progress,
        stages: myCase.stages.map(s => ({ name: s.name, status: s.status, updatedAt: s.updatedAt || null }))
      };
    }
  }

  return facts;
}

function systemPrompt(lang) {
  const language = lang === 'ta'
    ? 'Reply in Tamil (தமிழ்). Use natural, readable Tamil that a tradesperson can follow; keep well-known English terms such as passport, visa, GAMCA and offer letter in English where that is how people actually say them.'
    : 'Reply in clear, simple English suitable for a tradesperson who may not be a fluent English speaker.';

  return [
    'You are the WorkBridge AI Assistant. WorkBridge is a recruitment and visa-processing platform that connects skilled blue-collar workers in India with employers, mainly in the Gulf.',
    'You help with: finding jobs and eligibility, how applications work, visa-processing stages and document requirements, destination countries, indicative trade salaries, safe overseas recruitment and fraud avoidance, and how to use the platform.',
    '',
    'Hard rules:',
    '- Use only the WORKBRIDGE KNOWLEDGE and PLATFORM DATA given to you. If the answer is not there, say you do not have that information and name who can confirm it (the employer, the authorised recruitment agency, the relevant embassy, or the Ministry of External Affairs eMigrate service).',
    '- Never invent a job listing, a company, a salary figure, a legal or visa requirement, a processing time, a government approval, or the status of anyone\'s application.',
    '- Salary figures and timelines are indicative. Say so, and say that the employment contract or the official source is what counts.',
    '- Never claim that an employer, agency, job or visa is "verified" or guaranteed. WorkBridge shows risk indicators and routes listings to human review; that is not a guarantee.',
    '- Warn plainly that a genuine employer or registered agency does not ask a worker for a placement fee or a payment to a personal account.',
    '- Do not ask for or repeat passwords, OTPs, bank details or document file contents.',
    '- Keep answers short: a direct answer, then at most four short points or steps.',
    '',
    language
  ].join('\n');
}

function groundingBlock(message, lang, user) {
  const entries = knowledge.search(message, 3).map(e => knowledge.render(e, lang));
  const facts = platformFacts(user);
  const parts = ['WORKBRIDGE KNOWLEDGE:'];
  if (entries.length) {
    for (const entry of entries) {
      parts.push(`## ${entry.title}`);
      parts.push(entry.body.join('\n'));
    }
  } else {
    parts.push('(no specific article matched this question)');
  }
  parts.push('');
  parts.push('PLATFORM DATA (live, from the WorkBridge database):');
  parts.push(JSON.stringify(facts, null, 2));
  return parts.join('\n');
}

/** Deterministic answer built purely from the knowledge base. */
function fallbackReply(message, lang, user) {
  const matches = knowledge.search(message, 2);
  if (!matches.length) {
    const facts = platformFacts(user);
    const intro = lang === 'ta'
      ? [
        'நான் WorkBridge AI உதவியாளர். வேலை தேடுதல், விண்ணப்ப நடைமுறை, விசா படிகள், தேவையான ஆவணங்கள், சம்பள மதிப்பீடு, மோசடியைத் தவிர்ப்பது ஆகியவற்றில் உதவ முடியும்.',
        `தற்போது தளத்தில் ${facts.publishedJobCount} வேலை விளம்பரங்கள் வெளியிடப்பட்டுள்ளன.`,
        'கீழே உள்ள கேள்விகளில் ஒன்றைத் தேர்ந்தெடுக்கவும், அல்லது உங்கள் கேள்வியை இன்னும் விரிவாகக் கேளுங்கள்.'
      ]
      : [
        'I am the WorkBridge AI Assistant. I can help with finding jobs, how applications work, the visa milestones, required documents, indicative salaries, and avoiding recruitment fraud.',
        `There are currently ${facts.publishedJobCount} published listings on the platform.`,
        'Pick one of the suggested questions below, or ask your question with a bit more detail.'
      ];
    return { text: intro.join('\n\n'), sources: [] };
  }

  const rendered = matches.map(m => knowledge.render(m, lang));
  const note = lang === 'ta'
    ? 'குறிப்பு: இவை பொதுவான தகவல்கள். உங்கள் முதலாளி, அதிகாரம் பெற்ற முகவர் நிறுவனம், தூதரகம் அல்லது அரசு அதிகாரப்பூர்வ தகவலுடன் உறுதிப்படுத்துங்கள்.'
    : 'Note: this is general guidance. Confirm the detail with your employer, your authorised recruitment agency, the relevant embassy, or the official government source.';

  const body = rendered.map(r => `${r.title}\n\n${r.body.join('\n\n')}`).join('\n\n---\n\n');
  return { text: `${body}\n\n${note}`, sources: rendered.map(r => r.id) };
}

/**
 * Produces an assistant reply.
 * @param {object} args
 * @param {string} args.message  the user's question (already length-validated)
 * @param {string} args.lang     'en' | 'ta'
 * @param {object} args.user     the authenticated user
 * @param {Array}  args.history  prior turns [{role:'user'|'assistant', content}]
 */
async function reply({ message, lang, user, history = [] }) {
  const sources = knowledge.search(message, 2).map(e => e.id);

  if (!available()) {
    const fb = fallbackReply(message, lang, user);
    return {
      text: fb.text,
      mode: 'fallback',
      reason: 'AI_PROVIDER_NOT_CONFIGURED',
      model: null,
      sources: fb.sources,
      indicative: true
    };
  }

  const grounding = groundingBlock(message, lang, user);
  const messages = [];
  for (const turn of history.slice(-config.ai.historyTurns)) {
    if (!turn || !turn.content) continue;
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: String(turn.content).slice(0, config.ai.maxMessageChars)
    });
  }
  messages.push({ role: 'user', content: `${grounding}\n\nUSER QUESTION:\n${message}` });

  try {
    const response = await client().messages.create({
      model: config.ai.model,
      max_tokens: config.ai.maxTokens,
      output_config: { effort: config.ai.effort },
      system: systemPrompt(lang),
      messages
    });

    if (response.stop_reason === 'refusal') {
      const fb = fallbackReply(message, lang, user);
      return {
        text: fb.text,
        mode: 'fallback',
        reason: 'AI_PROVIDER_DECLINED',
        model: config.ai.model,
        sources: fb.sources,
        indicative: true
      };
    }

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    if (!text) {
      const fb = fallbackReply(message, lang, user);
      return {
        text: fb.text,
        mode: 'fallback',
        reason: 'AI_PROVIDER_EMPTY_RESPONSE',
        model: config.ai.model,
        sources: fb.sources,
        indicative: true
      };
    }

    return {
      text,
      mode: 'live',
      reason: null,
      model: config.ai.model,
      sources,
      indicative: true,
      usage: response.usage
        ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
        : null
    };
  } catch (err) {
    // Any provider failure degrades to the deterministic answer rather than
    // surfacing an error or pretending a model replied.
    console.error('[ai] provider call failed:', err && err.message);
    const fb = fallbackReply(message, lang, user);
    return {
      text: fb.text,
      mode: 'fallback',
      reason: 'AI_PROVIDER_UNAVAILABLE',
      model: config.ai.model,
      sources: fb.sources,
      indicative: true
    };
  }
}

module.exports = { reply, available, platformFacts, fallbackReply, systemPrompt };
