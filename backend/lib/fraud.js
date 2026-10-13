'use strict';

/**
 * Explainable listing-risk heuristics.
 *
 * Design rules, deliberately:
 *  - the score is computed here, server side, from the stored listing. A
 *    client-supplied riskScore/verified flag is ignored by the routes.
 *  - every point added carries a reason code and a weight, so a reviewer can
 *    see WHY a listing scored what it did.
 *  - a score is an indicator that routes a listing to human review. It is not
 *    a finding of fraud, and nothing here marks an employer as "verified".
 */

// Indicative monthly gross pay bands for common trades, in local currency.
// Sourced as rough market ranges for triage only - they are not official or
// contractual figures and are labelled as indicative everywhere they surface.
const SALARY_BANDS = {
  'uae:driver': { currency: 'AED', low: 1500, high: 3000 },
  'uae:electrician': { currency: 'AED', low: 1600, high: 3200 },
  'uae:welder': { currency: 'AED', low: 1700, high: 3500 },
  'uae:plumber': { currency: 'AED', low: 1500, high: 3000 },
  'uae:chef': { currency: 'AED', low: 1800, high: 4000 },
  'uae:construction': { currency: 'AED', low: 1200, high: 2500 },
  'qatar:driver': { currency: 'QAR', low: 1400, high: 2800 },
  'qatar:electrician': { currency: 'QAR', low: 1500, high: 3000 },
  'qatar:welder': { currency: 'QAR', low: 1600, high: 3200 },
  'saudi arabia:driver': { currency: 'SAR', low: 1400, high: 3000 },
  'saudi arabia:electrician': { currency: 'SAR', low: 1500, high: 3200 },
  'saudi arabia:welder': { currency: 'SAR', low: 1600, high: 3400 },
  'india:driver': { currency: 'INR', low: 12000, high: 28000 },
  'india:electrician': { currency: 'INR', low: 14000, high: 32000 },
  'india:welder': { currency: 'INR', low: 14000, high: 30000 }
};

const FEE_PATTERNS = [
  /\b(registration|processing|placement|security|service)\s*(fee|charge|deposit)\b/i,
  /\bpay\s*(a|an)?\s*(fee|amount|deposit|advance)\b/i,
  /\badvance\s*payment\b/i,
  /\bsend\s*money\b/i
];

const OFF_PLATFORM_PATTERNS = [
  /\bwhats\s*app\b/i,
  /\btelegram\b/i,
  /\bcall\s*(me|us)\s*(on|at)\b/i,
  /(?:\+?\d[\d\s-]{8,})/
];

const SUSPICIOUS_EMPLOYER_WORDS = ['freelance', 'agent', 'individual', 'broker', 'middleman'];

