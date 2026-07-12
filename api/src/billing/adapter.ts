// Billing provider adapter contract.
// Providers MUST implement this interface. v1 ships with manual provider.

export interface CheckoutRequest {
  tenantId: number;
  planCode: string;
  currency: string;
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, string>;
}

export interface CheckoutResult {
  provider: string;
  redirectUrl?: string;
  instructions?: string;
  providerReference?: string;
}

export interface WebhookEvent {
  provider: string;
  type: string;
  rawBody: string;
  signature?: string;
  parsed: Record<string, any>;
}

export interface InvoiceMark {
  invoiceId: number;
  providerReference?: string;
  amountCents: number;
  currency: string;
  actorUserId: number | null;
  notes?: string;
}

export interface BillingProvider {
  readonly name: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  // Process inbound webhook into normalized invoice/subscription updates.
  handleWebhook(event: WebhookEvent): Promise<void>;
  // Admin override: mark an invoice paid (manual confirmation flow).
  markInvoicePaid(req: InvoiceMark): Promise<void>;
}

const providers = new Map<string, BillingProvider>();

export function registerProvider(p: BillingProvider) {
  providers.set(p.name, p);
}

export function getProvider(name: string): BillingProvider {
  const p = providers.get(name);
  if (!p) throw new Error(`Billing provider not registered: ${name}`);
  return p;
}

export function listProviders(): string[] {
  return [...providers.keys()];
}
