'use strict';

/**
 * Controlled demo dataset.
 *
 * This runs ONLY when the runtime database does not exist yet AND
 * SEED_DEMO_DATA=true. It is development/test data: no real person, employer,
 * licence number or verification claim appears here, and every demo account
 * shares one password supplied by DEMO_PASSWORD (or a random one printed once
 * at first boot). A public deployment should run with SEED_DEMO_DATA=false and
 * provision its administrator from ADMIN_EMAIL / ADMIN_PASSWORD instead.
 */

const bcrypt = require('bcryptjs');
const config = require('../config');
const fraud = require('../lib/fraud');

const DEMO_JOBS = [
  {
    title: 'Heavy Driver',
    company: 'ABC Logistics (demo)',
    country: 'UAE',
    city: 'Dubai',
    salary: 'AED 1,800 – 2,200 / month',
    inr: '₹40,000 – ₹48,000 approx.',
    exp: '2+ years',
    benefits: ['Accommodation', 'Food', 'Transport'],
    category: 'Driver',
    vacancies: 12,
    visa: 'Yes',
    hours: '8–10 hours',
    description: 'Seeking skilled heavy truck and trailer drivers for intercity cargo logistics across UAE. Valid Gulf or Indian heavy driving license required.',
    requirements: 'Minimum 2 years commercial driving experience. Clean record. Valid heavy vehicle driving license. Passport ready.'
  },
  {
    title: 'Electrician',
    company: 'Gulf BuildWorks (demo)',
    country: 'Qatar',
    city: 'Doha',
    salary: 'QAR 1,600 – 2,000 / month',
    inr: '₹37,000 – ₹46,000 approx.',
    exp: '3+ years',
    benefits: ['Accommodation', 'Medical'],
    category: 'Electrician',
    vacancies: 8,
    visa: 'Yes',
    hours: '8 hours',
    description: 'Industrial electrician for an infrastructure project in Lusail. Responsible for cable tray installations, switchgear wiring, and electrical panel troubleshooting.',
    requirements: 'ITI or diploma in electrical engineering or certified electrician trade certificate. 3+ years experience.'
  },
  {
    title: 'Delivery Rider',
    company: 'Chennai Express (demo)',
    country: 'India',
    city: 'Chennai',
    salary: '₹22,000 – ₹28,000 / month',
    inr: '',
    exp: '1+ year',
    benefits: ['Fuel Allowance', 'Mobile Recharges'],
    category: 'Driver',
    vacancies: 25,
    visa: 'No',
    hours: '8 hours flexible',
    description: 'Delivery executive for local last-mile package delivery across Chennai city zones. Two-wheeler and valid license required.',
    requirements: 'Two-wheeler with valid registration and active two-wheeler driving license. Smartphone required.'
  },
  {
    title: 'Welder (MIG / TIG)',
    company: 'Riyadh Industrial Services (demo)',
    country: 'Saudi Arabia',
    city: 'Riyadh',
    salary: 'SAR 1,700 – 2,200 / month',
    inr: '₹38,000 – ₹49,000 approx.',
    exp: '2+ years',
    benefits: ['Accommodation', 'Transport', 'Overtime'],
    category: 'Welder',
    vacancies: 10,
    visa: 'Yes',
    hours: '8–10 hours',
    description: 'MIG and TIG structural welders for a petrochemical pipeline and steel fabrication facility. Shift rotation applies.',
    requirements: 'AWS or 6G welding certification preferred. Ability to read engineering drawings. Minimum 2 years workshop experience.'
  },
  {
    title: 'Chef / Cook (Continental & Indian)',
    company: 'Harbour Hospitality (demo)',
    country: 'UAE',
    city: 'Abu Dhabi',
    salary: 'AED 2,100 – 2,800 / month',
    inr: '₹47,000 – ₹63,000 approx.',
    exp: '3+ years',
    benefits: ['Food', 'Accommodation', 'Flight Tickets'],
    category: 'Chef',
    vacancies: 4,
    visa: 'Yes',
    hours: '9 hours',
    description: 'Line chef and hot kitchen cook for a busy beachfront dining club and catering business. Bulk and a la carte service.',
    requirements: '3+ years culinary kitchen experience. Food safety hygiene certificate. Good understanding of bulk and a la carte cooking.'
  },
  {
    title: 'Plumber & Pipefitter',
    company: 'Metro Facilities (demo)',
    country: 'India',
    city: 'Bengaluru',
    salary: '₹25,000 – ₹32,000 / month',
    inr: '',
    exp: '2+ years',
    benefits: ['Insurance', 'Annual Bonus'],
    category: 'Plumber',
    vacancies: 6,
    visa: 'No',
    hours: '8 hours',
    description: 'Maintenance plumber for commercial tech parks. Inspection of plumbing systems, pumps, valves, and water filtration units.',
    requirements: '2+ years commercial or residential plumbing experience. Knowledge of CPVC, UPVC, and drainage lines.'
  }
];

