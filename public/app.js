/**
 * WorkBridge single-page frontend.
 *
 * Structure:
 *   state            - the signed-in user, reference data and per-view caches
 *   shells           - mobile-first worker shell, desktop shell for the others
 *   views            - one async function per route, returning HTML
 *   router           - hash routing with server-backed role guards
 *   actions          - one delegated click/submit handler, no inline handlers
 *
 * Authorisation is enforced by the API. The guards here only keep the UI
 * coherent: hiding a button is never treated as a security control.
 */

import { api, ApiError } from './api.js';
import { initI18n, setLanguage, t, tError, lang, SUPPORTED, languageLabel, onLanguageChange } from './i18n.js';
import {
  esc, attr, badge, chip, progressBar, skeleton, emptyState, errorState,
  field, textarea, select, passwordField, checkbox, toast, setFieldError,
  clearFieldErrors, setButtonBusy, dialog, confirmDialog, formatDate, initials
} from './ui.js';
import {
  configureAssistant, assistantBody, toggleAssistant,
  sendAssistantMessage, clearConversation, renderAssistant, ensureAssistantLoaded,
  resetAssistantCache, assistantState
} from './assistant.js';

const appRoot = document.getElementById('app');

const state = {
  user: null,
  meta: null,
  booted: false,
  jobFilters: { search: '', type: 'All', category: 'All', country: 'All', page: 1 },
  uploadMaxMb: 5
};

configureAssistant({ currentUser: () => state.user });

const HOME_BY_ROLE = {
  Worker: '#/worker',
  Employer: '#/employer',
  Consultancy: '#/consultancy',
  Admin: '#/admin'
};

function homeFor(user) {
  return (user && HOME_BY_ROLE[user.role]) || '#/login';
}

function go(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) render();
  else location.hash = target;
}

