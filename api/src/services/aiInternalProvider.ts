// Internal (no external LLM) deterministic outreach generator.
// Produces structured GenerationResult by templating from website analysis + product profile.
//
// CRITICAL safety constraints (enforced by tests-of-intent):
//   - Never invent prior contact or partnerships.
//   - Never claim guaranteed results / fake testimonials.
//   - Use soft phrasing ("may help", "if relevant").
//   - Strip any forbidden claim phrases supplied in product profile.
//   - Surface relevance warnings explicitly when no clear pain point is detected.
//   - Confidence score drops if facts are sparse.

import { AiProvider, GenerationRequest, GenerationResult, Locale, Tone, registerProvider } from './aiAdapter.js';

const TEMPLATES: Record<Locale, Record<Tone, {
  subject: string[];
  short: string;
  long: string;
  followUp: string;
  greet: string;
  signoff: string;
  noticeOpening: string;        // soft opener "I saw your website..."
  relevanceLow: string;
}>> = {
  en: {
    neutral: {
      subject: [
        '{companyName}: quick note about {productName}',
        'Idea for {companyName}',
        '{productName} — possibly relevant for {companyName}',
      ],
      short:
        'Hi{maybeName},\n\n' +
        '{noticeOpening} {productName} may help {benefit}.\n\n' +
        'If relevant, I can send a short overview.\n\n' +
        '{signoff}',
      long:
        'Hi{maybeName},\n\n' +
        '{noticeOpening} Based on what I saw — {factsLine} — {productName} ({productUrl}) may be useful because: {benefitsBullets}\n\n' +
        '{description}\n\n' +
        'If this seems relevant for {companyName}, I can share a short demo or a few examples. No pressure either way.\n\n' +
        '{signoff}',
      followUp:
        'Hi{maybeName},\n\n' +
        'Just checking in on my previous note about {productName}. If it isn\'t relevant for {companyName}, no problem and please ignore this.\n\n' +
        '{signoff}',
      greet: 'Hi',
      signoff: 'Best regards,',
      noticeOpening: 'I came across your site and thought this might be worth a quick look —',
      relevanceLow: 'Low relevance signal detected. Consider not sending or rewriting manually.',
    },
    friendly: {
      subject: [
        'Hey {companyName} — quick idea',
        'Found your site — thought of {productName}',
        'Saw {companyName}, thinking {productName} might help',
      ],
      short:
        'Hey{maybeName}!\n\n' +
        '{noticeOpening} {productName} could maybe help with {benefit}.\n\n' +
        'Happy to share more if useful.\n\n' +
        '{signoff}',
      long:
        'Hey{maybeName}!\n\n' +
        '{noticeOpening} I noticed {factsLine}, so {productName} ({productUrl}) came to mind — it can help with: {benefitsBullets}\n\n' +
        '{description}\n\n' +
        'If this isn\'t a fit, no worries at all. Otherwise I can send a short walkthrough.\n\n' +
        '{signoff}',
      followUp:
        'Hey{maybeName}, just a quick bump on my last note about {productName}. Totally fine to skip if not relevant.\n\n{signoff}',
      greet: 'Hey',
      signoff: 'Cheers,',
      noticeOpening: 'I had a quick look at your website —',
      relevanceLow: 'Relevance to your offering is unclear. Best to rewrite manually before sending.',
    },
    professional: {
      subject: [
        'Brief introduction: {productName} for {companyName}',
        'Question about {companyName}\'s {industry} workflow',
        '{productName} — possible fit for {companyName}',
      ],
      short:
        'Dear team{maybeName},\n\n' +
        '{noticeOpening} {productName} may support {benefit}.\n\n' +
        'If this is potentially relevant, I would be glad to share more details.\n\n' +
        '{signoff}',
      long:
        'Dear team{maybeName},\n\n' +
        '{noticeOpening} Based on what is publicly visible — {factsLine} — {productName} ({productUrl}) may help in the following areas: {benefitsBullets}\n\n' +
        '{description}\n\n' +
        'If a short discussion or written overview would be useful, I am happy to provide either. If this is not relevant, please disregard this message.\n\n' +
        '{signoff}',
      followUp:
        'Dear team,\n\nThis is a brief follow-up to my previous message regarding {productName}. Please ignore if not relevant.\n\n{signoff}',
      greet: 'Dear team',
      signoff: 'Best regards,',
      noticeOpening: 'I reviewed your public website and would like to share a brief note.',
      relevanceLow: 'Relevance is uncertain. We recommend manual review and rewriting before sending.',
    },
    short_direct: {
      subject: [
        '{productName} for {companyName}?',
        'Quick: {productName}',
        '2-line note for {companyName}',
      ],
      short:
        '{greet}{maybeName} — {productName} may help with {benefit}. Worth 60 seconds? {signoff}',
      long:
        '{greet}{maybeName},\n\nQuick context: {factsLine}.\n{productName} ({productUrl}) — {benefitsBullets}\n\nWorth a short look? If not, ignore.\n\n{signoff}',
      followUp: '{greet}, bumping my note on {productName}. Ignore if not relevant. {signoff}',
      greet: 'Hi',
      signoff: '— Sent only after manual approval.',
      noticeOpening: 'Saw your site.',
      relevanceLow: 'Weak fit detected; rewrite or skip.',
    },
  },
  ru: {
    neutral: {
      subject: [
        '{companyName}: коротко про {productName}',
        'Идея для {companyName}',
        '{productName} — возможно, полезно для {companyName}',
      ],
      short:
        'Здравствуйте{maybeName},\n\n' +
        '{noticeOpening} {productName} может помочь с {benefit}.\n\n' +
        'Если интересно — могу прислать короткое описание.\n\n' +
        '{signoff}',
      long:
        'Здравствуйте{maybeName},\n\n' +
        '{noticeOpening} На основе того, что я увидел — {factsLine} — {productName} ({productUrl}) может быть полезен, потому что: {benefitsBullets}\n\n' +
        '{description}\n\n' +
        'Если это может быть актуально для {companyName}, могу прислать короткое демо или примеры. Без давления.\n\n' +
        '{signoff}',
      followUp:
        'Здравствуйте{maybeName},\n\nКороткое напоминание о моём прошлом сообщении про {productName}. Если не актуально — пожалуйста, проигнорируйте.\n\n{signoff}',
      greet: 'Здравствуйте',
      signoff: 'С уважением,',
      noticeOpening: 'Заметил ваш сайт и подумал, что это может быть полезно —',
      relevanceLow: 'Сигнал релевантности слабый. Рекомендуется не отправлять или переписать вручную.',
    },
    friendly: {
      subject: [
        'Привет, {companyName} — идея',
        'Заглянул на сайт — подумал про {productName}',
      ],
      short:
        'Привет{maybeName}!\n\n{noticeOpening} {productName} мог бы помочь с {benefit}.\n\nГотов рассказать подробнее, если интересно.\n\n{signoff}',
      long:
        'Привет{maybeName}!\n\n{noticeOpening} Заметил {factsLine}, поэтому подумал про {productName} ({productUrl}) — он может помочь с: {benefitsBullets}\n\n{description}\n\nЕсли не подходит — никаких проблем.\n\n{signoff}',
      followUp:
        'Привет{maybeName}, короткое напоминание про {productName}. Совершенно нормально пропустить, если не актуально.\n\n{signoff}',
      greet: 'Привет',
      signoff: 'С уважением,',
      noticeOpening: 'Быстро посмотрел ваш сайт —',
      relevanceLow: 'Релевантность неочевидна. Лучше переписать вручную перед отправкой.',
    },
    professional: {
      subject: [
        'Краткое представление: {productName} для {companyName}',
        '{productName} — возможный fit для {companyName}',
      ],
      short:
        'Здравствуйте{maybeName},\n\n{noticeOpening} {productName} может поддержать {benefit}.\n\nЕсли это потенциально актуально, буду рад прислать подробности.\n\n{signoff}',
      long:
        'Здравствуйте{maybeName},\n\n{noticeOpening} На основе публично доступной информации — {factsLine} — {productName} ({productUrl}) может помочь в следующих направлениях: {benefitsBullets}\n\n{description}\n\nЕсли краткое обсуждение или письменный обзор был бы полезен, буду рад предоставить. Если не актуально — пожалуйста, проигнорируйте это сообщение.\n\n{signoff}',
      followUp:
        'Здравствуйте,\n\nКраткое напоминание о моём предыдущем сообщении о {productName}. Пожалуйста, проигнорируйте, если не актуально.\n\n{signoff}',
      greet: 'Здравствуйте',
      signoff: 'С уважением,',
      noticeOpening: 'Я ознакомился с вашим публичным сайтом и хотел бы поделиться кратким сообщением.',
      relevanceLow: 'Релевантность неопределённая. Рекомендуется ручная проверка и переписывание перед отправкой.',
    },
    short_direct: {
      subject: [
        '{productName} для {companyName}?',
        'Коротко: {productName}',
      ],
      short:
        '{greet}{maybeName} — {productName} может помочь с {benefit}. Стоит 60 секунд? {signoff}',
      long:
        '{greet}{maybeName},\n\nКоротко: {factsLine}.\n{productName} ({productUrl}) — {benefitsBullets}\n\nСтоит короткого взгляда? Если нет — игнорируйте.\n\n{signoff}',
      followUp: '{greet}, напоминаю про {productName}. Игнорируйте, если не актуально. {signoff}',
      greet: 'Здравствуйте',
      signoff: '— Отправляется только после ручного одобрения.',
      noticeOpening: 'Видел ваш сайт.',
      relevanceLow: 'Слабая релевантность; переписать или пропустить.',
    },
  },
  uk: {
    neutral: {
      subject: [
        '{companyName}: коротко про {productName}',
        'Ідея для {companyName}',
        '{productName} — можливо, корисно для {companyName}',
      ],
      short:
        'Доброго дня{maybeName},\n\n{noticeOpening} {productName} може допомогти з {benefit}.\n\nЯкщо цікаво — можу надіслати короткий опис.\n\n{signoff}',
      long:
        'Доброго дня{maybeName},\n\n{noticeOpening} На основі побаченого — {factsLine} — {productName} ({productUrl}) може бути корисним, бо: {benefitsBullets}\n\n{description}\n\nЯкщо це може бути актуально для {companyName}, можу надіслати коротке демо або приклади. Без тиску.\n\n{signoff}',
      followUp:
        'Доброго дня{maybeName},\n\nКоротке нагадування про мій попередній лист щодо {productName}. Якщо не актуально — будь ласка, проігноруйте.\n\n{signoff}',
      greet: 'Доброго дня',
      signoff: 'З повагою,',
      noticeOpening: 'Помітив ваш сайт і подумав, що це може бути корисно —',
      relevanceLow: 'Сигнал релевантності слабкий. Рекомендується не надсилати або переписати вручну.',
    },
    friendly: {
      subject: ['Привіт, {companyName} — ідея', 'Заглянув на сайт — подумав про {productName}'],
      short:
        'Привіт{maybeName}!\n\n{noticeOpening} {productName} міг би допомогти з {benefit}.\n\nГотовий розповісти детальніше, якщо цікаво.\n\n{signoff}',
      long:
        'Привіт{maybeName}!\n\n{noticeOpening} Помітив {factsLine}, тому подумав про {productName} ({productUrl}) — він може допомогти з: {benefitsBullets}\n\n{description}\n\nЯкщо не підходить — жодних проблем.\n\n{signoff}',
      followUp:
        'Привіт{maybeName}, коротке нагадування про {productName}. Цілком нормально пропустити, якщо не актуально.\n\n{signoff}',
      greet: 'Привіт',
      signoff: 'З повагою,',
      noticeOpening: 'Швидко переглянув ваш сайт —',
      relevanceLow: 'Релевантність неочевидна. Краще переписати вручну перед надсиланням.',
    },
    professional: {
      subject: ['Коротке представлення: {productName} для {companyName}'],
      short:
        'Доброго дня{maybeName},\n\n{noticeOpening} {productName} може підтримати {benefit}.\n\nЯкщо це потенційно актуально, буду радий надіслати деталі.\n\n{signoff}',
      long:
        'Доброго дня{maybeName},\n\n{noticeOpening} На основі публічно доступної інформації — {factsLine} — {productName} ({productUrl}) може допомогти в таких напрямках: {benefitsBullets}\n\n{description}\n\nЯкщо коротке обговорення або письмовий огляд був би корисним, буду радий надати. Якщо не актуально — будь ласка, проігноруйте це повідомлення.\n\n{signoff}',
      followUp:
        'Доброго дня,\n\nКоротке нагадування про мій попередній лист щодо {productName}. Будь ласка, проігноруйте, якщо не актуально.\n\n{signoff}',
      greet: 'Доброго дня',
      signoff: 'З повагою,',
      noticeOpening: 'Я ознайомився з вашим публічним сайтом і хотів би поділитися коротким повідомленням.',
      relevanceLow: 'Релевантність невизначена. Рекомендується ручна перевірка та переписування перед надсиланням.',
    },
    short_direct: {
      subject: ['{productName} для {companyName}?', 'Коротко: {productName}'],
      short: '{greet}{maybeName} — {productName} може допомогти з {benefit}. Варто 60 секунд? {signoff}',
      long:
        '{greet}{maybeName},\n\nКоротко: {factsLine}.\n{productName} ({productUrl}) — {benefitsBullets}\n\nВарто короткого погляду? Якщо ні — ігноруйте.\n\n{signoff}',
      followUp: '{greet}, нагадую про {productName}. Ігноруйте, якщо не актуально. {signoff}',
      greet: 'Доброго дня',
      signoff: '— Надсилається лише після ручного схвалення.',
      noticeOpening: 'Бачив ваш сайт.',
      relevanceLow: 'Слабка релевантність; переписати або пропустити.',
    },
  },
};

