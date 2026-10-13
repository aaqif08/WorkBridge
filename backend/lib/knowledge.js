'use strict';

/**
 * Deterministic bilingual knowledge base for the WorkBridge assistant.
 *
 * This is the retrieval layer. It is used in two ways:
 *  1. as the complete answer when no AI provider is configured (the labelled
 *     fallback mode), and
 *  2. as grounding context handed to the model when one is, so replies stay
 *     anchored to vetted text instead of invented detail.
 *
 * Nothing here asserts that a specific employer, job or visa is verified.
 */

const ENTRIES = [
  {
    id: 'find-verified-job',
    keywords: [
      'verified job', 'find job', 'overseas job', 'genuine job', 'real job', 'job search',
      'வேலை', 'வெளிநாட்டில் வேலை', 'வேலை தேட', 'உண்மையான வேலை'
    ],
    en: {
      title: 'Finding a verified overseas job',
      body: [
        'Use Find Jobs in your worker dashboard and filter by destination country and trade. Each listing shows the employer, the stated salary, benefits, experience needed and whether visa sponsorship is included.',
        'Listings carry a platform risk indicator. A listing flagged for review is held back from the public list until a WorkBridge reviewer has looked at it.',
        'Before you accept anything: ask for the written offer letter, confirm the employer name against the licence number on the contract, and confirm the recruiting agency is registered with the Ministry of External Affairs eMigrate system.',
        'A genuine employer or a registered agency does not ask a worker for a placement fee, a deposit, or payment over a personal UPI or bank transfer.'
      ]
    },
    ta: {
      title: 'சரிபார்க்கப்பட்ட வெளிநாட்டு வேலையை கண்டுபிடிப்பது',
      body: [
        'உங்கள் டாஷ்போர்டில் "வேலை தேடு" பகுதியைப் பயன்படுத்தி, நாடு மற்றும் தொழில் வாரியாக வடிகட்டுங்கள். ஒவ்வொரு வேலை விளம்பரத்திலும் முதலாளி, சம்பளம், சலுகைகள், தேவையான அனுபவம், விசா ஆதரவு உள்ளதா என்ற விவரங்கள் காட்டப்படும்.',
        'ஒவ்வொரு விளம்பரத்திற்கும் ஒரு இடர் குறியீடு (risk indicator) உள்ளது. ஆய்வுக்கு குறிக்கப்பட்ட விளம்பரம், WorkBridge ஆய்வாளர் சரிபார்க்கும் வரை பொதுப் பட்டியலில் காட்டப்படாது.',
        'ஒப்புக்கொள்வதற்கு முன்: எழுத்து வடிவில் வேலை உத்தரவு (offer letter) கேளுங்கள்; ஒப்பந்தத்தில் உள்ள உரிம எண்ணுடன் முதலாளியின் பெயரை ஒப்பிடுங்கள்; முகவர் நிறுவனம் வெளியுறவு அமைச்சகத்தின் eMigrate அமைப்பில் பதிவு செய்யப்பட்டுள்ளதா என்பதை உறுதிப்படுத்துங்கள்.',
        'உண்மையான முதலாளி அல்லது பதிவு பெற்ற முகவர், தொழிலாளியிடம் வேலை வாங்கித் தரும் கட்டணம், முன்பணம் அல்லது தனிநபர் UPI/வங்கி கணக்குக்கு பணம் கேட்க மாட்டார்.'
      ]
    }
  },
  {
    id: 'documents-saudi',
    keywords: [
      'documents saudi', 'saudi arabia documents', 'papers for saudi', 'saudi work',
      'சவுதி', 'சவுதி ஆவணங்கள், சவுதி அரேபியா'
    ],
    en: {
      title: 'Documents commonly required for work in Saudi Arabia',
      body: [
        'Typically required: a passport with at least six months validity, the attested employment contract or offer letter, a GAMCA/Wafid medical fitness certificate from an approved centre, police clearance where the employer asks for it, trade or ITI certificates for skilled roles, and passport-size photographs to the embassy specification.',
        'The contract and educational or trade certificates usually need attestation before the visa is stamped. Your recruiting agency handles the attestation route.',
        'This is indicative. The exact document set depends on your trade, your employer and current embassy rules - confirm with your authorised recruitment agency and the Royal Embassy of Saudi Arabia before paying for anything.'
      ]
    },
    ta: {
      title: 'சவுதி அரேபியாவில் வேலை செய்ய பொதுவாக தேவைப்படும் ஆவணங்கள்',
      body: [
        'பொதுவாக தேவை: குறைந்தது ஆறு மாதம் செல்லுபடியாகும் பாஸ்போர்ட், சான்றளிக்கப்பட்ட வேலை ஒப்பந்தம் அல்லது offer letter, அனுமதி பெற்ற மையத்தில் எடுக்கப்பட்ட GAMCA/Wafid மருத்துவ தகுதி சான்றிதழ், முதலாளி கேட்கும்போது காவல்துறை சான்றிதழ், திறன் வேலைகளுக்கு ITI அல்லது தொழில் சான்றிதழ், தூதரக அளவுக்கான பாஸ்போர்ட் அளவு புகைப்படங்கள்.',
        'விசா முத்திரை பெறுவதற்கு முன் ஒப்பந்தம் மற்றும் கல்வி/தொழில் சான்றிதழ்களுக்கு attestation தேவைப்படும். இதை உங்கள் முகவர் நிறுவனம் கையாளும்.',
        'இவை பொதுவான தகவல்கள் மட்டுமே. உங்கள் தொழில், முதலாளி மற்றும் தற்போதைய தூதரக விதிகளைப் பொறுத்து ஆவணப் பட்டியல் மாறும் - பணம் செலுத்துவதற்கு முன் உங்கள் அதிகாரம் பெற்ற முகவர் நிறுவனம் மற்றும் சவுதி அரேபிய தூதரகத்தில் உறுதிப்படுத்துங்கள்.'
      ]
    }
  },
  {
    id: 'visa-process',
    keywords: [
      'visa process', 'visa stages', 'visa steps', 'how does visa work', 'milestones', 'stamping', 'embassy',
      'விசா', 'விசா நடைமுறை', 'விசா படிகள்', 'தூதரகம்'
    ],
    en: {
      title: 'The seven visa-processing milestones on WorkBridge',
      body: [
        'WorkBridge tracks overseas deployment in seven milestones: 1) Offer Letter, 2) Visa Applied, 3) Medical Test, 4) Embassy Submission, 5) Visa Stamping, 6) Travel Booking, 7) Departure.',
        'Only the recruitment consultancy assigned to your case, or a WorkBridge administrator, can move a milestone. Each change is stored with a timestamp and the name of the person who made it, and you can see that history on your Visa Tracking page.',
        'Timelines vary by destination, employer and embassy workload. Your assigned case officer is the correct person to ask for an estimated date; WorkBridge does not issue visas and cannot promise an outcome.'
      ]
    },
    ta: {
      title: 'WorkBridge-ல் ஏழு விசா நடைமுறை படிகள்',
      body: [
        'WorkBridge வெளிநாட்டு பணி நியமனத்தை ஏழு படிகளாகக் கண்காணிக்கிறது: 1) வேலை உத்தரவு, 2) விசா விண்ணப்பம், 3) மருத்துவ பரிசோதனை, 4) தூதரகத்தில் சமர்ப்பிப்பு, 5) விசா முத்திரை, 6) பயண டிக்கெட், 7) புறப்பாடு.',
        'உங்கள் வழக்குக்கு நியமிக்கப்பட்ட முகவர் நிறுவனம் அல்லது WorkBridge நிர்வாகி மட்டுமே ஒரு படியை மாற்ற முடியும். ஒவ்வொரு மாற்றமும் நேரம் மற்றும் மாற்றியவரின் பெயருடன் பதிவு செய்யப்படும்; அதை "விசா கண்காணிப்பு" பகுதியில் பார்க்கலாம்.',
        'கால அளவு நாடு, முதலாளி மற்றும் தூதரக பணிச்சுமையைப் பொறுத்து மாறும். தோராயமான தேதியை உங்கள் வழக்கு அதிகாரியிடம் கேளுங்கள்; WorkBridge விசா வழங்குவதில்லை, முடிவுக்கு உறுதி அளிக்க முடியாது.'
      ]
    }
  },
  {
    id: 'salary-expectations',
    keywords: [
      'salary', 'welder salary', 'how much', 'pay', 'wage', 'earn', 'inr', 'uae salary',
      'சம்பளம்', 'ஊதியம்', 'எவ்வளவு', 'வருமானம்'
    ],
    en: {
      title: 'Indicative trade salaries',
      body: [
        'The Salary Guide page in your dashboard shows indicative monthly ranges by trade and destination, drawn from the platform\'s reference table.',
        'As a rough guide for the Gulf, skilled trades such as welder, electrician or heavy driver commonly sit in the AED 1,500-3,500 band in the UAE, with comparable local-currency ranges in Qatar and Saudi Arabia. Many packages add employer-provided accommodation, transport and medical cover, which changes the real value of an offer.',
        'These are indicative ranges for comparison only, not an offer. The binding figure is the one written in your employment contract - check the currency, whether overtime is included, and what is deducted.'
      ]
    },
    ta: {
      title: 'தொழில் வாரியான சம்பள மதிப்பீடு',
      body: [
        'உங்கள் டாஷ்போர்டில் உள்ள "சம்பள வழிகாட்டி" பகுதியில், தொழில் மற்றும் நாடு வாரியாக மாத சம்பள வரம்புகள் காட்டப்படும்.',
        'வளைகுடா நாடுகளில் பொதுவாக, வெல்டர், எலக்ட்ரீசியன், கனரக ஓட்டுநர் போன்ற திறன் வேலைகள் UAE-ல் AED 1,500-3,500 வரம்பில் இருக்கும்; கத்தார், சவுதி அரேபியாவில் அதற்கு இணையான உள்ளூர் நாணய வரம்புகள் உள்ளன. பல ஒப்பந்தங்களில் தங்குமிடம், போக்குவரத்து, மருத்துவ காப்பீடு முதலாளியால் வழங்கப்படும் - இது ஒப்பந்தத்தின் உண்மையான மதிப்பை மாற்றும்.',
        'இவை ஒப்பிடுவதற்கான தோராயமான வரம்புகள் மட்டுமே, வேலை வாக்குறுதி அல்ல. உங்கள் வேலை ஒப்பந்தத்தில் எழுதப்பட்ட தொகையே இறுதியானது - நாணயம், கூடுதல் நேர ஊதியம், பிடித்தங்கள் ஆகியவற்றைச் சரிபார்க்கவும்.'
      ]
    }
  },
  {
    id: 'scam-warning-signs',
    keywords: [
      'scam', 'fraud', 'cheat', 'fake agent', 'identify scam', 'avoid fraud',
      'மோசடி', 'ஏமாற்று', 'போலி முகவர்', 'மோசடியை கண்டறிவது'
    ],
    en: {
      title: 'Recruitment scam warning signs',
      body: [
        'Treat these as red flags: a fee demanded from the worker; payment to a personal account or UPI ID; a salary far above the normal range for the trade; pressure to decide today; no written contract, or a contract you are not allowed to keep a copy of; a "visa" issued as a visit visa for work; and an agent who refuses to give a licence or registration number.',
        'Check the recruiting agency against the Ministry of External Affairs eMigrate registry before paying anything, and keep every receipt and message.',
        'If a WorkBridge listing looks wrong, report it from the listing page. Flagged listings go to a human reviewer. For money already lost, file a complaint with the local police and the Protector of Emigrants.'
      ]
    },
    ta: {
      title: 'வேலை மோசடியின் எச்சரிக்கை அறிகுறிகள்',
      body: [
        'இவை ஆபத்து அறிகுறிகள்: தொழிலாளியிடம் கட்டணம் கேட்பது; தனிநபர் கணக்கு அல்லது UPI-க்கு பணம் கேட்பது; தொழிலுக்கான சாதாரண வரம்பை விட மிக அதிக சம்பளம்; "இன்றே முடிவு செய்" என்ற அழுத்தம்; எழுத்து ஒப்பந்தம் இல்லாதது அல்லது நகல் தர மறுப்பது; வேலைக்கு visit விசா வழங்குவது; உரிமம்/பதிவு எண் தர மறுக்கும் முகவர்.',
        'பணம் செலுத்துவதற்கு முன், வெளியுறவு அமைச்சகத்தின் eMigrate பதிவேட்டில் முகவர் நிறுவனத்தைச் சரிபார்க்கவும். ஒவ்வொரு ரசீதையும் செய்தியையும் பத்திரமாக வைத்துக்கொள்ளுங்கள்.',
        'WorkBridge-ல் ஒரு விளம்பரம் சந்தேகமாக இருந்தால், அந்த பக்கத்திலிருந்தே புகார் அளிக்கவும். குறிக்கப்பட்ட விளம்பரங்கள் மனித ஆய்வாளருக்குச் செல்லும். ஏற்கனவே பணம் இழந்திருந்தால், உள்ளூர் காவல்துறை மற்றும் Protector of Emigrants-இல் புகார் அளிக்கவும்.'
      ]
    }
  },
  {
    id: 'track-application',
    keywords: [
      'track visa', 'track application', 'my status', 'where is my application', 'application status',
      'கண்காணி', 'என் விண்ணப்பம்', 'நிலை', 'எங்கே உள்ளது'
    ],
    en: {
      title: 'Tracking your application and visa',
      body: [
        'Applications are listed under Applications in your dashboard, each with its current stage and the date it last changed.',
        'Once an employer issues an offer and a consultancy takes the case, Visa Tracking shows your seven milestones with the date of each update and who recorded it.',
        'If a stage has not moved and you expected it to, message your assigned case officer from the Visa Tracking page rather than paying anyone to "speed it up".'
      ]
    },
    ta: {
      title: 'உங்கள் விண்ணப்பம் மற்றும் விசாவைக் கண்காணிப்பது',
      body: [
        'உங்கள் டாஷ்போர்டில் "விண்ணப்பங்கள்" பகுதியில் ஒவ்வொரு விண்ணப்பத்தின் தற்போதைய நிலையும், கடைசியாக மாறிய தேதியும் காட்டப்படும்.',
        'முதலாளி வேலை உத்தரவு வழங்கி, முகவர் நிறுவனம் வழக்கை ஏற்ற பிறகு, "விசா கண்காணிப்பு" பகுதியில் ஏழு படிகளும், ஒவ்வொரு மாற்றத்தின் தேதி மற்றும் பதிவு செய்தவர் பெயரும் காட்டப்படும்.',
        'ஒரு படி நீண்ட நாட்களாக மாறாமல் இருந்தால், "விசா கண்காணிப்பு" பக்கத்திலிருந்து உங்கள் வழக்கு அதிகாரிக்கு செய்தி அனுப்புங்கள் - "விரைவுபடுத்த" யாருக்கும் பணம் தர வேண்டாம்.'
      ]
    }
  },
  {
    id: 'using-workbridge',
    keywords: [
      'how to use', 'platform help', 'upload document', 'profile', 'workbridge help', 'register',
      'எப்படி பயன்படுத்த', 'உதவி', 'ஆவணம் பதிவேற்ற', 'சுயவிவரம்'
    ],
    en: {
      title: 'Using WorkBridge',
      body: [
        'Create a worker account, complete your profile (trade, years of experience, languages, preferred destinations) and upload your documents under Documents. A more complete profile matches more listings.',
        'Apply from any job page. You can apply to a listing once; the employer then moves your application through shortlisting, interview and offer.',
        'Your documents are visible to you and, once a consultancy is assigned to your case, to that consultancy. Medical records stay restricted to you and WorkBridge administrators. Employers never see your document files.'
      ]
    },
    ta: {
      title: 'WorkBridge-ஐ பயன்படுத்துவது',
      body: [
        'தொழிலாளர் கணக்கை உருவாக்கி, உங்கள் சுயவிவரத்தை (தொழில், அனுபவ ஆண்டுகள், மொழிகள், விரும்பும் நாடுகள்) நிரப்பி, "ஆவணங்கள்" பகுதியில் ஆவணங்களைப் பதிவேற்றுங்கள். முழுமையான சுயவிவரம் அதிக வேலைகளுடன் பொருந்தும்.',
        'எந்த வேலை பக்கத்திலிருந்தும் விண்ணப்பிக்கலாம். ஒரு விளம்பரத்திற்கு ஒரு முறை மட்டுமே விண்ணப்பிக்க முடியும்; பின்னர் முதலாளி உங்கள் விண்ணப்பத்தை shortlist, நேர்காணல், வேலை உத்தரவு என்ற படிகளில் நகர்த்துவார்.',
        'உங்கள் ஆவணங்கள் உங்களுக்கும், வழக்கு ஒப்படைக்கப்பட்ட முகவர் நிறுவனத்துக்கும் மட்டுமே தெரியும். மருத்துவ பதிவுகள் உங்களுக்கும் WorkBridge நிர்வாகிகளுக்கும் மட்டுமே. முதலாளிகள் உங்கள் ஆவண கோப்புகளைப் பார்க்க முடியாது.'
      ]
    }
  },
  {
    id: 'destination-countries',
    keywords: [
      'which country', 'destination', 'uae', 'qatar', 'kuwait', 'oman', 'gulf',
      'எந்த நாடு', 'நாடுகள்', 'வளைகுடா', 'துபாய்', 'கத்தார்'
    ],
    en: {
      title: 'Destinations on WorkBridge',
      body: [
        'Listings on the platform cover Gulf destinations - commonly the UAE, Qatar and Saudi Arabia - alongside local roles within India.',
        'Each destination has its own labour rules, medical requirements and attestation route, so the document set and the timeline differ even for the same trade.',
        'Use the country filter on Find Jobs to see what is live right now; the counts change as employers publish and close listings.'
      ]
    },
    ta: {
      title: 'WorkBridge-ல் உள்ள நாடுகள்',
      body: [
        'இந்த தளத்தில் வளைகுடா நாடுகள் - பொதுவாக UAE, கத்தார், சவுதி அரேபியா - மற்றும் இந்தியாவுக்குள்ளான உள்ளூர் வேலைகள் உள்ளன.',
        'ஒவ்வொரு நாட்டிற்கும் தனி தொழிலாளர் விதிகள், மருத்துவ தேவைகள், attestation நடைமுறைகள் உள்ளன. எனவே ஒரே தொழிலுக்கும் ஆவணங்களும் கால அளவும் மாறும்.',
        '"வேலை தேடு" பகுதியில் நாட்டு வடிகட்டியைப் பயன்படுத்தி தற்போது உள்ள வேலைகளைப் பாருங்கள்; முதலாளிகள் விளம்பரங்களை வெளியிடும்போது எண்ணிக்கை மாறும்.'
      ]
    }
  }
];

