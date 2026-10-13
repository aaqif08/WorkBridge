'use strict';

/**
 * Explainable match scoring.
 *
 * The original build used Math.random() for the "AI match %", which is worse
 * than useless - it looked authoritative and meant nothing. This computes a
 * score from comparable profile and listing fields and returns the reasons
 * behind it, so both sides can see what drove the number.
 */

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function parseYears(text) {
  const m = String(text || '').match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * @param {object} worker  a Worker user record
 * @param {object} job     a job record
 * @returns {{score:number, reasons:Array<{code:string, weight:number, detail:string}>}}
 */
function score(worker, job) {
  const reasons = [];
  const add = (code, weight, detail) => reasons.push({ code, weight, detail });
  const profile = (worker && worker.profile) || {};

  // Baseline so an incomplete profile is not scored as a zero match.
  let total = 40;
  add('BASELINE', 40, 'Base score for an active worker profile');

  if (profile.trade && norm(profile.trade) === norm(job.category)) {
    total += 25;
    add('TRADE_MATCH', 25, `Trade "${profile.trade}" matches the listing category`);
  } else if (profile.trade && norm(job.title).includes(norm(profile.trade))) {
    total += 15;
    add('TRADE_PARTIAL', 15, `Trade "${profile.trade}" appears in the job title`);
  } else if (profile.trade) {
    add('TRADE_DIFFERENT', 0, `Listing is for ${job.category || 'another trade'}, profile trade is ${profile.trade}`);
  } else {
    add('TRADE_MISSING', 0, 'No trade recorded on the profile');
  }

  const required = parseYears(job.exp);
  const held = Number(profile.experienceYears) || 0;
  if (required && held >= required) {
    total += 15;
    add('EXPERIENCE_MET', 15, `${held} years experience meets the ${required}+ year requirement`);
  } else if (required && held > 0) {
    add('EXPERIENCE_SHORT', 0, `${held} years experience is below the ${required}+ year requirement`);
  } else if (!required) {
    total += 5;
    add('EXPERIENCE_UNSPECIFIED', 5, 'Listing does not state a minimum experience');
  }

  const preferred = Array.isArray(profile.preferredCountries) ? profile.preferredCountries.map(norm) : [];
  if (preferred.length && preferred.includes(norm(job.country))) {
    total += 10;
    add('DESTINATION_PREFERRED', 10, `${job.country} is on the worker's preferred destination list`);
  } else if (preferred.length) {
    add('DESTINATION_NOT_PREFERRED', 0, `${job.country} is not on the worker's preferred destination list`);
  }

  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  const haystack = `${norm(job.requirements)} ${norm(job.description)}`;
  const hits = skills.filter(s => s && haystack.includes(norm(s)));
  if (hits.length) {
    const weight = Math.min(10, hits.length * 4);
    total += weight;
    add('SKILLS_OVERLAP', weight, `Skills referenced in the listing: ${hits.join(', ')}`);
  }

  if (norm(job.visa) === 'yes' && profile.passportAvailable) {
    total += 5;
    add('PASSPORT_READY', 5, 'Worker has a passport and the role includes visa sponsorship');
  } else if (norm(job.visa) === 'yes' && !profile.passportAvailable) {
    add('PASSPORT_MISSING', 0, 'Role needs a passport for visa processing and none is recorded');
  }

  return { score: Math.max(0, Math.min(100, Math.round(total))), reasons };
}

module.exports = { score };
