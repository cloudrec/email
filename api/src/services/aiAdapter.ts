// AI provider adapter for outreach text generation.
// Internal provider (built-in) produces structured drafts from website analysis
// + product profile WITHOUT any external LLM. Drop-in adapter for OpenAI/Anthropic
// can be registered via registerProvider().
//
// Output schema is the same regardless of provider so downstream code is identical.

export type Locale = 'en' | 'ru' | 'uk';
export type Tone = 'neutral' | 'friendly' | 'professional' | 'short_direct';

export interface WebsiteFacts {
  domain: string;
  companyName: string | null;
  industry: string | null;
  businessType: string | null;
  offeringSummary: string | null;
  painPoints: string[];
  pageTitles: string[];
  sourceUrls: string[];
  languageDetected: 'en' | 'ru' | 'uk' | 'other';
}

export interface ProductProfile {
  name: string;
  productUrl: string | null;
  description: string;
  targetCustomer: string | null;
  keyBenefits: string[];
  allowedClaims: string[];
  forbiddenClaims: string[];
  preferredTone: Tone;
  defaultLanguage: Locale;
}

export interface GenerationRequest {
  facts: WebsiteFacts;
  product: ProductProfile;
  language: Locale;
  tone: Tone;
  recipientHint?: { roleHint?: string | null; email?: string | null };
  // Bonus context the tenant can add (e.g. specific offer, discount, deadline).
  // No deceptive claims allowed. The internal provider does not embed promises.
  tenantNote?: string;
}

export interface GenerationResult {
  generator: string;
  subject_options: string[];
  email_short: string;
  email_long: string;
  follow_up: string | null;
  personalization_points: string[];
  risks_or_uncertainties: string[];
  confidence_score: number;        // 0-100
  cited_facts: string[];           // bullet list of which website facts were used
  ai_prompt_hash: string | null;   // for cache/audit; null for internal provider
}

export interface AiProvider {
  readonly name: string;
  generate(req: GenerationRequest): Promise<GenerationResult>;
}

const providers = new Map<string, AiProvider>();
export function registerProvider(p: AiProvider) { providers.set(p.name, p); }
export function getProvider(name = 'internal'): AiProvider {
  const p = providers.get(name);
  if (!p) throw new Error(`AI provider not registered: ${name}`);
  return p;
}
export function listProviders(): string[] { return [...providers.keys()]; }