// A deliberately suspicious listing so the fraud queue and the risk explanation
// screens have something real to show on a fresh install.
const DEMO_RISKY_JOB = {
  title: 'Urgent Driver Required Dubai - Immediate Joining',
  company: 'Fast Gulf Agent (demo)',
  country: 'UAE',
  city: 'Dubai',
  salary: 'AED 12,000 / month',
  inr: '',
  exp: 'No experience needed',
  benefits: ['Accommodation'],
  category: 'Driver',
  vacancies: 400,
  visa: 'No',
  hours: '8 hours',
  description: 'Urgent requirement. Call us on WhatsApp +91 90000 00000. Registration fee applies for processing. Immediate joining, no interview.',
  requirements: ''
};

const SALARY_GUIDE = [
  { role: 'Heavy Driver', country: 'India (Chennai)', range: '₹15,000 – ₹20,000 / month', inr: '₹15,000 – ₹20,000', bar: 30 },
  { role: 'Heavy Driver', country: 'UAE (Dubai)', range: 'AED 1,800 – 2,200 / month', inr: '≈ ₹40,000 – ₹48,000', bar: 75 },
  { role: 'Heavy Driver', country: 'Qatar (Doha)', range: 'QAR 1,400 – 1,800 / month', inr: '≈ ₹32,000 – ₹41,000', bar: 62 },
  { role: 'Heavy Driver', country: 'Saudi Arabia (Riyadh)', range: 'SAR 1,500 – 2,000 / month', inr: '≈ ₹33,000 – ₹44,000', bar: 66 },
  { role: 'Electrician', country: 'India (Chennai)', range: '₹18,000 – ₹24,000 / month', inr: '₹18,000 – ₹24,000', bar: 34 },
  { role: 'Electrician', country: 'UAE (Dubai)', range: 'AED 1,900 – 2,600 / month', inr: '≈ ₹42,000 – ₹58,000', bar: 78 },
  { role: 'Electrician', country: 'Qatar (Doha)', range: 'QAR 1,600 – 2,000 / month', inr: '≈ ₹37,000 – ₹46,000', bar: 68 },
  { role: 'Welder', country: 'India (Chennai)', range: '₹17,000 – ₹23,000 / month', inr: '₹17,000 – ₹23,000', bar: 33 },
  { role: 'Welder', country: 'UAE (Dubai)', range: 'AED 1,900 – 2,800 / month', inr: '≈ ₹42,000 – ₹62,000', bar: 80 },
  { role: 'Welder', country: 'Saudi Arabia (Riyadh)', range: 'SAR 1,700 – 2,200 / month', inr: '≈ ₹38,000 – ₹49,000', bar: 70 }
];