function fill(s: string, vars: Record<string, string>): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

function pickFacts(facts: WebsiteFactsInternal): string[] {
  const out: string[] = [];
  if (facts.companyName)    out.push(`Company: ${facts.companyName}`);
  if (facts.industry)       out.push(`Industry: ${facts.industry}`);
  if (facts.businessType)   out.push(`Business type: ${facts.businessType}`);
  if (facts.offeringSummary) out.push(`Public offering: ${facts.offeringSummary}`);
  for (const p of facts.painPoints.slice(0, 3)) out.push(`Possible pain point: ${p}`);
  for (const t of facts.pageTitles.slice(0, 3)) out.push(`Page title: ${t}`);
  return out;
}

import type { WebsiteFacts as WebsiteFactsInternal } from './aiAdapter.js';

function detectRelevance(facts: WebsiteFactsInternal, product: any): { score: number; warnings: string[]; reason: string } {
  const warnings: string[] = [];
  let score = 0;

  if (facts.companyName)     score += 10;
  if (facts.industry)        score += 10;
  if (facts.businessType)    score += 10;
  if (facts.offeringSummary) score += 15;
  if (facts.painPoints.length)  score += 20;
  if (facts.pageTitles.length)  score += 5;
  if (facts.sourceUrls.length)  score += 5;

  // Cross-match: do product key benefits relate to detected pain points?
  const benefitText = (product.keyBenefits ?? []).join(' ').toLowerCase();
  const painText = facts.painPoints.join(' ').toLowerCase();
  const overlap = painText.split(/\W+/).filter((w: string) => w.length > 4 && benefitText.includes(w));
  if (overlap.length >= 2) score += 25;

  if (score < 40) warnings.push('Low fact density — manual review strongly recommended.');
  if (!facts.painPoints.length) warnings.push('No clear pain point detected. Avoid claiming "I noticed you have a problem with..."');
  if (!facts.companyName) warnings.push('Company name not detected; greeting will be generic.');

  const reason = facts.painPoints.length
    ? `Detected potential needs (${facts.painPoints.slice(0, 2).join('; ')}) which may align with the product's stated benefits.`
    : 'No explicit pain point detected; outreach should remain soft and informational.';

  return { score: Math.min(100, score), warnings, reason };
}