function normalise(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Pulls a currency and the highest monthly figure out of free-form salary text
 * like "AED 2,000 - 2,400 / month".
 */
function parseSalary(text) {
  const raw = String(text || '');
  const currencyMatch = raw.match(/\b(AED|QAR|SAR|KWD|OMR|BHD|INR|USD)\b/i);
  const currency = currencyMatch ? currencyMatch[1].toUpperCase() : null;
  const numbers = (raw.match(/\d[\d,.\s]*/g) || [])
    .map(n => Number(n.replace(/[,\s]/g, '')))
    .filter(n => Number.isFinite(n) && n > 0);
  if (!numbers.length) return { currency, amount: null, numbers };
  return { currency, amount: Math.max(...numbers), numbers };
}

function bandFor(country, category) {
  const key = `${normalise(country)}:${normalise(category)}`;
  if (SALARY_BANDS[key]) return { key, ...SALARY_BANDS[key] };
  // Fall back to any band for the country so an unknown trade still gets a
  // sanity ceiling rather than no check at all.
  const prefix = `${normalise(country)}:`;
  const fallbackKey = Object.keys(SALARY_BANDS).find(k => k.startsWith(prefix));
  return fallbackKey ? { key: fallbackKey, ...SALARY_BANDS[fallbackKey] } : null;
}

/**
 * @param {object} job        listing fields (title, company, country, category, salary, ...)
 * @param {object} [context]  { employer } - the resolved employer account, when known
 * @returns {{score:number, band:string, factors:Array, requiresReview:boolean}}
 */
function assess(job, context = {}) {
  const factors = [];
  const add = (code, weight, detail) => factors.push({ code, weight, detail: detail || '' });

  const text = `${job.description || ''}\n${job.requirements || ''}\n${job.title || ''}`;
  const salary = parseSalary(job.salary);
  const band = bandFor(job.country, job.category);

  // 1. Salary far above the indicative band for the trade and destination.
  if (band && salary.amount) {
    if (salary.currency && salary.currency !== band.currency) {
      add('SALARY_CURRENCY_MISMATCH', 10,
        `Salary quoted in ${salary.currency} but ${job.country} listings are normally ${band.currency}`);
    } else if (salary.amount > band.high * 3) {
      add('SALARY_IMPLAUSIBLE', 45,
        `Quoted ${band.currency} ${salary.amount} is more than 3x the indicative ceiling of ${band.currency} ${band.high}`);
    } else if (salary.amount > band.high * 1.8) {
      add('SALARY_ABOVE_BAND', 25,
        `Quoted ${band.currency} ${salary.amount} is well above the indicative range ${band.currency} ${band.low}-${band.high}`);
    } else if (salary.amount < band.low * 0.5) {
      add('SALARY_BELOW_BAND', 20,
        `Quoted ${band.currency} ${salary.amount} is far below the indicative floor of ${band.currency} ${band.low}`);
    }
  } else if (!salary.amount) {
    add('SALARY_NOT_SPECIFIED', 15, 'No numeric salary figure was provided');
  }

  // 2. Requests for money from the candidate.
  if (FEE_PATTERNS.some(re => re.test(text))) {
    add('CANDIDATE_FEE_REQUESTED', 35, 'Listing text appears to ask the worker for a fee or deposit');
  }

  // 3. Attempts to move the candidate off-platform.
  if (OFF_PLATFORM_PATTERNS.some(re => re.test(text))) {
    add('OFF_PLATFORM_CONTACT', 20, 'Listing text contains direct contact details or an off-platform channel');
  }

  // 4. Employer identity signals.
  const company = normalise(job.company);
  if (!company) {
    add('COMPANY_MISSING', 20, 'No company name provided');
  } else if (SUSPICIOUS_EMPLOYER_WORDS.some(w => company.includes(w))) {
    add('COMPANY_NAME_GENERIC', 15, 'Company name suggests a private agent rather than a registered employer');
  }

  const employer = context.employer;
  if (employer) {
    const verification = normalise(employer.profile && employer.profile.verificationStatus);
    if (verification !== 'verified') {
      add('EMPLOYER_NOT_VERIFIED', 15, 'Employer account has not completed platform verification');
    }
    const ageDays = (Date.now() - new Date(employer.createdAt || Date.now()).getTime()) / 86400000;
    if (ageDays < 7) {
      add('EMPLOYER_ACCOUNT_NEW', 10, 'Employer account is less than 7 days old');
    }
  } else {
    add('EMPLOYER_UNKNOWN', 15, 'Listing is not linked to a registered employer account');
  }

  // 5. Listing completeness.
  if (String(job.description || '').trim().length < 60) {
    add('DESCRIPTION_THIN', 10, 'Job description is very short');
  }
  if (String(job.requirements || '').trim().length < 20) {
    add('REQUIREMENTS_MISSING', 8, 'Requirements were not specified');
  }

  // 6. Internal consistency.
  const overseas = normalise(job.country) && normalise(job.country) !== 'india';
  if (overseas && normalise(job.visa) === 'no') {
    add('OVERSEAS_WITHOUT_VISA', 20, 'Overseas role offered without visa sponsorship');
  }
  const vacancies = Number(job.vacancies);
  if (Number.isFinite(vacancies) && vacancies > 200) {
    add('VACANCY_COUNT_IMPLAUSIBLE', 15, `Listing claims ${vacancies} vacancies`);
  }

  const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.weight, 0)));
  const band3 = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';

  return {
    score,
    band: band3,
    factors,
    requiresReview: score >= 60,
    assessedAt: new Date().toISOString(),
    salaryBandUsed: band ? { currency: band.currency, low: band.low, high: band.high, key: band.key } : null
  };
}

module.exports = { assess, parseSalary, SALARY_BANDS };