function buildJob(id, input, employer, now) {
  const assessment = fraud.assess(input, { employer });
  return {
    id,
    employerId: employer.id,
    title: input.title,
    company: input.company,
    category: input.category,
    country: input.country,
    city: input.city,
    location: `${input.city}, ${input.country}`,
    salary: input.salary,
    inr: input.inr || '',
    exp: input.exp,
    hours: input.hours,
    visa: input.visa,
    vacancies: input.vacancies,
    benefits: input.benefits,
    description: input.description,
    requirements: input.requirements,
    type: String(input.country).toLowerCase() === 'india' ? 'Local' : 'Overseas',
    // `status` is the single source of truth for public visibility. A listing
    // that needs review is never published without a reviewer acting on it.
    status: assessment.requiresReview ? 'under_review' : 'published',
    risk: assessment,
    reviewState: assessment.requiresReview ? 'flagged' : 'clear',
    reviewedBy: null,
    reviewedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function seed(db) {
  const now = new Date().toISOString();
  const password = config.demoPassword || require('crypto').randomBytes(9).toString('base64url');
  const hash = bcrypt.hashSync(password, config.bcryptRounds);
  const nextIds = { users: 0, jobs: 0, applications: 0, visaCases: 0, documents: 0, messages: 0, consultancyAssignments: 0 };
  const id = key => (nextIds[key] += 1);

  const mkUser = (overrides) => ({
    id: id('users'),
    name: overrides.name,
    email: overrides.email,
    phone: overrides.phone || '',
    passwordHash: hash,
    role: overrides.role,
    status: 'active',
    language: overrides.language || 'en',
    profile: overrides.profile || {},
    demo: true,
    createdAt: now,
    updatedAt: now
  });

  const worker = mkUser({
    name: 'Karthik M (demo worker)',
    email: 'worker@demo.workbridge.local',
    phone: '+91 90000 10001',
    role: 'Worker',
    language: 'ta',
    profile: {
      trade: 'Driver',
      experienceYears: 5,
      skills: ['Heavy Vehicles', 'GPS Navigation', 'Load Safety'],
      languages: ['Tamil', 'Hindi', 'English'],
      preferredCountries: ['UAE', 'Qatar'],
      currentLocation: 'Chennai, India',
      passportAvailable: true
    }
  });

  const worker2 = mkUser({
    name: 'Arun P (demo worker)',
    email: 'worker2@demo.workbridge.local',
    phone: '+91 90000 10002',
    role: 'Worker',
    profile: {
      trade: 'Welder',
      experienceYears: 3,
      skills: ['MIG', 'TIG', 'Fabrication'],
      languages: ['Tamil', 'English'],
      preferredCountries: ['Saudi Arabia'],
      currentLocation: 'Madurai, India',
      passportAvailable: true
    }
  });

  const employer = mkUser({
    name: 'ABC Constructions (demo employer)',
    email: 'employer@demo.workbridge.local',
    phone: '+971 4 000 0001',
    role: 'Employer',
    profile: {
      companyName: 'ABC Constructions (demo)',
      country: 'UAE',
      city: 'Dubai',
      sector: 'Construction & Logistics',
      contactPerson: 'Demo HR',
      // Nothing is claimed as verified without evidence: demo employers start
      // unverified and an administrator must act to change that.
      verificationStatus: 'unverified'
    }
  });

  const consultancy = mkUser({
    name: 'Gulf Career Consultants (demo consultancy)',
    email: 'consultancy@demo.workbridge.local',
    phone: '+91 44 0000 0001',
    role: 'Consultancy',
    profile: {
      agencyName: 'Gulf Career Consultants (demo)',
      city: 'Chennai',
      verificationStatus: 'unverified',
      note: 'Demo record. Registration/licence numbers are not asserted.'
    }
  });

  const admin = mkUser({
    name: 'Demo Administrator',
    email: 'admin@demo.workbridge.local',
    phone: '+91 90000 90000',
    role: 'Admin',
    profile: { note: 'Demo administrator, created by SEED_DEMO_DATA only.' }
  });

  db.users.push(worker, worker2, employer, consultancy, admin);

  for (const input of DEMO_JOBS) {
    db.jobs.push(buildJob(id('jobs'), input, employer, now));
  }
  db.jobs.push(buildJob(id('jobs'), DEMO_RISKY_JOB, employer, now));

  const driverJob = db.jobs[0];
  const welderJob = db.jobs[3];

  const application = {
    id: id('applications'),
    jobId: driverJob.id,
    jobTitle: driverJob.title,
    employerId: employer.id,
    workerId: worker.id,
    company: driverJob.company,
    location: driverJob.location,
    status: 'Visa Processing',
    note: '',
    createdAt: now,
    updatedAt: now,
    history: [
      { stage: 'Applied', at: now, byId: worker.id, byName: worker.name },
      { stage: 'Shortlisted', at: now, byId: employer.id, byName: employer.name },
      { stage: 'Offer Issued', at: now, byId: employer.id, byName: employer.name },
      { stage: 'Visa Processing', at: now, byId: consultancy.id, byName: consultancy.name }
    ]
  };

  const application2 = {
    id: id('applications'),
    jobId: welderJob.id,
    jobTitle: welderJob.title,
    employerId: employer.id,
    workerId: worker2.id,
    company: welderJob.company,
    location: welderJob.location,
    status: 'Applied',
    note: '',
    createdAt: now,
    updatedAt: now,
    history: [{ stage: 'Applied', at: now, byId: worker2.id, byName: worker2.name }]
  };

  db.applications.push(application, application2);

  const stageNames = [
    'Offer Letter',
    'Visa Applied',
    'Medical Test',
    'Embassy Submission',
    'Visa Stamping',
    'Travel Booking',
    'Departure'
  ];
  const doneCount = 4;
  const stages = stageNames.map((name, index) => ({
    name,
    status: index < doneCount ? 'done' : index === doneCount ? 'current' : 'pending',
    updatedAt: index <= doneCount ? now : null,
    updatedById: index <= doneCount ? consultancy.id : null,
    updatedByName: index <= doneCount ? consultancy.name : null,
    note: ''
  }));

  db.visaCases.push({
    id: id('visaCases'),
    workerId: worker.id,
    applicationId: application.id,
    employerId: employer.id,
    consultancyId: consultancy.id,
    destination: 'UAE',
    role: driverJob.title,
    caseOfficer: 'Demo Case Officer',
    stages,
    progress: Math.round((doneCount / stageNames.length) * 100),
    estimatedCompletion: null,
    createdAt: now,
    updatedAt: now
  });

  db.consultancyAssignments.push({
    id: id('consultancyAssignments'),
    consultancyId: consultancy.id,
    workerId: worker.id,
    employerId: employer.id,
    applicationId: application.id,
    status: 'active',
    createdAt: now
  });

  const docs = [
    { name: 'Passport', type: 'passport', status: 'Verified', sensitive: false },
    { name: 'Driving License', type: 'licence', status: 'Verified', sensitive: false },
    { name: 'Experience Certificate', type: 'experience', status: 'Pending Review', sensitive: false },
    { name: 'Medical Fitness Report', type: 'medical', status: 'Pending Review', sensitive: true }
  ];
  for (const doc of docs) {
    db.documents.push({
      id: id('documents'),
      ownerId: worker.id,
      name: doc.name,
      type: doc.type,
      status: doc.status,
      sensitive: doc.sensitive,
      storedName: null,
      originalName: null,
      mimeType: null,
      sizeBytes: 0,
      placeholder: true,
      verifiedById: null,
      verifiedByName: null,
      verifiedAt: null,
      rejectionReason: '',
      createdAt: now,
      updatedAt: now
    });
  }

  db.messages.push(
    {
      id: id('messages'),
      fromId: consultancy.id,
      fromName: consultancy.name,
      toId: worker.id,
      subject: 'Embassy submission complete',
      body: 'Your embassy submission is complete. We will update the stamping milestone once the embassy responds.',
      readAt: null,
      createdAt: now
    },
    {
      id: id('messages'),
      fromId: employer.id,
      fromName: employer.name,
      toId: worker.id,
      subject: 'Contract draft',
      body: 'The contract draft for the heavy driver role is prepared. Please review the salary and benefit section.',
      readAt: null,
      createdAt: now
    }
  );

  db.salaryGuide = SALARY_GUIDE.slice();

  db.meta.counters = { ...nextIds };
  db.meta.demoSeeded = true;
  db.meta.demoPasswordProvided = Boolean(config.demoPassword);

  return { demoPassword: password, generated: !config.demoPassword };
}

module.exports = { seed, DEMO_JOBS, SALARY_GUIDE };