function stripForbiddenClaims(text: string, forbidden: string[]): string {
  let t = text;
  for (const claim of forbidden) {
    if (!claim) continue;
    const re = new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    t = t.replace(re, '[REDACTED — claim not allowed by product policy]');
  }
  // Hard-coded universal forbidden phrasing (no-deception baseline)
  const universalForbidden = [
    /guaranteed (\w+ )?(sales|revenue|results|growth)/gi,
    /as discussed (earlier|previously|in our last)/gi,
    /per our (previous|earlier|last) (conversation|call|meeting)/gi,
    /our (mutual|shared) (client|customer|partner)/gi,
    /\byou (definitely|certainly) need\b/gi,
  ];
  for (const re of universalForbidden) t = t.replace(re, '[REDACTED — universal safety rule]');
  return t;
}

export const internalProvider: AiProvider = {
  name: 'internal',
  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const tpl = TEMPLATES[req.language][req.tone];
    const f = req.facts;
    const p = req.product;
    const rel = detectRelevance(f, p);
    const facts = pickFacts(f);

    const benefit = p.keyBenefits[0] ?? p.description.slice(0, 80);
    const benefitsBullets = (p.keyBenefits.length ? p.keyBenefits : [p.description])
      .slice(0, 4)
      .map((b) => `• ${b}`)
      .join('\n');
    const factsLine = f.businessType
      ? `your site appears to ${f.offeringSummary ?? `cover ${f.businessType}`}`
      : `your site appears to focus on ${f.industry ?? 'a relevant area'}`;
    const maybeName = req.recipientHint?.roleHint ? '' : '';
    const description = p.description.slice(0, 400);

    const vars: Record<string, string> = {
      companyName: f.companyName ?? f.domain,
      productName: p.name,
      productUrl: p.productUrl ?? '',
      industry: f.industry ?? '',
      benefit,
      benefitsBullets,
      factsLine,
      description,
      maybeName,
      noticeOpening: tpl.noticeOpening,
      greet: tpl.greet,
      signoff: tpl.signoff,
    };

    const subjectOptions = tpl.subject.map((s) => fill(s, vars).trim()).filter(Boolean);
    let short = fill(tpl.short, vars);
    let long  = fill(tpl.long,  vars);
    let follow = fill(tpl.followUp, vars);

    short = stripForbiddenClaims(short, p.forbiddenClaims);
    long  = stripForbiddenClaims(long,  p.forbiddenClaims);
    follow = stripForbiddenClaims(follow, p.forbiddenClaims);

    const personalizationPoints = facts;
    const risks: string[] = [...rel.warnings];
    if (p.forbiddenClaims.length) risks.push(`${p.forbiddenClaims.length} forbidden-claim filter(s) active.`);

    return {
      generator: 'internal',
      subject_options: subjectOptions,
      email_short: short,
      email_long: long,
      follow_up: follow,
      personalization_points: personalizationPoints,
      risks_or_uncertainties: rel.score < 40 ? [tpl.relevanceLow, ...risks] : risks,
      confidence_score: rel.score,
      cited_facts: facts,
      ai_prompt_hash: null,
    };
  },
};

registerProvider(internalProvider);