function roleLabel(role) {
  const map = {
    Worker: t('auth.roleWorker'),
    Employer: t('auth.roleEmployer'),
    Consultancy: t('auth.roleConsultancy'),
    Admin: t('admin.dashboardTitle')
  };
  return map[role] || role;
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

function languageToggle(extraClass = '') {
  return `<div class="lang-toggle ${extraClass}" role="group" aria-label="${attr(t('a11y.languageSelector'))}">
    ${SUPPORTED.map(entry => `
      <button class="lang-btn ${entry.code === lang() ? 'active' : ''}" data-action="set-language"
        data-lang="${attr(entry.code)}" aria-pressed="${entry.code === lang() ? 'true' : 'false'}">
        ${esc(entry.label)}
      </button>`).join('')}
  </div>`;
}

const NAV_BY_ROLE = {
  Worker: [
    ['#/worker', 'nav.home', '⌂'],
    ['#/jobs', 'nav.findJobs', '⌕'],
    ['#/applications', 'nav.applications', '▣'],
    ['#/visa', 'nav.visaTracking', '◉'],
    ['#/documents', 'nav.documents', '▤'],
    ['#/assistant', 'nav.assistant', '💬'],
    ['#/salary', 'nav.salaryGuide', '₹'],
    ['#/notifications', 'nav.notifications', '🔔'],
    ['#/messages', 'nav.messages', '✉'],
    ['#/profile', 'nav.profile', '◉']
  ],
  Employer: [
    ['#/employer', 'nav.dashboard', '▦'],
    ['#/employer/jobs', 'nav.myJobs', '▣'],
    ['#/employer/post', 'nav.postJob', '＋'],
    ['#/employer/applicants', 'nav.applicants', '♙'],
    ['#/messages', 'nav.messages', '✉'],
    ['#/assistant', 'nav.assistant', '💬'],
    ['#/profile', 'nav.profile', '◉']
  ],
  Consultancy: [
    ['#/consultancy', 'nav.dashboard', '▦'],
    ['#/consultancy/cases', 'nav.cases', '▣'],
    ['#/consultancy/offers', 'nav.candidates', '♙'],
    ['#/messages', 'nav.messages', '✉'],
    ['#/assistant', 'nav.assistant', '💬'],
    ['#/profile', 'nav.profile', '◉']
  ],
  Admin: [
    ['#/admin', 'nav.dashboard', '▦'],
    ['#/admin/queue', 'nav.reviewQueue', '⚠'],
    ['#/admin/jobs', 'nav.jobs', '▣'],
    ['#/admin/users', 'nav.users', '♙'],
    ['#/admin/audit', 'nav.auditLog', '▤'],
    ['#/profile', 'nav.profile', '◉']
  ]
};

const MOBILE_NAV = [
  ['#/worker', 'nav.home', '⌂'],
  ['#/jobs', 'nav.findJobs', '⌕'],
  ['#/applications', 'nav.applications', '▣'],
  ['#/assistant', 'nav.assistant', '💬'],
  ['#/profile', 'nav.profile', '◉']
];

function sidebar(active) {
  const items = NAV_BY_ROLE[state.user.role] || [];
  return `<aside class="sidebar">
    <div class="brand">
      <div class="logo" aria-hidden="true">W</div>
      <span>${esc(t('brand.name'))}</span>
    </div>
    <small>${esc(t('nav.workspace', { role: roleLabel(state.user.role) }))}</small>
    <nav class="side-nav" aria-label="${attr(t('a11y.mainNavigation'))}">
      ${items.map(([href, key, icon]) => `
        <a href="${attr(href)}" class="${active === href ? 'active' : ''}" ${active === href ? 'aria-current="page"' : ''}>
          <span aria-hidden="true">${icon}</span>${esc(t(key))}
        </a>`).join('')}
    </nav>
    <div class="sidebar-foot">
      ${languageToggle('stacked')}
      <button class="btn logout-btn" data-action="logout">${esc(t('common.signOut'))}</button>
    </div>
  </aside>`;
}

function desktopShell(active, title, subtitle, body) {
  return `<div class="dashboard-shell">
    ${sidebar(active)}
    <main class="main" id="main-content">
      <div class="topbar">
        <div>
          <h1>${esc(title)}</h1>
          ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
        </div>
        <div class="toolbar">
          <div class="user-badge-header">
            <span class="avatar small" aria-hidden="true">${esc(initials(state.user.name))}</span>
            <span>${esc(state.user.name)}</span>
            ${badge(roleLabel(state.user.role), 'b-blue')}
          </div>
          <a class="btn small" href="#/notifications">🔔</a>
        </div>
      </div>
      ${body}
    </main>
  </div>`;
}

function mobileShell(active, body, { title = '', subtitle = '' } = {}) {
  return `<div class="mobile-shell">
    <header class="mobile-header">
      <div class="spaced">
        <div class="row">
          <div class="logo small" aria-hidden="true">W</div>
          <div>
            <strong>${esc(state.user.name)}</strong>
            <div class="muted tiny">${esc(roleLabel(state.user.role))}</div>
          </div>
        </div>
        <div class="row gap-6">
          ${languageToggle('compact')}
          <button class="btn small logout-btn" data-action="logout">${esc(t('common.signOut'))}</button>
        </div>
      </div>
    </header>
    <main class="mobile-body" id="main-content">
      ${title ? `<div class="page-head"><h1>${esc(title)}</h1>${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ''}</div>` : ''}
      ${body}
    </main>
    <nav class="mobile-nav" aria-label="${attr(t('a11y.mainNavigation'))}">
      ${MOBILE_NAV.map(([href, key, icon]) => `
        <a href="${attr(href)}" class="${active === href ? 'active' : ''}" ${active === href ? 'aria-current="page"' : ''}>
          <span class="ni" aria-hidden="true">${icon}</span>
          <span>${esc(t(key))}</span>
        </a>`).join('')}
    </nav>
  </div>`;
}

/** Workers get the mobile-first shell; the operational roles get the desktop one. */
function shell(active, title, subtitle, body) {
  if (state.user.role === 'Worker') return mobileShell(active, body, { title, subtitle });
  return desktopShell(active, title, subtitle, body);
}

// ---------------------------------------------------------------------------
// Public views
// ---------------------------------------------------------------------------

async function landingView() {
  let stats = { total: 0, categories: 0, countries: 0 };
  try {
    const res = await api.get('/api/jobs', { pageSize: 100 });
    const jobs = res.data || [];
    stats = {
      total: res.total || jobs.length,
      categories: new Set(jobs.map(j => j.category)).size,
      countries: new Set(jobs.map(j => j.country)).size
    };
  } catch (_) {
    // The landing page still renders without live counts.
  }

  return `<div class="landing">
    <div class="container">
      <header class="navbar">
        <div class="brand"><div class="logo" aria-hidden="true">W</div>${esc(t('brand.name'))}</div>
        <!-- nav-actions stays visible at phone width; .navlinks is hidden below
             900px, so the language toggle must not live inside it. -->
        <nav class="nav-actions" aria-label="${attr(t('a11y.mainNavigation'))}">
          ${languageToggle('on-dark')}
          ${state.user
    ? `<a class="btn gold small" href="${attr(homeFor(state.user))}">${esc(t('auth.goToDashboard'))}</a>
               <button class="btn ghost small" data-action="logout">${esc(t('common.signOut'))}</button>`
    : `<a class="btn ghost small" href="#/login">${esc(t('common.signIn'))}</a>
               <a class="btn gold small" href="#/register">${esc(t('common.createAccount'))}</a>`}
        </nav>
      </header>
    </div>

    <div class="hero-landing">
      <div class="container hero-grid">
        <div>
          <span class="eyebrow">${esc(t('landing.eyebrow'))}</span>
          <h1 class="hero-title">${esc(t('landing.title'))}</h1>
          <p class="hero-copy">${esc(t('landing.copy'))}</p>
          <div class="hero-actions">
            <a class="btn gold" href="#/register">${esc(t('landing.findJob'))}</a>
            <a class="btn ghost" href="#/register">${esc(t('landing.hireWorkers'))}</a>
          </div>
          <div class="chips hero-chips">
            <span class="pill green">${esc(t('landing.pillRisk'))}</span>
            <span class="pill blue">${esc(t('landing.pillMatching'))}</span>
            <span class="pill gold">${esc(t('landing.pillVisa'))}</span>
          </div>
        </div>
        <div class="feature-panel">
          <div class="stat-grid tight">
            <div class="card stat-card"><div class="num">${stats.total}</div><div class="muted">${esc(t('landing.statJobs'))}</div></div>
            <div class="card stat-card"><div class="num">${stats.categories}</div><div class="muted">${esc(t('landing.statCategories'))}</div></div>
            <div class="card stat-card"><div class="num">${stats.countries}</div><div class="muted">${esc(t('landing.statCountries'))}</div></div>
          </div>
          <p class="muted tiny landing-note">${esc(t('landing.statNote'))}</p>
        </div>
      </div>
    </div>
  </div>

  <section class="section">
    <div class="container">
      <h2 class="section-title">${esc(t('landing.workspacesTitle'))}</h2>
      <p class="section-sub">${esc(t('landing.workspacesSub'))}</p>
      <div class="cards">
        ${[
    ['landing.workerCard', 'landing.workerCardCopy'],
    ['landing.employerCard', 'landing.employerCardCopy'],
    ['landing.consultancyCard', 'landing.consultancyCardCopy'],
    ['landing.adminCard', 'landing.adminCardCopy']
  ].map(([title, copy]) => `
          <div class="card">
            <h3>${esc(t(title))}</h3>
            <p class="muted">${esc(t(copy))}</p>
          </div>`).join('')}
      </div>
    </div>
  </section>

  <footer class="site-footer">
    <div class="container spaced">
      <div>© ${new Date().getFullYear()} ${esc(t('landing.footerRights'))}</div>
      <div>${esc(t('landing.footerValues'))}</div>
    </div>
  </footer>`;
}

function authCard(inner) {
  return `<div class="center-page">
    <div class="auth-card">
      <div class="auth-head">
        <div class="logo" aria-hidden="true">W</div>
        <h1>${esc(t('brand.name'))}</h1>
        <p class="muted tiny">${esc(t('brand.tagline'))}</p>
        ${languageToggle('centered')}
      </div>
      ${inner}
      <div class="auth-foot"><a class="muted" href="#/landing">${esc(t('auth.backHome'))}</a></div>
    </div>
  </div>`;
}

async function loginView() {
  return authCard(`
    <div class="auth-tabs" role="tablist">
      <a class="auth-tab active" href="#/login" role="tab" aria-selected="true">${esc(t('common.signIn'))}</a>
      <a class="auth-tab" href="#/register" role="tab" aria-selected="false">${esc(t('common.createAccount'))}</a>
    </div>
    <h2 class="auth-title">${esc(t('auth.signInTitle'))}</h2>
    <form data-action="login" novalidate>
      ${field({
    id: 'login-identifier',
    label: t('auth.identifier'),
    hint: t('auth.identifierHint'),
    required: true,
    autocomplete: 'username'
  })}
      ${passwordField({ id: 'login-password', label: t('common.password'), autocomplete: 'current-password' })}
      <button class="btn primary block" type="submit">${esc(t('common.signIn'))}</button>
      <div class="auth-links">
        <a href="#/forgot">${esc(t('auth.forgotPassword'))}</a>
      </div>
      <p class="muted tiny center">${esc(t('auth.noAccount'))} <a href="#/register">${esc(t('common.createAccount'))}</a></p>
    </form>`);
}

function roleOptionCard(role, labelKey, copyKey, selected) {
  return `<button type="button" class="role-chip-btn ${selected ? 'active' : ''}" data-action="select-role" data-role="${attr(role)}"
    aria-pressed="${selected ? 'true' : 'false'}">
    <strong>${esc(t(labelKey))}</strong>
    <span class="muted tiny">${esc(t(copyKey))}</span>
  </button>`;
}

let registerRole = 'Worker';

function registerRoleFields(role) {
  if (role === 'Worker') {
    return `<fieldset class="form-fieldset">
      <legend>${esc(t('auth.workerFields'))}</legend>
      <div class="form-grid">
        ${select({
      id: 'reg-trade',
      label: t('auth.trade'),
      options: (state.meta ? state.meta.jobCategories : ['Other']).map(c => ({ value: c, label: c }))
    })}
        ${field({ id: 'reg-exp', label: t('auth.experienceYears'), type: 'number', value: '0', attrs: 'min="0" max="60"' })}
        ${field({ id: 'reg-skills', label: t('auth.skills'), placeholder: 'MIG, TIG' })}
        ${field({ id: 'reg-languages', label: t('auth.languages'), placeholder: 'Tamil, English' })}
        ${field({ id: 'reg-countries', label: t('auth.preferredCountries'), placeholder: 'UAE, Qatar' })}
        ${field({ id: 'reg-location', label: t('auth.currentLocation') })}
      </div>
      ${checkbox({ id: 'reg-passport', label: t('auth.passportAvailable') })}
    </fieldset>`;
  }
  if (role === 'Employer') {
    return `<fieldset class="form-fieldset">
      <legend>${esc(t('auth.employerFields'))}</legend>
      <div class="form-grid">
        ${field({ id: 'reg-company', label: t('auth.companyName'), required: true })}
        ${select({
      id: 'reg-country',
      label: t('auth.country'),
      options: (state.meta ? state.meta.countries : ['UAE']).map(c => ({ value: c, label: c }))
    })}
        ${field({ id: 'reg-city', label: t('auth.city') })}
        ${field({ id: 'reg-sector', label: t('auth.sector') })}
        ${field({ id: 'reg-contact', label: t('auth.contactPerson') })}
      </div>
      <p class="notice">${esc(t('auth.verificationPending'))}</p>
    </fieldset>`;
  }
  return `<fieldset class="form-fieldset">
    <legend>${esc(t('auth.consultancyFields'))}</legend>
    <div class="form-grid">
      ${field({ id: 'reg-agency', label: t('auth.agencyName'), required: true })}
      ${field({ id: 'reg-city', label: t('auth.city') })}
      ${field({ id: 'reg-registration', label: t('auth.registrationReference') })}
    </div>
    <p class="notice">${esc(t('auth.verificationPending'))}</p>
  </fieldset>`;
}

async function registerView() {
  return authCard(`
    <div class="auth-tabs" role="tablist">
      <a class="auth-tab" href="#/login" role="tab" aria-selected="false">${esc(t('common.signIn'))}</a>
      <a class="auth-tab active" href="#/register" role="tab" aria-selected="true">${esc(t('common.createAccount'))}</a>
    </div>
    <h2 class="auth-title">${esc(t('auth.signUpTitle'))}</h2>
    <form data-action="register" novalidate>
      ${field({ id: 'reg-name', label: t('auth.fullName'), required: true, autocomplete: 'name' })}
      ${field({ id: 'reg-email', label: `${t('common.email')} (${t('common.optional')})`, type: 'email', autocomplete: 'email' })}
      ${field({ id: 'reg-phone', label: `${t('common.phone')} (${t('common.optional')})`, type: 'tel', autocomplete: 'tel' })}
      <small class="muted">${esc(t('validation.CONTACT_REQUIRED'))}</small>
      ${passwordField({ id: 'reg-password', label: t('common.password'), hint: t('auth.passwordHint'), autocomplete: 'new-password' })}
      ${passwordField({ id: 'reg-confirm', label: t('auth.confirmPassword'), autocomplete: 'new-password' })}

      <div class="field">
        <span class="label-like">${esc(t('auth.accountType'))} <span class="req" aria-hidden="true">*</span></span>
        <div class="role-grid-selector" id="role-selector">
          ${roleOptionCard('Worker', 'auth.roleWorker', 'auth.roleWorkerCopy', registerRole === 'Worker')}
          ${roleOptionCard('Employer', 'auth.roleEmployer', 'auth.roleEmployerCopy', registerRole === 'Employer')}
          ${roleOptionCard('Consultancy', 'auth.roleConsultancy', 'auth.roleConsultancyCopy', registerRole === 'Consultancy')}
        </div>
        <small class="muted">${esc(t('auth.adminNote'))}</small>
      </div>

      ${select({
    id: 'reg-language',
    label: t('auth.preferredLanguage'),
    options: SUPPORTED.map(l => ({ value: l.code, label: l.label })),
    value: lang()
  })}

      <div id="role-fields">${registerRoleFields(registerRole)}</div>

      <button class="btn primary block" type="submit">${esc(t('common.createAccount'))}</button>
      <p class="muted tiny center">${esc(t('auth.haveAccount'))} <a href="#/login">${esc(t('common.signIn'))}</a></p>
    </form>`);
}

async function forgotView() {
  return authCard(`
    <h2 class="auth-title">${esc(t('auth.forgotTitle'))}</h2>
    <p class="muted">${esc(t('auth.forgotCopy'))}</p>
    <form data-action="forgot" novalidate>
      ${field({ id: 'forgot-identifier', label: t('auth.identifier'), required: true, autocomplete: 'username' })}
      <button class="btn primary block" type="submit">${esc(t('auth.forgotSubmit'))}</button>
      <p class="muted tiny center"><a href="#/login">${esc(t('common.signIn'))}</a></p>
    </form>`);
}

async function onboardingView(step) {
  const copy = [
    [t('onboarding.title1'), t('onboarding.copy1')],
    [t('onboarding.title2'), t('onboarding.copy2')],
    [t('onboarding.title3'), t('onboarding.copy3')]
  ][step - 1];

  return `<div class="center-page">
    <div class="auth-card center">
      <div class="logo big" aria-hidden="true">W</div>
      <div class="muted tiny">${esc(t('onboarding.step', { step }))}</div>
      <h1>${esc(copy[0])}</h1>
      <p class="muted">${esc(copy[1])}</p>
      ${progressBar((step / 3) * 100)}
      <div class="toolbar center-toolbar">
        <a class="btn" href="#/register">${esc(t('common.skip'))}</a>
        ${step > 1 ? `<a class="btn" href="#/onboarding-${step - 1}">${esc(t('common.back'))}</a>` : ''}
        <a class="btn primary" href="${step < 3 ? `#/onboarding-${step + 1}` : '#/register'}">
          ${esc(step < 3 ? t('common.next') : t('common.getStarted'))}
        </a>
      </div>
      ${languageToggle('centered')}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Worker views
// ---------------------------------------------------------------------------

function riskLabel(band) {
  if (band === 'high') return badge(t('worker.riskHigh'), 'b-red');
  if (band === 'medium') return badge(t('worker.riskMedium'), 'b-gold');
  return badge(t('worker.riskLow'), 'b-green');
}

function jobCard(job) {
  const benefits = Array.isArray(job.benefits) ? job.benefits : [];
  return `<article class="card job-card">
    <div class="job-logo" aria-hidden="true">${esc(initials(job.company))}</div>
    <div class="job-body">
      <div class="spaced">
        <div>
          <h3 class="job-title">${esc(job.title)}</h3>
          <div class="muted tiny">${esc(job.company)} · ${esc(job.location)}</div>
        </div>
        ${job.matchScore !== undefined ? badge(t('worker.matchScore', { score: job.matchScore }), 'b-blue') : ''}
      </div>
      <div class="job-salary">${esc(job.salary)}</div>
      ${job.inr ? `<div class="muted tiny">${esc(job.inr)}</div>` : ''}
      <div class="job-meta">
        ${benefits.slice(0, 3).map(chip).join('')}
        ${chip(job.exp)}
        ${chip(job.type === 'Local' ? t('worker.local') : t('worker.overseas'))}
        ${job.employerVerified ? badge(t('worker.employerVerified'), 'b-green') : badge(t('worker.employerUnverified'), 'b-gold')}
        ${riskLabel(job.riskBand)}
      </div>
      <div class="job-actions">
        <a class="btn primary small" href="#/job/${encodeURIComponent(job.id)}">${esc(t('worker.viewJob'))}</a>
        ${job.matchReasons && job.matchReasons.length
    ? `<button class="btn small" data-action="explain-match" data-job="${attr(job.id)}">${esc(t('worker.whyThisMatch'))}</button>`
    : ''}
      </div>
    </div>
  </article>`;
}

async function workerDashboardView() {
  const [jobsRes, appsRes, visaRes] = await Promise.all([
    api.get('/api/jobs', { pageSize: 3 }),
    api.get('/api/applications', { pageSize: 5 }),
    api.get('/api/visa/my-status').catch(() => ({ data: null }))
  ]);

  const profile = state.user.profile || {};
  const filled = ['trade', 'experienceYears', 'currentLocation'].filter(k => profile[k]).length
    + ((profile.skills || []).length ? 1 : 0)
    + ((profile.preferredCountries || []).length ? 1 : 0)
    + (profile.passportAvailable ? 1 : 0);
  const completeness = Math.round((filled / 6) * 100);

  const visa = visaRes.data;

  return shell('#/worker', t('worker.greeting', { name: state.user.name.split(' ')[0] }), t('worker.greetingSub'), `
    <section class="mobile-hero">
      <span class="eyebrow">${esc(t('landing.eyebrow'))}</span>
      <p>${esc(t('worker.greetingSub'))}</p>
      <div class="hero-actions">
        <a class="btn gold small" href="#/jobs">${esc(t('worker.browseJobs'))}</a>
        <a class="btn ghost small" href="#/assistant">${esc(t('worker.askAssistant'))}</a>
      </div>
    </section>

    <form class="searchbar" data-action="home-search">
      <label class="visually-hidden" for="home-search">${esc(t('worker.searchPlaceholder'))}</label>
      <input class="input" id="home-search" placeholder="${attr(t('worker.searchPlaceholder'))}">
      <button class="btn primary" type="submit">${esc(t('common.search'))}</button>
    </form>

    <div class="card">
      <div class="spaced">
        <div>
          <strong>${esc(t('worker.profileStrength'))}</strong>
          <div class="muted tiny">${esc(t('worker.profileStrengthHint'))}</div>
        </div>
        <strong>${completeness}%</strong>
      </div>
      ${progressBar(completeness)}
      <a class="btn dark block" href="#/profile">${esc(t('worker.completeProfile'))}</a>
    </div>

    ${visa ? `<div class="card">
      <div class="spaced">
        <strong>${esc(t('worker.visaTitle'))}</strong>
        ${badge(t('worker.visaProgress', { percent: visa.progress }), 'b-blue')}
      </div>
      ${progressBar(visa.progress)}
      <a class="btn block" href="#/visa">${esc(t('worker.trackVisa'))}</a>
    </div>` : ''}

    <div class="spaced section-head">
      <h2>${esc(t('worker.recommended'))}</h2>
      <a class="muted" href="#/jobs">${esc(t('common.seeAll'))}</a>
    </div>
    ${(jobsRes.data || []).length
      ? `<div class="stack">${jobsRes.data.map(jobCard).join('')}</div>`
      : emptyState(t('worker.noJobs'), '', t('worker.browseJobs'), 'data-action="nav" data-href="#/jobs"')}

    <div class="spaced section-head">
      <h2>${esc(t('worker.myApplications'))}</h2>
      <a class="muted" href="#/applications">${esc(t('common.seeAll'))}</a>
    </div>
    ${(appsRes.data || []).length
      ? `<div class="stack">${appsRes.data.slice(0, 3).map(applicationCard).join('')}</div>`
      : emptyState(t('worker.noApplications'), '', t('worker.noApplicationsCta'), 'data-action="nav" data-href="#/jobs"')}

    <h2 class="section-head">${esc(t('worker.quickActions'))}</h2>
    <div class="mobile-grid">
      <a class="quick" href="#/documents">📄<strong>${esc(t('worker.uploadDocuments'))}</strong></a>
      <a class="quick" href="#/visa">🌍<strong>${esc(t('worker.trackVisa'))}</strong></a>
      <a class="quick" href="#/salary">₹<strong>${esc(t('nav.salaryGuide'))}</strong></a>
      <a class="quick" href="#/assistant">💬<strong>${esc(t('worker.askAssistant'))}</strong></a>
    </div>
  `);
}

async function workerJobsView() {
  const filters = state.jobFilters;
  const res = await api.get('/api/jobs', {
    search: filters.search,
    type: filters.type === 'All' ? '' : filters.type,
    category: filters.category === 'All' ? '' : filters.category,
    country: filters.country === 'All' ? '' : filters.country,
    page: filters.page,
    pageSize: 20
  });

  const categories = ['All', ...((state.meta && state.meta.jobCategories) || [])];
  const countries = ['All', ...((state.meta && state.meta.countries) || [])];

  const pagination = res.totalPages > 1
    ? `<div class="pagination">
        <button class="btn small" data-action="jobs-page" data-page="${Number(res.page) - 1}" ${res.page <= 1 ? 'disabled' : ''}>${esc(t('common.back'))}</button>
        <span class="muted">${esc(t('common.page'))} ${res.page} ${esc(t('common.of'))} ${res.totalPages}</span>
        <button class="btn small" data-action="jobs-page" data-page="${Number(res.page) + 1}" ${res.page >= res.totalPages ? 'disabled' : ''}>${esc(t('common.next'))}</button>
      </div>`
    : '';

  return shell('#/jobs', t('nav.findJobs'), t('worker.jobsFound', { count: res.total }), `
    <form class="searchbar" data-action="job-search">
      <label class="visually-hidden" for="job-search">${esc(t('worker.searchPlaceholder'))}</label>
      <input class="input" id="job-search" value="${attr(filters.search)}" placeholder="${attr(t('worker.searchPlaceholder'))}">
      <button class="btn primary" type="submit">${esc(t('common.search'))}</button>
    </form>

    <div class="filter-row">
      <div class="tabs" role="group" aria-label="${attr(t('common.filters'))}">
        ${['All', 'Overseas', 'Local'].map(type => `
          <button class="btn small ${filters.type === type ? 'primary' : ''}" data-action="job-filter" data-key="type" data-value="${attr(type)}">
            ${esc(type === 'All' ? t('common.all') : type === 'Local' ? t('worker.local') : t('worker.overseas'))}
          </button>`).join('')}
      </div>
      <div class="filter-selects">
        <label class="visually-hidden" for="filter-category">${esc(t('employer.category'))}</label>
        <select class="select" id="filter-category" data-action="job-filter-select" data-key="category">
          ${categories.map(c => `<option value="${attr(c)}" ${filters.category === c ? 'selected' : ''}>${esc(c === 'All' ? t('common.all') : c)}</option>`).join('')}
        </select>
        <label class="visually-hidden" for="filter-country">${esc(t('employer.country'))}</label>
        <select class="select" id="filter-country" data-action="job-filter-select" data-key="country">
          ${countries.map(c => `<option value="${attr(c)}" ${filters.country === c ? 'selected' : ''}>${esc(c === 'All' ? t('common.all') : c)}</option>`).join('')}
        </select>
      </div>
    </div>

    ${(res.data || []).length
      ? `<div class="stack">${res.data.map(jobCard).join('')}</div>${pagination}`
      : emptyState(t('worker.noJobs'), '', t('worker.clearFilters'), 'data-action="clear-job-filters"')}
  `);
}

async function workerJobView(id) {
  const res = await api.get(`/api/jobs/${encodeURIComponent(id)}`);
  const job = res.data;
  const benefits = Array.isArray(job.benefits) ? job.benefits : [];

  const body = `
    <a class="muted back-link" href="#/jobs">← ${esc(t('nav.findJobs'))}</a>
    <article class="card">
      <div class="row">
        <div class="job-logo" aria-hidden="true">${esc(initials(job.company))}</div>
        <div>
          <h2>${esc(job.title)}</h2>
          <div class="muted">${esc(job.company)} · ${esc(job.location)}</div>
        </div>
      </div>

      <div class="chips spaced-chips">
        ${job.employerVerified ? badge(t('worker.employerVerified'), 'b-green') : badge(t('worker.employerUnverified'), 'b-gold')}
        ${riskLabel(job.riskBand)}
        ${badge(job.type === 'Local' ? t('worker.local') : t('worker.overseas'), 'b-blue')}
      </div>

      <h3>${esc(t('worker.salary'))}</h3>
      <div class="big-figure">${esc(job.salary)}</div>
      ${job.inr ? `<div class="muted">${esc(job.inr)} · ${esc(t('common.indicative'))}</div>` : ''}

      <div class="grid2">
        <div class="card inner">
          <strong>${esc(t('worker.jobDetails'))}</strong>
          <dl class="detail-list">
            <dt>${esc(t('worker.experience'))}</dt><dd>${esc(job.exp)}</dd>
            <dt>${esc(t('worker.workingHours'))}</dt><dd>${esc(job.hours)}</dd>
            <dt>${esc(t('worker.vacancies'))}</dt><dd>${esc(job.vacancies)}</dd>
            <dt>${esc(t('worker.visaSponsorship'))}</dt><dd>${esc(job.visa === 'Yes' ? t('common.yes') : t('common.no'))}</dd>
            <dt>${esc(t('worker.location'))}</dt><dd>${esc(job.location)}</dd>
          </dl>
        </div>
        <div class="card inner">
          <strong>${esc(t('worker.benefits'))}</strong>
          <ul class="tick-list">${benefits.map(b => `<li>${esc(b)}</li>`).join('') || `<li>${esc(t('common.none'))}</li>`}</ul>
        </div>
      </div>

      <h3>${esc(t('worker.description'))}</h3>
      <p class="body-copy">${esc(job.description)}</p>
      <h3>${esc(t('worker.requirements'))}</h3>
      <p class="body-copy">${esc(job.requirements)}</p>

      ${job.matchReasons && job.matchReasons.length ? `
      <div class="card inner">
        <div class="spaced">
          <strong>${esc(t('worker.whyThisMatch'))}</strong>
          ${badge(t('worker.matchScore', { score: job.matchScore }), 'b-blue')}
        </div>
        <p class="muted tiny">${esc(t('worker.matchExplainer'))}</p>
        <ul class="reason-list">
          ${job.matchReasons.map(r => `<li><span class="weight">${r.weight > 0 ? `+${r.weight}` : '0'}</span> ${esc(r.detail)}</li>`).join('')}
        </ul>
      </div>` : ''}

      <div class="job-actions">
        ${state.user && state.user.role === 'Worker'
    ? `<a class="btn primary" href="#/apply/${encodeURIComponent(job.id)}">${esc(t('worker.applyNow'))}</a>`
    : ''}
        ${state.user ? `<button class="btn" data-action="report-job" data-job="${attr(job.id)}">${esc(t('worker.reportListing'))}</button>` : ''}
      </div>
    </article>`;

  if (!state.user) return publicPageShell(body);
  return shell('#/jobs', job.title, `${job.company} · ${job.location}`, body);
}

function publicPageShell(body) {
  return `<div class="landing-slim">
    <div class="container navbar">
      <a class="brand" href="#/landing"><span class="logo" aria-hidden="true">W</span>${esc(t('brand.name'))}</a>
      <div class="row gap-6">
        ${languageToggle('on-dark')}
        <a class="btn gold small" href="#/login">${esc(t('common.signIn'))}</a>
      </div>
    </div>
  </div>
  <main class="container page-main" id="main-content">${body}</main>`;
}

async function workerApplyView(id) {
  const res = await api.get(`/api/jobs/${encodeURIComponent(id)}`);
  const job = res.data;
  const docs = await api.get('/api/documents').catch(() => ({ data: [] }));
  const verified = (docs.data || []).filter(d => d.status === 'Verified').length;

  return shell('#/applications', t('worker.applyTitle', { title: job.title }), '', `
    <a class="muted back-link" href="#/job/${encodeURIComponent(job.id)}">← ${esc(t('worker.viewJob'))}</a>
    <form class="card" data-action="apply" data-job="${attr(job.id)}" novalidate>
      <p class="muted">${esc(t('worker.applyIntro', { company: job.company }))}</p>
      <div class="card inner">
        <strong>${esc(t('nav.documents'))}</strong>
        <p class="muted tiny">${esc(t('employer.documentsVerified', { verified, total: (docs.data || []).length }))}</p>
        <a class="btn small" href="#/documents">${esc(t('worker.uploadDocuments'))}</a>
      </div>
      ${textarea({ id: 'apply-note', label: t('worker.applyNote'), placeholder: t('worker.applyNotePlaceholder'), rows: 3 })}
      <button class="btn primary block" type="submit">${esc(t('worker.applySubmit'))}</button>
    </form>
  `);
}

function stageBadge(stage) {
  const variant = {
    Applied: 'b-blue',
    Shortlisted: 'b-green',
    'Interview Scheduled': 'b-blue',
    'Offer Issued': 'b-gold',
    'Visa Processing': 'b-gold',
    Placed: 'b-green',
    Rejected: 'b-red',
    Withdrawn: 'b-red'
  }[stage] || '';
  return badge(stage, variant);
}

function applicationCard(application) {
  const last = (application.history || [])[application.history.length - 1];
  return `<article class="card">
    <div class="spaced">
      <div>
        <strong>${esc(application.jobTitle)}</strong>
        <div class="muted tiny">${esc(application.company)} · ${esc(application.location)}</div>
      </div>
      ${stageBadge(application.status)}
    </div>
    <div class="muted tiny">${esc(t('common.updated'))}: ${esc(formatDate(application.updatedAt, true))}${last && last.byName ? ` · ${esc(t('common.by'))} ${esc(last.byName)}` : ''}</div>
    ${application.interview ? `<div class="notice">${esc(t('employer.interviewAt', {
    when: formatDate(application.interview.scheduledAt, true),
    mode: application.interview.mode
  }))}</div>` : ''}
    <div class="job-actions">
      <a class="btn small" href="#/job/${encodeURIComponent(application.jobId)}">${esc(t('worker.viewJob'))}</a>
      ${application.status === 'Visa Processing' ? `<a class="btn small primary" href="#/visa">${esc(t('worker.trackVisa'))}</a>` : ''}
      ${['Applied', 'Shortlisted', 'Interview Scheduled'].includes(application.status)
    ? `<button class="btn small danger" data-action="withdraw-application" data-id="${attr(application.id)}">${esc(t('common.cancel'))}</button>`
    : ''}
    </div>
  </article>`;
}

async function workerApplicationsView() {
  const res = await api.get('/api/applications', { pageSize: 50 });
  const rows = res.data || [];
  return shell('#/applications', t('worker.myApplications'), t('worker.jobsFound', { count: res.total }),
    rows.length
      ? `<div class="stack">${rows.map(applicationCard).join('')}</div>`
      : emptyState(t('worker.noApplications'), '', t('worker.noApplicationsCta'), 'data-action="nav" data-href="#/jobs"'));
}

function stageStatusLabel(status) {
  return {
    done: t('worker.stageDone'),
    current: t('worker.stageCurrent'),
    pending: t('worker.stagePending'),
    blocked: t('worker.stageBlocked')
  }[status] || status;
}

function visaTimeline(stages) {
  return `<ol class="timeline">
    ${stages.map(stage => `
      <li class="step ${stage.status}">
        <strong>${esc(stage.name)}</strong>
        <div class="muted tiny">${esc(stageStatusLabel(stage.status))}${stage.updatedAt ? ` · ${esc(formatDate(stage.updatedAt, true))}` : ''}</div>
        ${stage.updatedByName ? `<div class="muted tiny">${esc(t('common.by'))} ${esc(stage.updatedByName)}</div>` : ''}
        ${stage.note ? `<div class="muted tiny">${esc(stage.note)}</div>` : ''}
      </li>`).join('')}
  </ol>`;
}

async function workerVisaView() {
  const res = await api.get('/api/visa/my-status');
  const visa = res.data;
  if (!visa) {
    return shell('#/visa', t('worker.visaTitle'), '', emptyState(t('worker.visaNone'), '', t('worker.browseJobs'), 'data-action="nav" data-href="#/jobs"'));
  }

  return shell('#/visa', t('worker.visaTitle'), `${visa.role || ''} · ${visa.destination || ''}`, `
    <div class="card">
      <div class="spaced">
        <strong>${esc(t('worker.visaProgress', { percent: visa.progress }))}</strong>
        ${badge(visa.stages.find(s => s.status === 'current') ? visa.stages.find(s => s.status === 'current').name : t('worker.stageDone'), 'b-blue')}
      </div>
      ${progressBar(visa.progress)}
      <dl class="detail-list">
        <dt>${esc(t('worker.visaConsultancy'))}</dt><dd>${esc(visa.consultancy || t('common.notAvailable'))}</dd>
        <dt>${esc(t('worker.visaOfficer'))}</dt><dd>${esc(visa.caseOfficer || t('common.notAvailable'))}</dd>
        <dt>${esc(t('worker.visaEstimated'))}</dt><dd>${esc(visa.estimatedCompletion ? formatDate(visa.estimatedCompletion) : t('worker.visaNoEstimate'))}</dd>
      </dl>
    </div>
    <div class="card">${visaTimeline(visa.stages)}</div>
  `);
}

function documentStatusBadge(status) {
  if (status === 'Verified') return badge(t('worker.docVerified'), 'b-green');
  if (status === 'Rejected') return badge(t('worker.docRejected'), 'b-red');
  return badge(t('worker.docPending'), 'b-gold');
}

async function workerDocumentsView() {
  const res = await api.get('/api/documents');
  const docs = res.data || [];
  const typeOptions = ((state.meta && state.meta.documentTypes) || ['other'])
    .map(type => ({ value: type, label: t(`worker.documentTypes.${type}`) }));

  return shell('#/documents', t('worker.documentsTitle'), t('worker.documentsSub'), `
    <form class="card" data-action="upload-document" novalidate>
      <div class="form-grid">
        ${field({ id: 'doc-name', label: t('worker.documentName'), required: true })}
        ${select({ id: 'doc-type', label: t('worker.documentType'), options: typeOptions, required: true })}
      </div>
      <div class="field">
        <label for="doc-file">${esc(t('worker.chooseFile'))} <span class="req" aria-hidden="true">*</span></label>
        <input class="input" type="file" id="doc-file" accept=".pdf,.jpg,.jpeg,.png,.webp" required>
        <small class="muted">${esc(t('worker.uploadLimits', { mb: state.uploadMaxMb }))}</small>
        <small class="field-error" id="doc-file-error" role="alert"></small>
      </div>
      <button class="btn primary" type="submit">${esc(t('worker.upload'))}</button>
    </form>

    ${docs.length ? `<div class="stack">${docs.map(doc => `
      <article class="card">
        <div class="spaced">
          <div class="row">
            <div class="icon-box" aria-hidden="true">📄</div>
            <div>
              <strong>${esc(doc.name)}</strong>
              <div class="muted tiny">${esc(t(`worker.documentTypes.${doc.type}`))} · ${esc(formatDate(doc.createdAt))}</div>
            </div>
          </div>
          ${documentStatusBadge(doc.status)}
        </div>
        ${doc.sensitive ? `<p class="notice tiny">${esc(t('worker.docSensitive'))}</p>` : ''}
        ${doc.status === 'Rejected' && doc.rejectionReason
      ? `<p class="notice danger tiny">${esc(t('worker.docRejectedReason', { reason: doc.rejectionReason }))}</p>` : ''}
        ${doc.verifiedByName ? `<div class="muted tiny">${esc(t('common.by'))} ${esc(doc.verifiedByName)} · ${esc(formatDate(doc.verifiedAt, true))}</div>` : ''}
        <div class="job-actions">
          ${doc.hasFile ? `<a class="btn small" href="/api/documents/${encodeURIComponent(doc.id)}/file" target="_blank" rel="noopener">${esc(t('worker.viewFile'))}</a>` : ''}
          ${doc.status !== 'Verified'
      ? `<button class="btn small danger" data-action="delete-document" data-id="${attr(doc.id)}" data-name="${attr(doc.name)}">${esc(t('common.remove'))}</button>`
      : ''}
        </div>
      </article>`).join('')}</div>`
      : emptyState(t('worker.noDocuments'), '')}
  `);
}

async function salaryGuideView() {
  const res = await api.get('/api/salary-guide');
  const rows = res.data || [];
  const grouped = rows.reduce((acc, row) => {
    acc[row.role] = acc[row.role] || [];
    acc[row.role].push(row);
    return acc;
  }, {});

  return shell('#/salary', t('worker.salaryTitle'), t('worker.salarySub'), `
    ${Object.entries(grouped).map(([role, entries]) => `
      <div class="card">
        <strong>${esc(role)}</strong>
        ${entries.map(entry => `
          <div class="salary-row">
            <div class="spaced">
              <span>${esc(entry.country)}</span>
              <span>${esc(entry.range)}</span>
            </div>
            ${progressBar(entry.bar || 50)}
            ${entry.inr ? `<div class="muted tiny">${esc(entry.inr)}</div>` : ''}
          </div>`).join('')}
      </div>`).join('')}
    <p class="notice">${esc(t('worker.salaryDisclaimer'))}</p>
  `);
}

async function profileView() {
  const user = state.user;
  const profile = user.profile || {};
  const roleFields = (() => {
    if (user.role === 'Worker') {
      return `<div class="form-grid">
        ${select({
        id: 'p-trade',
        label: t('auth.trade'),
        options: ((state.meta && state.meta.jobCategories) || ['Other']).map(c => ({ value: c, label: c })),
        value: profile.trade || ''
      })}
        ${field({ id: 'p-exp', label: t('auth.experienceYears'), type: 'number', value: profile.experienceYears || 0, attrs: 'min="0" max="60"' })}
        ${field({ id: 'p-skills', label: t('auth.skills'), value: (profile.skills || []).join(', ') })}
        ${field({ id: 'p-languages', label: t('auth.languages'), value: (profile.languages || []).join(', ') })}
        ${field({ id: 'p-countries', label: t('auth.preferredCountries'), value: (profile.preferredCountries || []).join(', ') })}
        ${field({ id: 'p-location', label: t('auth.currentLocation'), value: profile.currentLocation || '' })}
      </div>
      ${checkbox({ id: 'p-passport', label: t('auth.passportAvailable'), checked: Boolean(profile.passportAvailable) })}`;
    }
    if (user.role === 'Employer') {
      return `<div class="form-grid">
        ${field({ id: 'p-company', label: t('auth.companyName'), value: profile.companyName || '' })}
        ${select({
        id: 'p-country',
        label: t('auth.country'),
        options: ((state.meta && state.meta.countries) || ['UAE']).map(c => ({ value: c, label: c })),
        value: profile.country || ''
      })}
        ${field({ id: 'p-city', label: t('auth.city'), value: profile.city || '' })}
        ${field({ id: 'p-sector', label: t('auth.sector'), value: profile.sector || '' })}
        ${field({ id: 'p-contact', label: t('auth.contactPerson'), value: profile.contactPerson || '' })}
      </div>
      <p class="notice">${esc(profile.verificationStatus === 'verified' ? t('employer.verificationVerified') : t('employer.verificationUnverified'))}</p>`;
    }
    if (user.role === 'Consultancy') {
      return `<div class="form-grid">
        ${field({ id: 'p-agency', label: t('auth.agencyName'), value: profile.agencyName || '' })}
        ${field({ id: 'p-city', label: t('auth.city'), value: profile.city || '' })}
        ${field({ id: 'p-registration', label: t('auth.registrationReference'), value: profile.registrationReference || '' })}
      </div>
      <p class="notice">${esc(profile.verificationStatus === 'verified' ? t('employer.verificationVerified') : t('employer.verificationUnverified'))}</p>`;
    }
    return '';
  })();

  return shell('#/profile', t('worker.profileTitle'), roleLabel(user.role), `
    <form class="card" data-action="save-profile" novalidate>
      <div class="row profile-head">
        <span class="avatar big" aria-hidden="true">${esc(initials(user.name))}</span>
        <div>
          <strong>${esc(user.name)}</strong>
          <div class="muted tiny">${esc(user.email || user.phone || '')}</div>
        </div>
      </div>
      <div class="form-grid">
        ${field({ id: 'p-name', label: t('auth.fullName'), value: user.name, required: true })}
        ${field({ id: 'p-email', label: t('common.email'), type: 'email', value: user.email || '' })}
        ${field({ id: 'p-phone', label: t('common.phone'), type: 'tel', value: user.phone || '' })}
        ${select({
    id: 'p-language',
    label: t('auth.preferredLanguage'),
    options: SUPPORTED.map(l => ({ value: l.code, label: l.label })),
    value: user.language || lang()
  })}
      </div>
      ${roleFields}
      <button class="btn primary" type="submit">${esc(t('common.save'))}</button>
    </form>

    <form class="card" data-action="change-password" novalidate>
      <strong>${esc(t('auth.changePassword'))}</strong>
      ${passwordField({ id: 'cp-current', label: t('auth.currentPassword'), autocomplete: 'current-password' })}
      ${passwordField({ id: 'cp-new', label: t('auth.newPassword'), hint: t('auth.passwordHint'), autocomplete: 'new-password' })}
      <button class="btn" type="submit">${esc(t('auth.changePassword'))}</button>
    </form>
  `);
}

async function notificationsView() {
  const res = await api.get('/api/notifications');
  const rows = res.data || [];
  return shell('#/notifications', t('worker.notificationsTitle'), '',
    rows.length
      ? `<div class="list">${rows.map(item => `
          <div class="list-item">
            <div>
              <strong>${esc(t(item.titleKey, item.params))}</strong>
              <div class="muted tiny">${esc(formatDate(item.at, true))}</div>
            </div>
          </div>`).join('')}</div>`
      : emptyState(t('worker.noNotifications'), ''));
}

async function messagesView() {
  const res = await api.get('/api/messages');
  const rows = res.data || [];
  return shell('#/messages', t('worker.messagesTitle'), '',
    rows.length
      ? `<div class="stack">${rows.map(message => `
          <article class="card ${message.unread ? 'unread' : ''}">
            <div class="spaced">
              <div class="row">
                <span class="avatar" aria-hidden="true">${esc(initials(message.fromName))}</span>
                <div>
                  <strong>${esc(message.subject)}</strong>
                  <div class="muted tiny">${esc(message.fromName)} · ${esc(formatDate(message.createdAt, true))}</div>
                </div>
              </div>
              ${message.unread ? badge('●', 'b-blue') : ''}
            </div>
            <p class="body-copy">${esc(message.body)}</p>
            ${message.unread ? `<button class="btn small" data-action="read-message" data-id="${attr(message.id)}">${esc(t('common.confirm'))}</button>` : ''}
          </article>`).join('')}</div>`
      : emptyState(t('worker.noMessages'), ''));
}

async function assistantPageView() {
  ensureAssistantLoaded();
  return shell('#/assistant', t('assistant.title'), t('assistant.subtitle'), `
    <div class="card assistant-page">
      <div class="row spaced">
        <strong>${esc(t('assistant.title'))}</strong>
        <button class="btn small" data-action="assistant-reset">${esc(t('assistant.reset'))}</button>
      </div>
      <div data-assistant-page>${assistantBody()}</div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Employer views
// ---------------------------------------------------------------------------

function listingStatusBadge(status) {
  const variant = {
    published: 'b-green',
    draft: 'b-blue',
    under_review: 'b-gold',
    suspended: 'b-red',
    closed: 'b-red'
  }[status] || '';
  return badge(t(`employer.listingStatus.${status}`), variant);
}

async function employerDashboardView() {
  const [jobsRes, appsRes] = await Promise.all([
    api.get('/api/jobs', { scope: 'mine', pageSize: 100 }),
    api.get('/api/applications', { pageSize: 100 })
  ]);
  const jobs = jobsRes.data || [];
  const apps = appsRes.data || [];
  const profile = state.user.profile || {};

  return shell('#/employer', t('employer.dashboardTitle'),
    t('employer.dashboardSub', { company: profile.companyName || state.user.name }), `
    <div class="stat-grid">
      ${[
      [t('employer.activeListings'), jobs.filter(j => j.status === 'published').length],
      [t('employer.underReview'), jobs.filter(j => j.status === 'under_review').length],
      [t('employer.totalApplicants'), apps.length],
      [t('employer.shortlisted'), apps.filter(a => a.status === 'Shortlisted').length]
    ].map(([label, value]) => `
        <div class="card stat">
          <div><div class="muted">${esc(label)}</div><div class="num">${value}</div></div>
        </div>`).join('')}
    </div>

    ${profile.verificationStatus !== 'verified'
      ? `<p class="notice">${esc(t('employer.verificationUnverified'))}</p>` : ''}

    <div class="grid2">
      <div class="card">
        <div class="spaced">
          <strong>${esc(t('employer.myListings'))}</strong>
          <a class="btn primary small" href="#/employer/post">${esc(t('nav.postJob'))}</a>
        </div>
        ${jobs.length ? `<div class="list">${jobs.slice(0, 6).map(job => `
          <div class="list-item">
            <div>
              <strong>${esc(job.title)}</strong>
              <div class="muted tiny">${esc(job.location)}</div>
            </div>
            ${listingStatusBadge(job.status)}
          </div>`).join('')}</div>` : `<p class="muted">${esc(t('employer.noListings'))}</p>`}
      </div>
      <div class="card">
        <div class="spaced">
          <strong>${esc(t('employer.applicantsTitle'))}</strong>
          <a class="muted" href="#/employer/applicants">${esc(t('common.seeAll'))}</a>
        </div>
        ${apps.length ? `<div class="list">${apps.slice(0, 6).map(application => `
          <div class="list-item">
            <div>
              <strong>${esc(application.candidate ? application.candidate.name : t('common.unknown'))}</strong>
              <div class="muted tiny">${esc(application.jobTitle)}</div>
            </div>
            <div class="row gap-6">
              ${application.matchScore !== undefined ? badge(t('worker.matchScore', { score: application.matchScore }), 'b-blue') : ''}
              ${stageBadge(application.status)}
            </div>
          </div>`).join('')}</div>` : `<p class="muted">${esc(t('employer.noApplicants'))}</p>`}
      </div>
    </div>
  `);
}

async function employerPostView() {
  const categories = ((state.meta && state.meta.jobCategories) || ['Other']).map(c => ({ value: c, label: c }));
  const countries = ((state.meta && state.meta.countries) || ['UAE']).map(c => ({ value: c, label: c }));
  const profile = state.user.profile || {};

  return shell('#/employer/post', t('employer.postJobTitle'), t('employer.postJobSub'), `
    <form class="card" data-action="create-job" novalidate>
      <div class="form-grid">
        ${field({ id: 'job-title', label: t('employer.jobTitle'), required: true })}
        ${field({ id: 'job-company', label: t('auth.companyName'), value: profile.companyName || state.user.name, required: true })}
        ${select({ id: 'job-category', label: t('employer.category'), options: categories, required: true })}
        ${select({ id: 'job-country', label: t('employer.country'), options: countries, value: profile.country || '', required: true })}
        ${field({ id: 'job-city', label: t('employer.city'), value: profile.city || '', required: true })}
        ${field({ id: 'job-salary', label: t('employer.salaryText'), placeholder: t('employer.salaryPlaceholder'), required: true })}
        ${field({ id: 'job-inr', label: t('employer.inrEquivalent') })}
        ${field({ id: 'job-exp', label: t('employer.experienceRequired'), value: '2+ years', required: true })}
        ${field({ id: 'job-hours', label: t('employer.hours'), value: '8 hours', required: true })}
        ${field({ id: 'job-vacancies', label: t('employer.vacancies'), type: 'number', value: '5', required: true, attrs: 'min="1" max="5000"' })}
        ${select({ id: 'job-visa', label: t('employer.visa'), options: [{ value: 'Yes', label: t('common.yes') }, { value: 'No', label: t('common.no') }], required: true })}
      </div>

      <div class="field">
        <span class="label-like">${esc(t('employer.benefitsLabel'))}</span>
        <div class="chips">
          ${['Accommodation', 'Food Allowance', 'Transport', 'Medical Insurance', 'Overtime', 'Flight Tickets']
      .map((b, i) => checkbox({ id: `benefit-${i}`, label: b, checked: i < 3 })).join('')}
        </div>
      </div>

      ${textarea({ id: 'job-description', label: t('employer.descriptionLabel'), rows: 5, required: true })}
      ${textarea({ id: 'job-requirements', label: t('employer.requirementsLabel'), rows: 3, required: true })}

      <div class="toolbar">
        <button class="btn primary" type="submit" data-status="published">${esc(t('employer.publish'))}</button>
        <button class="btn" type="submit" data-status="draft">${esc(t('employer.saveDraft'))}</button>
      </div>
      <div id="risk-result"></div>
    </form>
  `);
}

function riskPanel(risk, heldForReview) {
  return `<div class="card ${heldForReview ? 'danger-card' : 'success-card'}">
    <div class="spaced">
      <strong>${esc(t('employer.riskTitle'))}</strong>
      ${badge(t('employer.riskScore', { score: risk.score, band: risk.band }), risk.band === 'high' ? 'b-red' : risk.band === 'medium' ? 'b-gold' : 'b-green')}
    </div>
    ${heldForReview ? `<p class="notice danger">${esc(t('employer.heldForReview'))}</p>` : ''}
    ${risk.factors.length
    ? `<ul class="reason-list">${risk.factors.map(f => `<li><span class="weight">+${f.weight}</span> ${esc(f.detail)}</li>`).join('')}</ul>`
    : `<p class="muted">${esc(t('employer.riskNoFactors'))}</p>`}
    <p class="muted tiny">${esc(t('employer.riskExplainer'))}</p>
  </div>`;
}

async function employerJobsView() {
  const res = await api.get('/api/jobs', { scope: 'mine', pageSize: 100 });
  const jobs = res.data || [];
  if (!jobs.length) {
    return shell('#/employer/jobs', t('employer.myListings'), '',
      emptyState(t('employer.noListings'), '', t('nav.postJob'), 'data-action="nav" data-href="#/employer/post"'));
  }

  return shell('#/employer/jobs', t('employer.myListings'), t('worker.jobsFound', { count: res.total }), `
    <div class="card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>${esc(t('employer.jobTitle'))}</th>
            <th>${esc(t('worker.location'))}</th>
            <th>${esc(t('worker.salary'))}</th>
            <th>${esc(t('admin.riskScore'))}</th>
            <th>${esc(t('common.status'))}</th>
            <th>${esc(t('common.actions'))}</th>
          </tr></thead>
          <tbody>
            ${jobs.map(job => `<tr>
              <td><strong>${esc(job.title)}</strong><br><span class="muted tiny">${esc(job.company)}</span></td>
              <td>${esc(job.location)}</td>
              <td>${esc(job.salary)}</td>
              <td>${job.risk ? esc(`${job.risk.score} (${job.risk.band})`) : esc(t('common.notAvailable'))}</td>
              <td>${listingStatusBadge(job.status)}</td>
              <td class="row gap-6">
                <a class="btn small" href="#/employer/job/${encodeURIComponent(job.id)}">${esc(t('nav.applicants'))}</a>
                ${job.risk ? `<button class="btn small" data-action="show-risk" data-job="${attr(job.id)}">${esc(t('admin.riskFactors'))}</button>` : ''}
                <button class="btn small danger" data-action="delete-job" data-id="${attr(job.id)}" data-title="${attr(job.title)}">${esc(t('common.remove'))}</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `);
}

function applicantCard(row, jobId) {
  const candidate = row.candidate || {};
  return `<article class="card">
    <div class="spaced">
      <div class="row">
        <span class="avatar" aria-hidden="true">${esc(initials(candidate.name))}</span>
        <div>
          <strong>${esc(candidate.name || t('common.unknown'))}</strong>
          <div class="muted tiny">${esc(candidate.trade || '')} · ${esc(t('employer.yearsShort', { years: candidate.experienceYears || 0 }))}</div>
        </div>
      </div>
      <div class="row gap-6">
        ${badge(t('worker.matchScore', { score: row.matchScore }), 'b-blue')}
        ${stageBadge(row.status)}
      </div>
    </div>

    <div class="chips">${(candidate.skills || []).map(chip).join('')}</div>
    <div class="muted tiny">${esc(t('employer.documentsVerified', {
    verified: row.documentSummary ? row.documentSummary.verified : 0,
    total: row.documentSummary ? row.documentSummary.total : 0
  }))}</div>

    <details class="reasons">
      <summary>${esc(t('worker.whyThisMatch'))}</summary>
      <ul class="reason-list">
        ${(row.matchReasons || []).map(r => `<li><span class="weight">${r.weight > 0 ? `+${r.weight}` : '0'}</span> ${esc(r.detail)}</li>`).join('')}
      </ul>
    </details>

    <div class="toolbar">
      ${row.status === 'Applied' ? `<button class="btn primary small" data-action="set-stage" data-id="${attr(row.applicationId)}" data-stage="Shortlisted">${esc(t('employer.shortlist'))}</button>` : ''}
      ${['Shortlisted'].includes(row.status) ? `<button class="btn small" data-action="schedule-interview" data-id="${attr(row.applicationId)}">${esc(t('employer.scheduleInterview'))}</button>` : ''}
      ${['Shortlisted', 'Interview Scheduled'].includes(row.status) ? `<button class="btn small primary" data-action="set-stage" data-id="${attr(row.applicationId)}" data-stage="Offer Issued">${esc(t('employer.issueOffer'))}</button>` : ''}
      ${!['Rejected', 'Withdrawn', 'Placed'].includes(row.status) ? `<button class="btn small danger" data-action="reject-application" data-id="${attr(row.applicationId)}">${esc(t('employer.reject'))}</button>` : ''}
    </div>
    ${jobId ? '' : ''}
  </article>`;
}

async function employerJobApplicantsView(jobId) {
  const [jobRes, applicantsRes] = await Promise.all([
    api.get(`/api/jobs/${encodeURIComponent(jobId)}`),
    api.get(`/api/jobs/${encodeURIComponent(jobId)}/applicants`)
  ]);
  const rows = applicantsRes.data || [];

  return shell('#/employer/jobs', t('employer.applicantsTitle'), jobRes.data.title, `
    <a class="muted back-link" href="#/employer/jobs">← ${esc(t('employer.myListings'))}</a>
    <p class="notice tiny">${esc(t('employer.documentsPrivacyNote'))}</p>
    ${rows.length ? `<div class="grid2">${rows.map(row => applicantCard(row, jobId)).join('')}</div>`
    : emptyState(t('employer.noApplicants'), '')}
  `);
}

async function employerApplicantsView() {
  const res = await api.get('/api/applications', { pageSize: 100 });
  const rows = (res.data || []).map(application => ({
    applicationId: application.id,
    status: application.status,
    candidate: application.candidate,
    matchScore: application.matchScore,
    matchReasons: application.matchReasons,
    documentSummary: null,
    jobTitle: application.jobTitle
  }));

  return shell('#/employer/applicants', t('employer.applicantsTitle'), t('employer.applicantsSub'), `
    <p class="notice tiny">${esc(t('employer.documentsPrivacyNote'))}</p>
    ${rows.length ? `<div class="grid2">${rows.map(row => applicantCard(row, null)).join('')}</div>`
    : emptyState(t('employer.noApplicants'), '')}
  `);
}

// ---------------------------------------------------------------------------
// Consultancy views
// ---------------------------------------------------------------------------

async function consultancyDashboardView() {
  const res = await api.get('/api/consultancy/cases');
  const rows = res.data || [];
  const profile = state.user.profile || {};

  return shell('#/consultancy', t('consultancy.dashboardTitle'),
    t('consultancy.dashboardSub', { agency: profile.agencyName || state.user.name }), `
    <div class="stat-grid">
      ${[
      [t('consultancy.caseload'), rows.length],
      [t('admin.visaCases'), rows.filter(r => r.progress < 100).length],
      [t('employer.placed'), rows.filter(r => r.progress === 100).length]
    ].map(([label, value]) => `<div class="card stat"><div><div class="muted">${esc(label)}</div><div class="num">${value}</div></div></div>`).join('')}
    </div>

    ${rows.length ? `<div class="card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>${esc(t('employer.candidate'))}</th>
            <th>${esc(t('consultancy.destination'))}</th>
            <th>${esc(t('consultancy.currentStage'))}</th>
            <th>${esc(t('consultancy.documentStatus'))}</th>
            <th>${esc(t('common.actions'))}</th>
          </tr></thead>
          <tbody>
            ${rows.map(row => `<tr>
              <td><strong>${esc(row.worker ? row.worker.name : t('common.unknown'))}</strong><br><span class="muted tiny">${esc(row.role)}</span></td>
              <td>${esc(row.destination || t('common.notAvailable'))}</td>
              <td>${badge(row.currentStage, 'b-blue')}<div class="muted tiny">${esc(t('worker.visaProgress', { percent: row.progress }))}</div></td>
              <td>${esc(`${row.documents.verified}/${row.documents.visible}`)}${row.documents.restricted ? `<div class="muted tiny">${esc(t('consultancy.restrictedDocs', { count: row.documents.restricted }))}</div>` : ''}</td>
              <td><a class="btn small" href="#/consultancy/case/${encodeURIComponent(row.caseId)}">${esc(t('common.view'))}</a></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : emptyState(t('consultancy.casesNone'), '', t('consultancy.openCases'), 'data-action="nav" data-href="#/consultancy/offers"')}
  `);
}

async function consultancyOffersView() {
  const res = await api.get('/api/applications', { status: 'Offer Issued', pageSize: 50 });
  const rows = res.data || [];
  return shell('#/consultancy/offers', t('consultancy.availableOffers'), '',
    rows.length ? `<div class="grid2">${rows.map(application => `
      <article class="card">
        <div class="spaced">
          <div>
            <strong>${esc(application.candidate ? application.candidate.name : t('common.unknown'))}</strong>
            <div class="muted tiny">${esc(application.jobTitle)} · ${esc(application.company)}</div>
          </div>
          ${stageBadge(application.status)}
        </div>
        <button class="btn primary small" data-action="take-case" data-id="${attr(application.id)}">${esc(t('consultancy.takeCase'))}</button>
      </article>`).join('')}</div>`
      : emptyState(t('consultancy.casesNone'), ''));
}

async function consultancyCaseView(caseId) {
  const res = await api.get(`/api/visa/cases/${encodeURIComponent(caseId)}`);
  const row = res.data;
  const stageOptions = row.stages.map(s => ({ value: s.name, label: s.name }));

  return shell('#/consultancy/cases',
    t('consultancy.caseTitle', { id: row.id, worker: row.worker ? row.worker.name : '' }),
    `${row.role || ''} · ${row.destination || ''}`, `
    <a class="muted back-link" href="#/consultancy">← ${esc(t('nav.dashboard'))}</a>
    <div class="grid2">
      <div class="card">
        <div class="spaced">
          <strong>${esc(t('worker.visaTitle'))}</strong>
          ${badge(t('worker.visaProgress', { percent: row.progress }), 'b-blue')}
        </div>
        ${progressBar(row.progress)}
        ${visaTimeline(row.stages)}
      </div>
      <div>
        <form class="card" data-action="update-stage" data-case="${attr(row.id)}" novalidate>
          <strong>${esc(t('consultancy.updateMilestone'))}</strong>
          ${select({ id: 'stage-name', label: t('consultancy.milestone'), options: stageOptions, required: true })}
          ${select({
      id: 'stage-status',
      label: t('consultancy.milestoneStatus'),
      options: [
        { value: 'current', label: t('worker.stageCurrent') },
        { value: 'done', label: t('worker.stageDone') },
        { value: 'blocked', label: t('worker.stageBlocked') },
        { value: 'pending', label: t('worker.stagePending') }
      ],
      required: true
    })}
          ${textarea({ id: 'stage-note', label: t('consultancy.milestoneNote'), rows: 2 })}
          <button class="btn primary" type="submit">${esc(t('common.save'))}</button>
        </form>

        <div class="card">
          <strong>${esc(t('consultancy.documentStatus'))}</strong>
          ${row.restrictedDocumentCount
      ? `<p class="notice tiny">${esc(t('consultancy.restrictedDocs', { count: row.restrictedDocumentCount }))} — ${esc(t('consultancy.restrictedExplainer'))}</p>`
      : ''}
          ${(row.documents || []).length ? `<div class="list">${row.documents.map(doc => `
            <div class="list-item">
              <div>
                <strong>${esc(doc.name)}</strong>
                <div class="muted tiny">${esc(t(`worker.documentTypes.${doc.type}`))}</div>
              </div>
              <div class="row gap-6">
                ${documentStatusBadge(doc.status)}
                ${doc.status !== 'Verified'
        ? `<button class="btn small primary" data-action="verify-document" data-id="${attr(doc.id)}">${esc(t('consultancy.verifyDocument'))}</button>` : ''}
                ${doc.status !== 'Rejected'
        ? `<button class="btn small danger" data-action="reject-document" data-id="${attr(doc.id)}">${esc(t('consultancy.rejectDocument'))}</button>` : ''}
              </div>
            </div>`).join('')}</div>` : `<p class="muted">${esc(t('worker.noDocuments'))}</p>`}
        </div>
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

async function adminDashboardView() {
  const res = await api.get('/api/admin/stats');
  const stats = res.data;

  const wageRows = Object.entries(stats.wages.indicativeAverageMonthlyWage || {});

  return shell('#/admin', t('admin.dashboardTitle'), t('admin.dashboardSub'), `
    <div class="stat-grid">
      ${[
      [t('admin.users'), stats.users.total],
      [t('admin.jobs'), stats.jobs.total],
      [t('admin.applications'), stats.applications.total],
      [t('admin.placements'), stats.placements]
    ].map(([label, value]) => `<div class="card stat"><div><div class="muted">${esc(label)}</div><div class="num">${value}</div></div></div>`).join('')}
    </div>

    <div class="grid2">
      <div class="card">
        <div class="spaced">
          <strong>${esc(t('admin.queueTitle'))}</strong>
          <a class="btn small primary" href="#/admin/queue">${esc(t('common.view'))}</a>
        </div>
        <div class="list">
          <div class="list-item"><span>${esc(t('admin.jobs'))} — ${esc(t('employer.listingStatus.under_review'))}</span>${badge(stats.jobs.byStatus.under_review || 0, 'b-gold')}</div>
          <div class="list-item"><span>${esc(t('admin.riskFactors'))}</span>${badge(stats.jobs.flagged, 'b-red')}</div>
          <div class="list-item"><span>${esc(t('admin.users'))} — ${esc(t('admin.suspend'))}</span>${badge(stats.users.suspended, 'b-red')}</div>
        </div>
        <p class="muted tiny">${esc(t('admin.riskDisclaimer'))}</p>
      </div>

      <div class="card">
        <strong>${esc(t('admin.wageMetrics'))}</strong>
        ${wageRows.length ? `<div class="list">${wageRows.map(([key, value]) => `
          <div class="list-item"><span>${esc(key)}</span><strong>${esc(value)}</strong></div>`).join('')}</div>`
      : `<p class="muted">${esc(t('common.notAvailable'))}</p>`}
        <p class="muted tiny">${esc(t('admin.wageNote'))}</p>
      </div>
    </div>

    <div class="grid2">
      <div class="card">
        <strong>${esc(t('admin.applications'))}</strong>
        <div class="list">
          ${Object.entries(stats.applications.byStage || {}).map(([stage, count]) => `
            <div class="list-item"><span>${esc(stage)}</span>${badge(count, 'b-blue')}</div>`).join('') || `<p class="muted">${esc(t('common.none'))}</p>`}
        </div>
      </div>
      <div class="card">
        <strong>${esc(t('admin.documents'))}</strong>
        <div class="list">
          <div class="list-item"><span>${esc(t('admin.documents'))}</span>${badge(stats.documents.total, 'b-blue')}</div>
          <div class="list-item"><span>${esc(t('worker.docVerified'))}</span>${badge(stats.documents.verified, 'b-green')}</div>
          <div class="list-item"><span>${esc(t('admin.visaCases'))}</span>${badge(stats.visaCases.total, 'b-blue')}</div>
        </div>
      </div>
    </div>
  `);
}

async function adminQueueView() {
  const res = await api.get('/api/admin/fraud-queue');
  const rows = res.data || [];

  return shell('#/admin/queue', t('admin.queueTitle'), t('admin.queueSub'),
    rows.length ? `
    <p class="notice">${esc(t('admin.riskDisclaimer'))}</p>
    <div class="stack">
      ${rows.map(row => `
        <article class="card ${row.riskBand === 'high' ? 'danger-card' : ''}">
          <div class="spaced">
            <div>
              <h3>${esc(row.title)}</h3>
              <div class="muted tiny">${esc(row.company)} · ${esc(row.location)} · ${esc(row.salary)}</div>
            </div>
            ${badge(`${t('admin.riskScore')} ${row.riskScore} (${row.riskBand})`, row.riskBand === 'high' ? 'b-red' : 'b-gold')}
          </div>

          <strong class="block-label">${esc(t('admin.riskFactors'))}</strong>
          <ul class="reason-list">
            ${(row.factors || []).map(f => `<li><span class="weight">${esc(t('admin.factorWeight', { weight: f.weight }))}</span> ${esc(f.detail)} <span class="muted tiny">(${esc(f.code)})</span></li>`).join('')}
          </ul>
          ${row.salaryBandUsed ? `<p class="muted tiny">${esc(t('admin.salaryBandUsed', {
      currency: row.salaryBandUsed.currency,
      low: row.salaryBandUsed.low,
      high: row.salaryBandUsed.high
    }))}</p>` : ''}

          <strong class="block-label">${esc(t('admin.employerInfo'))}</strong>
          ${row.employer ? `<div class="muted tiny">
            ${esc(row.employer.name)} · ${esc(row.employer.email || '')} ·
            ${esc(row.employer.verificationStatus)} ·
            ${esc(t('admin.accountCreated', { date: formatDate(row.employer.createdAt) }))}
          </div>` : `<div class="muted tiny">${esc(t('common.notAvailable'))}</div>`}

          <strong class="block-label">${esc(t('admin.reports'))}</strong>
          ${(row.reports || []).length ? `<ul class="reason-list">${row.reports.map(r => `
            <li>${esc(r.reason)} <span class="muted tiny">(${esc(r.byRole)} · ${esc(formatDate(r.at))})</span></li>`).join('')}</ul>`
      : `<p class="muted tiny">${esc(t('admin.noReports'))}</p>`}

          <div class="toolbar">
            <a class="btn small" href="#/job/${encodeURIComponent(row.id)}">${esc(t('admin.investigate'))}</a>
            <button class="btn small primary" data-action="fraud-action" data-id="${attr(row.id)}" data-act="clear">${esc(t('admin.clearListing'))}</button>
            <button class="btn small" data-action="fraud-action" data-id="${attr(row.id)}" data-act="suspend">${esc(t('admin.suspendListing'))}</button>
            <button class="btn small danger" data-action="fraud-action" data-id="${attr(row.id)}" data-act="remove">${esc(t('admin.removeListing'))}</button>
          </div>
        </article>`).join('')}
    </div>` : emptyState(t('admin.queueEmpty'), ''));
}

async function adminUsersView() {
  const res = await api.get('/api/admin/users');
  const rows = res.data || [];

  return shell('#/admin/users', t('admin.usersTitle'), '', `
    <form class="searchbar" data-action="admin-user-search">
      <label class="visually-hidden" for="admin-user-search">${esc(t('admin.searchUsers'))}</label>
      <input class="input" id="admin-user-search" placeholder="${attr(t('admin.searchUsers'))}">
      <button class="btn primary" type="submit">${esc(t('common.search'))}</button>
    </form>
    <div class="card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>${esc(t('common.name'))}</th>
            <th>${esc(t('common.role'))}</th>
            <th>${esc(t('common.status'))}</th>
            <th>${esc(t('admin.verification'))}</th>
            <th>${esc(t('common.actions'))}</th>
          </tr></thead>
          <tbody>
            ${rows.map(user => `<tr>
              <td><strong>${esc(user.name)}</strong><br><span class="muted tiny">${esc(user.email || user.phone || '')}</span></td>
              <td>${esc(roleLabel(user.role))}</td>
              <td>${user.status === 'active' ? badge(user.status, 'b-green') : badge(user.status, 'b-red')}</td>
              <td>${['Employer', 'Consultancy'].includes(user.role)
      ? esc((user.profile && user.profile.verificationStatus) || 'unverified') : '—'}</td>
              <td class="row gap-6">
                ${user.status === 'active'
      ? `<button class="btn small danger" data-action="user-status" data-id="${attr(user.id)}" data-status="suspended">${esc(t('admin.suspend'))}</button>`
      : `<button class="btn small" data-action="user-status" data-id="${attr(user.id)}" data-status="active">${esc(t('admin.reactivate'))}</button>`}
                ${['Employer', 'Consultancy'].includes(user.role)
      ? `<button class="btn small" data-action="user-verification" data-id="${attr(user.id)}">${esc(t('admin.setVerification'))}</button>` : ''}
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `);
}

async function adminJobsView() {
  const res = await api.get('/api/admin/jobs');
  const rows = res.data || [];
  return shell('#/admin/jobs', t('admin.listingsTitle'), '', `
    <div class="card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>${esc(t('employer.jobTitle'))}</th>
            <th>${esc(t('worker.location'))}</th>
            <th>${esc(t('admin.riskScore'))}</th>
            <th>${esc(t('common.status'))}</th>
            <th>${esc(t('nav.applicants'))}</th>
            <th>${esc(t('common.actions'))}</th>
          </tr></thead>
          <tbody>
            ${rows.map(job => `<tr>
              <td><strong>${esc(job.title)}</strong><br><span class="muted tiny">${esc(job.company)}</span></td>
              <td>${esc(job.location)}</td>
              <td>${job.riskScore === null ? '—' : esc(job.riskScore)}</td>
              <td>${listingStatusBadge(job.status)}</td>
              <td>${esc(job.applicants)}</td>
              <td class="row gap-6">
                <a class="btn small" href="#/job/${encodeURIComponent(job.id)}">${esc(t('common.view'))}</a>
                <button class="btn small" data-action="reassess-job" data-id="${attr(job.id)}">${esc(t('admin.riskScore'))} ↻</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `);
}

async function adminAuditView() {
  const res = await api.get('/api/admin/audit-log', { limit: 200 });
  const rows = res.data || [];
  return shell('#/admin/audit', t('admin.auditTitle'), t('admin.auditSub'),
    rows.length ? `<div class="card">
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>${esc(t('common.date'))}</th>
            <th>${esc(t('admin.actor'))}</th>
            <th>${esc(t('admin.action'))}</th>
            <th>${esc(t('admin.target'))}</th>
            <th>${esc(t('admin.summary'))}</th>
          </tr></thead>
          <tbody>
            ${rows.map(entry => `<tr>
              <td>${esc(formatDate(entry.at, true))}</td>
              <td>${esc(entry.actorName)}<br><span class="muted tiny">${esc(entry.actorRole)}</span></td>
              <td><code>${esc(entry.action)}</code></td>
              <td>${esc(entry.targetType || '')} ${esc(entry.targetId === null ? '' : entry.targetId)}</td>
              <td>${esc(entry.summary || '')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : emptyState(t('admin.auditEmpty'), ''));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ROUTES = [
  { pattern: /^\/?(landing)?$/, view: landingView, public: true },
  { pattern: /^\/login$/, view: loginView, public: true, guestOnly: true },
  { pattern: /^\/register$/, view: registerView, public: true, guestOnly: true },
  { pattern: /^\/forgot$/, view: forgotView, public: true, guestOnly: true },
  { pattern: /^\/onboarding-(\d)$/, view: (step) => onboardingView(Number(step)), public: true },
  { pattern: /^\/job\/([^/]+)$/, view: workerJobView, public: true },

  { pattern: /^\/worker$/, view: workerDashboardView, roles: ['Worker'] },
  { pattern: /^\/jobs$/, view: workerJobsView, roles: ['Worker', 'Employer', 'Consultancy', 'Admin'] },
  { pattern: /^\/apply\/([^/]+)$/, view: workerApplyView, roles: ['Worker'] },
  { pattern: /^\/applications$/, view: workerApplicationsView, roles: ['Worker'] },
  { pattern: /^\/visa$/, view: workerVisaView, roles: ['Worker'] },
  { pattern: /^\/documents$/, view: workerDocumentsView, roles: ['Worker', 'Admin'] },
  { pattern: /^\/salary$/, view: salaryGuideView, roles: ['Worker', 'Employer', 'Consultancy', 'Admin'] },
  { pattern: /^\/profile$/, view: profileView, roles: ['Worker', 'Employer', 'Consultancy', 'Admin'] },
  { pattern: /^\/notifications$/, view: notificationsView, roles: ['Worker', 'Employer', 'Consultancy', 'Admin'] },
  { pattern: /^\/messages$/, view: messagesView, roles: ['Worker', 'Employer', 'Consultancy', 'Admin'] },
  { pattern: /^\/assistant$/, view: assistantPageView, roles: ['Worker', 'Employer', 'Consultancy', 'Admin'] },

  { pattern: /^\/employer$/, view: employerDashboardView, roles: ['Employer'] },
  { pattern: /^\/employer\/post$/, view: employerPostView, roles: ['Employer'] },
  { pattern: /^\/employer\/jobs$/, view: employerJobsView, roles: ['Employer'] },
  { pattern: /^\/employer\/job\/([^/]+)$/, view: employerJobApplicantsView, roles: ['Employer', 'Admin'] },
  { pattern: /^\/employer\/applicants$/, view: employerApplicantsView, roles: ['Employer'] },

  { pattern: /^\/consultancy$/, view: consultancyDashboardView, roles: ['Consultancy'] },
  { pattern: /^\/consultancy\/cases$/, view: consultancyDashboardView, roles: ['Consultancy'] },
  { pattern: /^\/consultancy\/offers$/, view: consultancyOffersView, roles: ['Consultancy'] },
  { pattern: /^\/consultancy\/case\/([^/]+)$/, view: consultancyCaseView, roles: ['Consultancy', 'Admin'] },

  { pattern: /^\/admin$/, view: adminDashboardView, roles: ['Admin'] },
  { pattern: /^\/admin\/queue$/, view: adminQueueView, roles: ['Admin'] },
  { pattern: /^\/admin\/users$/, view: adminUsersView, roles: ['Admin'] },
  { pattern: /^\/admin\/jobs$/, view: adminJobsView, roles: ['Admin'] },
  { pattern: /^\/admin\/audit$/, view: adminAuditView, roles: ['Admin'] }
];

function unauthorizedView(titleKey, copyKey) {
  const inner = `<div class="card">
    <div class="empty">
      <h3>${esc(t(titleKey))}</h3>
      <p class="muted">${esc(t(copyKey))}</p>
      <div class="toolbar center-toolbar">
        ${state.user
    ? `<a class="btn primary" href="${attr(homeFor(state.user))}">${esc(t('auth.goToDashboard'))}</a>`
    : `<a class="btn primary" href="#/login">${esc(t('common.signIn'))}</a>`}
      </div>
    </div>
  </div>`;
  return state.user ? shell('', t(titleKey), '', inner) : publicPageShell(inner);
}

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const path = location.hash.replace(/^#/, '') || '/';
  const match = ROUTES.find(route => route.pattern.test(path));

  if (!match) {
    appRoot.innerHTML = unauthorizedView('validation.ROUTE_NOT_FOUND', 'auth.unauthorizedCopy');
    return;
  }
  if (match.guestOnly && state.user) {
    go(homeFor(state.user));
    return;
  }
  if (!match.public) {
    if (!state.user) {
      appRoot.innerHTML = unauthorizedView('auth.sessionExpiredTitle', 'auth.sessionExpiredCopy');
      renderAssistant();
      return;
    }
    if (match.roles && !match.roles.includes(state.user.role)) {
      appRoot.innerHTML = unauthorizedView('auth.unauthorizedTitle', 'auth.unauthorizedCopy');
      renderAssistant();
      return;
    }
  }

  appRoot.innerHTML = state.user
    ? shell('', t('common.loading'), '', skeleton(4))
    : `<div class="center-page"><div class="auth-card">${skeleton(3)}</div></div>`;

  const args = (match.pattern.exec(path) || []).slice(1).filter(v => v !== undefined);
  try {
    const html = await match.view(...args);
    if (token !== renderToken) return; // a newer navigation won
    appRoot.innerHTML = html;
  } catch (err) {
    if (token !== renderToken) return;
    if (err instanceof ApiError && (err.code === 'AUTH_REQUIRED' || err.code === 'SESSION_EXPIRED')) {
      state.user = null;
      resetAssistantCache();
      appRoot.innerHTML = unauthorizedView('auth.sessionExpiredTitle', 'auth.sessionExpiredCopy');
    } else if (err instanceof ApiError && (err.code === 'FORBIDDEN_ROLE' || err.code === 'FORBIDDEN_RESOURCE')) {
      appRoot.innerHTML = unauthorizedView('auth.unauthorizedTitle', 'auth.unauthorizedCopy');
    } else {
      const message = err instanceof ApiError ? tError(err.code, err.message) : t('validation.unknownError');
      const body = errorState(message, 'data-action="reload-view"');
      appRoot.innerHTML = state.user ? shell('', t('assistant.errorTitle'), '', body) : publicPageShell(body);
      console.error('[view error]', err);
    }
  }

  renderAssistant();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function readForm(ids) {
  const values = {};
  for (const [key, id] of Object.entries(ids)) {
    const el = document.getElementById(id);
    if (!el) { values[key] = ''; continue; }
    values[key] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  return values;
}

function csvList(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function showApiError(err, fieldMap = {}) {
  if (!(err instanceof ApiError)) {
    toast(t('validation.unknownError'), 'error');
    console.error(err);
    return;
  }
  const message = tError(err.code, err.message);
  const fieldName = err.details && err.details.field;
  const inputId = fieldName && fieldMap[fieldName];
  if (inputId) {
    setFieldError(inputId, message);
    const el = document.getElementById(inputId);
    if (el) el.focus();
  }
  toast(message, 'error');
}

async function refreshSession() {
  try {
    const res = await api.get('/api/auth/me');
    state.user = res.user;
    return res.user;
  } catch (_) {
    state.user = null;
    return null;
  }
}

async function afterLogin(user) {
  state.user = user;
  resetAssistantCache();
  if (user.language && user.language !== lang()) await setLanguage(user.language);
  await loadMeta();
  go(homeFor(user));
}

async function loadMeta() {
  if (state.meta) return state.meta;
  try {
    const res = await api.get('/api/meta');
    state.meta = res.data;
  } catch (_) {
    state.meta = null;
  }
  return state.meta;
}

const actions = {
  nav(el) {
    go(el.dataset.href);
  },

  'reload-view'() {
    render();
  },

  async 'set-language'(el) {
    const code = el.dataset.lang;
    await setLanguage(code);
    if (state.user) {
      // Persist the choice on the account so it survives a new device/session.
      try {
        const res = await api.patch('/api/auth/me', { language: code });
        state.user = res.user;
      } catch (_) { /* the local switch still applies */ }
    }
    toast(t('assistant.languageSwitched', { language: languageLabel(code) }), 'success');
    render();
  },

  'toggle-password'(el) {
    const input = document.getElementById(el.dataset.target);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.textContent = show ? t('common.hide') : t('common.show');
  },

  'select-role'(el) {
    registerRole = el.dataset.role;
    document.querySelectorAll('#role-selector .role-chip-btn').forEach(btn => {
      const active = btn.dataset.role === registerRole;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const host = document.getElementById('role-fields');
    if (host) host.innerHTML = registerRoleFields(registerRole);
  },

  async logout() {
    try { await api.post('/api/auth/logout'); } catch (_) { /* clear locally anyway */ }
    state.user = null;
    state.meta = null;
    resetAssistantCache();
    toast(t('auth.signedOut'), 'success');
    go('#/landing');
  },

  'job-filter'(el) {
    state.jobFilters[el.dataset.key] = el.dataset.value;
    state.jobFilters.page = 1;
    render();
  },

  'jobs-page'(el) {
    state.jobFilters.page = Number(el.dataset.page) || 1;
    render();
  },

  'clear-job-filters'() {
    state.jobFilters = { search: '', type: 'All', category: 'All', country: 'All', page: 1 };
    render();
  },

  async 'explain-match'(el) {
    try {
      const res = await api.get(`/api/jobs/${encodeURIComponent(el.dataset.job)}`);
      const reasons = res.data.matchReasons || [];
      await dialog({
        title: t('worker.whyThisMatch'),
        body: `${t('worker.matchScore', { score: res.data.matchScore })} — ${t('worker.matchExplainer')}\n\n`
          + reasons.map(r => `${r.weight > 0 ? `+${r.weight}` : '0'}  ${r.detail}`).join('\n'),
        confirmLabel: t('common.close'),
        cancelLabel: t('common.close')
      });
    } catch (err) {
      showApiError(err);
    }
  },

  async 'show-risk'(el) {
    try {
      const res = await api.get(`/api/jobs/${encodeURIComponent(el.dataset.job)}`);
      const risk = res.data.risk;
      await dialog({
        title: t('employer.riskTitle'),
        body: `${t('employer.riskScore', { score: risk.score, band: risk.band })}\n\n`
          + (risk.factors.length ? risk.factors.map(f => `+${f.weight}  ${f.detail}`).join('\n') : t('employer.riskNoFactors'))
          + `\n\n${t('employer.riskExplainer')}`,
        confirmLabel: t('common.close'),
        cancelLabel: t('common.close')
      });
    } catch (err) {
      showApiError(err);
    }
  },

  async 'report-job'(el) {
    const result = await dialog({
      title: t('worker.reportListing'),
      fields: [{ name: 'reason', type: 'textarea', label: t('worker.reportReason'), required: true }],
      confirmLabel: t('common.send')
    });
    if (!result) return;
    try {
      await api.post(`/api/jobs/${encodeURIComponent(el.dataset.job)}/report`, { reason: result.reason });
      toast(t('worker.reportSubmitted'), 'success');
    } catch (err) {
      showApiError(err);
    }
  },

  async 'withdraw-application'(el) {
    const confirmed = await confirmDialog(t('common.cancel'), t('worker.myApplications'));
    if (!confirmed) return;
    try {
      await api.patch(`/api/applications/${encodeURIComponent(el.dataset.id)}`, { status: 'Withdrawn' });
      toast(t('common.saved'), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'delete-document'(el) {
    const confirmed = await confirmDialog(
      t('common.remove'),
      t('worker.deleteDocConfirm', { name: el.dataset.name })
    );
    if (!confirmed) return;
    try {
      await api.del(`/api/documents/${encodeURIComponent(el.dataset.id)}`);
      toast(t('common.saved'), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'delete-job'(el) {
    const confirmed = await confirmDialog(
      t('common.remove'),
      t('employer.deleteListingConfirm', { title: el.dataset.title })
    );
    if (!confirmed) return;
    try {
      const res = await api.del(`/api/jobs/${encodeURIComponent(el.dataset.id)}`);
      toast(res.message || t('common.saved'), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'set-stage'(el) {
    try {
      await api.patch(`/api/applications/${encodeURIComponent(el.dataset.id)}`, { status: el.dataset.stage });
      toast(t('employer.stageUpdated', { stage: el.dataset.stage }), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'reject-application'(el) {
    const result = await dialog({
      title: t('employer.reject'),
      body: t('employer.confirmReject'),
      fields: [{ name: 'note', type: 'textarea', label: t('admin.statusReason') }],
      danger: true,
      confirmLabel: t('employer.reject')
    });
    if (!result) return;
    try {
      await api.patch(`/api/applications/${encodeURIComponent(el.dataset.id)}`, { status: 'Rejected', note: result.note });
      toast(t('employer.stageUpdated', { stage: 'Rejected' }), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'schedule-interview'(el) {
    const result = await dialog({
      title: t('employer.scheduleInterview'),
      fields: [
        { name: 'when', inputType: 'datetime-local', label: t('employer.interviewTime'), required: true },
        {
          name: 'mode',
          type: 'select',
          label: t('employer.interviewMode'),
          options: [
            { value: 'Video', label: 'Video' },
            { value: 'Phone', label: 'Phone' },
            { value: 'In person', label: 'In person' }
          ]
        },
        { name: 'notes', type: 'textarea', label: t('employer.interviewNotes') }
      ],
      confirmLabel: t('employer.scheduleInterview')
    });
    if (!result) return;
    try {
      await api.post(`/api/applications/${encodeURIComponent(el.dataset.id)}/interview`, {
        scheduledAt: new Date(result.when).toISOString(),
        mode: result.mode,
        notes: result.notes
      });
      toast(t('common.saved'), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'take-case'(el) {
    try {
      await api.post('/api/visa/cases', { applicationId: Number(el.dataset.id) });
      toast(t('consultancy.caseTaken'), 'success');
      go('#/consultancy');
    } catch (err) {
      showApiError(err);
    }
  },

  async 'verify-document'(el) {
    try {
      await api.patch(`/api/documents/${encodeURIComponent(el.dataset.id)}`, { status: 'Verified' });
      toast(t('consultancy.documentReviewed'), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'reject-document'(el) {
    const result = await dialog({
      title: t('consultancy.rejectDocument'),
      fields: [{ name: 'reason', type: 'textarea', label: t('consultancy.rejectReason'), required: true }],
      danger: true
    });
    if (!result) return;
    try {
      await api.patch(`/api/documents/${encodeURIComponent(el.dataset.id)}`, {
        status: 'Rejected',
        rejectionReason: result.reason
      });
      toast(t('consultancy.documentReviewed'), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'fraud-action'(el) {
    const action = el.dataset.act;
    const id = el.dataset.id;
    if (action === 'remove') {
      const confirmed = await confirmDialog(t('admin.removeListing'), t('admin.confirmRemove', { id }));
      if (!confirmed) return;
    }
    const result = await dialog({
      title: t(action === 'clear' ? 'admin.clearListing' : action === 'suspend' ? 'admin.suspendListing' : 'admin.removeListing'),
      body: t('admin.riskDisclaimer'),
      fields: [{ name: 'reason', type: 'textarea', label: t('admin.actionReason'), required: true }],
      danger: action === 'remove'
    });
    if (!result) return;
    try {
      await api.post('/api/admin/fraud-action', { id: Number(id), action, reason: result.reason });
      toast(t('admin.actionRecorded'), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'reassess-job'(el) {
    try {
      const res = await api.post(`/api/admin/jobs/${encodeURIComponent(el.dataset.id)}/reassess`);
      toast(t('employer.riskScore', { score: res.data.score, band: res.data.band }), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'user-status'(el) {
    const status = el.dataset.status;
    const result = await dialog({
      title: t(status === 'suspended' ? 'admin.suspend' : 'admin.reactivate'),
      fields: [{ name: 'reason', type: 'textarea', label: t('admin.statusReason'), required: true }],
      danger: status === 'suspended'
    });
    if (!result) return;
    try {
      await api.patch(`/api/admin/users/${encodeURIComponent(el.dataset.id)}/status`, { status, reason: result.reason });
      toast(t('common.saved'), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'user-verification'(el) {
    const result = await dialog({
      title: t('admin.setVerification'),
      body: t('admin.evidenceRequired'),
      fields: [
        {
          name: 'status',
          type: 'select',
          label: t('admin.verification'),
          options: [
            { value: 'unverified', label: 'unverified' },
            { value: 'in_review', label: 'in_review' },
            { value: 'verified', label: 'verified' },
            { value: 'rejected', label: 'rejected' }
          ]
        },
        { name: 'evidence', label: t('admin.evidenceReference') }
      ]
    });
    if (!result) return;
    try {
      await api.patch(`/api/admin/users/${encodeURIComponent(el.dataset.id)}/verification`, {
        verificationStatus: result.status,
        evidenceReference: result.evidence
      });
      toast(t('admin.verificationUpdated'), 'success');
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  async 'read-message'(el) {
    try {
      await api.patch(`/api/messages/${encodeURIComponent(el.dataset.id)}/read`);
      render();
    } catch (err) {
      showApiError(err);
    }
  },

  'assistant-toggle'() {
    toggleAssistant();
  },

  'assistant-suggest'(el) {
    sendAssistantMessage(el.dataset.text);
  },

  'assistant-retry'() {
    const failed = assistantState().lastFailedMessage;
    if (failed) sendAssistantMessage(failed);
  },

  async 'assistant-reset'() {
    const confirmed = await confirmDialog(t('assistant.reset'), t('assistant.resetConfirm'), { danger: false });
    if (confirmed) clearConversation();
  }
};

/**
 * Handlers for `change` events. A <select> never fires a click that carries its
 * new value, so filter dropdowns are wired here rather than in `actions`.
 */
const changeActions = {
  'job-filter-select'(el) {
    state.jobFilters[el.dataset.key] = el.value;
    state.jobFilters.page = 1;
    render();
  }
};

const submitActions = {
  async login(form, submitter) {
    clearFieldErrors(form);
    const values = readForm({ identifier: 'login-identifier', password: 'login-password' });
    if (!values.identifier) return setFieldError('login-identifier', t('validation.FIELD_REQUIRED'));
    if (!values.password) return setFieldError('login-password', t('validation.FIELD_REQUIRED'));

    setButtonBusy(submitter, true, t('auth.signingIn'));
    try {
      const res = await api.post('/api/auth/login', values);
      toast(t('auth.welcomeBack', { name: res.user.name }), 'success');
      await afterLogin(res.user);
    } catch (err) {
      showApiError(err, { identifier: 'login-identifier', password: 'login-password' });
    } finally {
      setButtonBusy(submitter, false);
    }
  },

  async register(form, submitter) {
    clearFieldErrors(form);
    const base = readForm({
      name: 'reg-name',
      email: 'reg-email',
      phone: 'reg-phone',
      password: 'reg-password',
      confirmPassword: 'reg-confirm',
      language: 'reg-language'
    });

    if (!base.name) return setFieldError('reg-name', t('validation.FIELD_REQUIRED'));
    if (!base.email && !base.phone) {
      setFieldError('reg-email', t('validation.CONTACT_REQUIRED'));
      return;
    }
    if (base.password !== base.confirmPassword) {
      return setFieldError('reg-confirm', t('validation.PASSWORD_MISMATCH'));
    }

    const profile = (() => {
      if (registerRole === 'Worker') {
        const w = readForm({
          trade: 'reg-trade', experienceYears: 'reg-exp', skills: 'reg-skills',
          languages: 'reg-languages', preferredCountries: 'reg-countries',
          currentLocation: 'reg-location', passportAvailable: 'reg-passport'
        });
        return {
          trade: w.trade,
          experienceYears: Number(w.experienceYears) || 0,
          skills: csvList(w.skills),
          languages: csvList(w.languages),
          preferredCountries: csvList(w.preferredCountries),
          currentLocation: w.currentLocation,
          passportAvailable: Boolean(w.passportAvailable)
        };
      }
      if (registerRole === 'Employer') {
        return readForm({
          companyName: 'reg-company', country: 'reg-country', city: 'reg-city',
          sector: 'reg-sector', contactPerson: 'reg-contact'
        });
      }
      return readForm({ agencyName: 'reg-agency', city: 'reg-city', registrationReference: 'reg-registration' });
    })();

    setButtonBusy(submitter, true, t('auth.creating'));
    try {
      const res = await api.post('/api/auth/register', { ...base, role: registerRole, profile });
      toast(t('auth.accountCreated', { name: res.user.name }), 'success');
      await afterLogin(res.user);
    } catch (err) {
      showApiError(err, {
        name: 'reg-name', email: 'reg-email', phone: 'reg-phone', password: 'reg-password'
      });
    } finally {
      setButtonBusy(submitter, false);
    }
  },

  async forgot(form, submitter) {
    clearFieldErrors(form);
    const { identifier } = readForm({ identifier: 'forgot-identifier' });
    if (!identifier) return setFieldError('forgot-identifier', t('validation.FIELD_REQUIRED'));
    setButtonBusy(submitter, true, t('common.submitting'));
    try {
      const res = await api.post('/api/auth/forgot-password', { identifier });
      // The server reports honestly that no delivery provider is wired up.
      await dialog({
        title: t('auth.forgotTitle'),
        body: `${res.message}\n\n${res.deliveryNote || ''}`,
        confirmLabel: t('common.close'),
        cancelLabel: t('common.close')
      });
    } catch (err) {
      showApiError(err);
    } finally {
      setButtonBusy(submitter, false);
    }
  },

  'home-search'() {
    state.jobFilters.search = (document.getElementById('home-search') || {}).value || '';
    state.jobFilters.page = 1;
    go('#/jobs');
  },

  'job-search'() {
    state.jobFilters.search = (document.getElementById('job-search') || {}).value || '';
    state.jobFilters.page = 1;
    render();
  },

  'admin-user-search'() {
    // Server-side search keeps the client from holding the whole user table.
    const term = (document.getElementById('admin-user-search') || {}).value || '';
    api.get('/api/admin/users', { search: term })
      .then(res => {
        const rows = res.data || [];
        toast(`${rows.length}`, 'info');
        const tbody = document.querySelector('.table tbody');
        if (!tbody) return;
        tbody.innerHTML = rows.map(user => `<tr>
          <td><strong>${esc(user.name)}</strong><br><span class="muted tiny">${esc(user.email || user.phone || '')}</span></td>
          <td>${esc(roleLabel(user.role))}</td>
          <td>${user.status === 'active' ? badge(user.status, 'b-green') : badge(user.status, 'b-red')}</td>
          <td>${['Employer', 'Consultancy'].includes(user.role) ? esc((user.profile && user.profile.verificationStatus) || 'unverified') : '—'}</td>
          <td class="row gap-6">
            ${user.status === 'active'
    ? `<button class="btn small danger" data-action="user-status" data-id="${attr(user.id)}" data-status="suspended">${esc(t('admin.suspend'))}</button>`
    : `<button class="btn small" data-action="user-status" data-id="${attr(user.id)}" data-status="active">${esc(t('admin.reactivate'))}</button>`}
          </td>
        </tr>`).join('');
      })
      .catch(showApiError);
  },

  async apply(form, submitter) {
    clearFieldErrors(form);
    const jobId = Number(form.dataset.job);
    const note = (document.getElementById('apply-note') || {}).value || '';
    setButtonBusy(submitter, true, t('common.submitting'));
    try {
      await api.post('/api/applications', { jobId, note });
      toast(t('worker.applied'), 'success');
      go('#/applications');
    } catch (err) {
      showApiError(err);
    } finally {
      setButtonBusy(submitter, false);
    }
  },

  async 'upload-document'(form, submitter) {
    clearFieldErrors(form);
    const name = (document.getElementById('doc-name') || {}).value.trim();
    const type = (document.getElementById('doc-type') || {}).value;
    const input = document.getElementById('doc-file');
    const file = input && input.files && input.files[0];

    if (!name) return setFieldError('doc-name', t('validation.FIELD_REQUIRED'));
    if (!file) return setFieldError('doc-file', t('validation.FILE_REQUIRED'));
    if (file.size > state.uploadMaxMb * 1024 * 1024) {
      return setFieldError('doc-file', t('validation.FILE_TOO_LARGE'));
    }

    const formData = new FormData();
    formData.append('name', name);
    formData.append('type', type);
    formData.append('file', file);

    setButtonBusy(submitter, true, t('worker.uploading'));
    try {
      await api.upload('/api/documents/upload', formData);
      toast(t('worker.uploaded'), 'success');
      render();
    } catch (err) {
      showApiError(err, { name: 'doc-name' });
    } finally {
      setButtonBusy(submitter, false);
    }
  },

  async 'create-job'(form, submitter) {
    clearFieldErrors(form);
    const values = readForm({
      title: 'job-title', company: 'job-company', category: 'job-category',
      country: 'job-country', city: 'job-city', salary: 'job-salary', inr: 'job-inr',
      exp: 'job-exp', hours: 'job-hours', vacancies: 'job-vacancies', visa: 'job-visa',
      description: 'job-description', requirements: 'job-requirements'
    });
    const benefits = Array.from(document.querySelectorAll('[id^="benefit-"]'))
      .filter(el => el.checked)
      .map(el => el.parentElement.textContent.trim());

    const status = (submitter && submitter.dataset.status) || 'published';

    setButtonBusy(submitter, true, t('employer.publishing'));
    try {
      const res = await api.post('/api/jobs', {
        ...values,
        vacancies: Number(values.vacancies),
        benefits,
        status
      });
      const host = document.getElementById('risk-result');
      if (host) host.innerHTML = riskPanel(res.risk, res.heldForReview);
      toast(res.heldForReview ? t('employer.heldForReview') : t('employer.published'),
        res.heldForReview ? 'warn' : 'success');
      if (!res.heldForReview) setTimeout(() => go('#/employer/jobs'), 1200);
    } catch (err) {
      showApiError(err, {
        title: 'job-title', company: 'job-company', city: 'job-city', salary: 'job-salary',
        description: 'job-description', requirements: 'job-requirements', vacancies: 'job-vacancies'
      });
    } finally {
      setButtonBusy(submitter, false);
    }
  },

  async 'update-stage'(form, submitter) {
    clearFieldErrors(form);
    const caseId = Number(form.dataset.case);
    const values = readForm({ stageName: 'stage-name', status: 'stage-status', note: 'stage-note' });
    setButtonBusy(submitter, true, t('common.saving'));
    try {
      await api.patch('/api/visa/stages', { caseId, ...values });
      toast(t('consultancy.milestoneSaved'), 'success');
      render();
    } catch (err) {
      showApiError(err);
    } finally {
      setButtonBusy(submitter, false);
    }
  },

  async 'save-profile'(form, submitter) {
    clearFieldErrors(form);
    const base = readForm({ name: 'p-name', email: 'p-email', phone: 'p-phone', language: 'p-language' });
    const profile = (() => {
      if (state.user.role === 'Worker') {
        const w = readForm({
          trade: 'p-trade', experienceYears: 'p-exp', skills: 'p-skills', languages: 'p-languages',
          preferredCountries: 'p-countries', currentLocation: 'p-location', passportAvailable: 'p-passport'
        });
        return {
          trade: w.trade,
          experienceYears: Number(w.experienceYears) || 0,
          skills: csvList(w.skills),
          languages: csvList(w.languages),
          preferredCountries: csvList(w.preferredCountries),
          currentLocation: w.currentLocation,
          passportAvailable: Boolean(w.passportAvailable)
        };
      }
      if (state.user.role === 'Employer') {
        return readForm({
          companyName: 'p-company', country: 'p-country', city: 'p-city',
          sector: 'p-sector', contactPerson: 'p-contact'
        });
      }
      if (state.user.role === 'Consultancy') {
        return readForm({ agencyName: 'p-agency', city: 'p-city', registrationReference: 'p-registration' });
      }
      return undefined;
    })();

    setButtonBusy(submitter, true, t('common.saving'));
    try {
      const payload = { ...base };
      if (profile) payload.profile = profile;
      const res = await api.patch('/api/auth/me', payload);
      state.user = res.user;
      if (res.user.language !== lang()) await setLanguage(res.user.language);
      toast(t('worker.profileSaved'), 'success');
      render();
    } catch (err) {
      showApiError(err, { name: 'p-name', email: 'p-email', phone: 'p-phone' });
    } finally {
      setButtonBusy(submitter, false);
    }
  },

  async 'change-password'(form, submitter) {
    clearFieldErrors(form);
    const values = readForm({ currentPassword: 'cp-current', newPassword: 'cp-new' });
    if (!values.currentPassword) return setFieldError('cp-current', t('validation.FIELD_REQUIRED'));
    if (!values.newPassword) return setFieldError('cp-new', t('validation.FIELD_REQUIRED'));
    setButtonBusy(submitter, true, t('common.saving'));
    try {
      await api.post('/api/auth/change-password', values);
      toast(t('auth.passwordChanged'), 'success');
      form.reset();
    } catch (err) {
      showApiError(err, { currentPassword: 'cp-current', newPassword: 'cp-new' });
    } finally {
      setButtonBusy(submitter, false);
    }
  },

  'assistant-send'(form) {
    const input = form.querySelector('[data-assistant-input]');
    if (!input || !input.value.trim()) return;
    const text = input.value.trim();
    input.value = '';
    sendAssistantMessage(text);
  }
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function wireEvents() {
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    // A <form data-action> is driven by the submit event, not by clicks.
    if (target.tagName === 'FORM') return;
    // A button's `type` property reports "submit" by default even outside a
    // form, so the check has to be "is this a submit control of a form that
    // already has its own submit handler?" - otherwise every plain
    // <button data-action="..."> would be skipped.
    const owningForm = target.closest('form[data-action]');
    if (owningForm && target.tagName === 'BUTTON' && target.getAttribute('type') !== 'button') return;

    const handler = actions[target.dataset.action];
    if (!handler) return;
    event.preventDefault();
    handler(target, event);
  });

  document.addEventListener('change', event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const handler = changeActions[target.dataset.action];
    if (!handler) return;
    handler(target, event);
  });

  document.addEventListener('submit', event => {
    const form = event.target.closest('form[data-action]');
    if (!form) return;
    const handler = submitActions[form.dataset.action];
    if (!handler) return;
    event.preventDefault();
    handler(form, event.submitter);
  });

  window.addEventListener('hashchange', render);

  onLanguageChange(() => {
    // Re-render so every string, including the assistant, picks up the switch.
    renderAssistant();
  });
}

async function boot() {
  try {
    await initI18n();
  } catch (err) {
    console.error('Could not load translations', err);
  }

  await refreshSession();
  if (state.user) {
    if (state.user.language && state.user.language !== lang()) {
      await setLanguage(state.user.language);
    }
    await loadMeta();
  } else {
    await loadMeta();
  }

  // Pick up the server's configured upload ceiling where it is exposed.
  try {
    const health = await fetch('/health').then(r => r.json());
    if (health && health.checks) state.booted = true;
  } catch (_) { /* health is informational here */ }

  wireEvents();

  if (!location.hash) {
    location.hash = state.user ? homeFor(state.user) : '#/landing';
  }
  await render();
}

boot();