const SUGGESTED_QUESTIONS = {
  en: [
    'How can I find a verified overseas job?',
    'What documents are needed to work in Saudi Arabia?',
    'How does the visa-processing process work?',
    'What is the expected salary for a welder in the UAE?',
    'How can I identify a recruitment scam?',
    'How can I track my visa application?'
  ],
  ta: [
    'வெளிநாட்டில் வேலை பெறுவது எப்படி?',
    'சவுதி அரேபியாவில் வேலை செய்ய என்ன ஆவணங்கள் தேவை?',
    'விசா நடைமுறை எப்படி வேலை செய்கிறது?',
    'UAE-ல் வெல்டருக்கு எதிர்பார்க்கப்படும் சம்பளம் என்ன?',
    'வேலை மோசடியை எப்படி கண்டறிவது?',
    'என் விசா விண்ணப்பத்தை எப்படி கண்காணிப்பது?'
  ]
};

const TAMIL_RE = /[஀-௿]/;

/** Tamil script anywhere in the message is treated as a Tamil question. */
function detectLanguage(message, fallback = 'en') {
  return TAMIL_RE.test(String(message || '')) ? 'ta' : fallback;
}

/** Scores entries by keyword overlap and returns the best matches. */
function search(message, limit = 2) {
  const text = String(message || '').toLowerCase();
  if (!text.trim()) return [];
  const scored = ENTRIES.map(entry => {
    let score = 0;
    for (const keyword of entry.keywords) {
      const k = keyword.toLowerCase();
      if (!k) continue;
      if (text.includes(k)) {
        score += k.includes(' ') ? 3 : 2;
      }
    }
    // Token-level overlap catches mixed-language and reworded questions.
    const tokens = text.split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 3);
    for (const token of tokens) {
      if (entry.keywords.some(k => k.toLowerCase().includes(token))) score += 1;
    }
    return { entry, score };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(r => r.entry);
}

function render(entry, lang) {
  const content = entry[lang] || entry.en;
  return { id: entry.id, title: content.title, body: content.body };
}

function suggestions(lang) {
  return SUGGESTED_QUESTIONS[lang] || SUGGESTED_QUESTIONS.en;
}

module.exports = { ENTRIES, SUGGESTED_QUESTIONS, detectLanguage, search, render, suggestions };
