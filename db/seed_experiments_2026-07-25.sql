-- Three DRAFT experiments (TZ §20). Data only — no campaign is activated, no email is
-- sent. Each campaign is created with lifecycle_state='DRAFT'; there is no path from
-- DRAFT to RUNNING without the approval gates. Re-runnable: guarded by name.
--
-- ROLLBACK:
--   DELETE FROM campaign_experiments WHERE name LIKE 'EXP-%';
--   DELETE FROM campaigns WHERE name IN
--     ('EXP-A Website Audit (dental, UK)','EXP-B Clients.Help missed-enquiries (UK service)',
--      'EXP-C Affiliate B2B SaaS (draft, gated)');
--   DELETE FROM affiliate_offers WHERE offer_name='EXP-C placeholder B2B SaaS';

SET @tenant := 1;
SET @sender := (SELECT id FROM sender_identities WHERE from_email='hello@clients.help' LIMIT 1);

-- Experiment C needs an offer to point at. It is DRAFT with cold_email_allowed=0, so the
-- compliance gate BLOCKS any send — the experiment demonstrably cannot go live until a
-- real program's terms are verified and approved.
INSERT INTO affiliate_offers
  (tenant_id, network_name, advertiser_name, offer_name, status, cold_email_allowed,
   allowed_geos_json, required_disclosure, prohibited_claims_json, payout_type, terms_source)
SELECT @tenant, '(unset — pending real program)', '(unset)', 'EXP-C placeholder B2B SaaS',
       'DRAFT', 0, JSON_ARRAY('GB','US','IE'),
       'This message contains an affiliate link; I may earn a commission.',
       JSON_ARRAY('guaranteed income','risk free','get rich'),
       'CPA', '(no verified terms yet)'
WHERE NOT EXISTS (SELECT 1 FROM affiliate_offers WHERE offer_name='EXP-C placeholder B2B SaaS');

-- ── Experiment A — OWN_PRODUCT_B2B: Website Audit ────────────────────────────
INSERT INTO campaigns (tenant_id, uuid, campaign_mode, lifecycle_state, name, subject,
                       sender_identity_id, status, html_body, text_body, mode_owner, max_send_volume, engine_config_json)
SELECT @tenant, UUID(), 'OWN_PRODUCT_B2B', 'DRAFT',
  'EXP-A Website Audit (dental, UK)',
  'A few things I noticed on {{company}}''s website',
  @sender, 'draft', '', '', 'owner', 25,
  JSON_OBJECT(
    'product','Website audit + Clients.Help',
    'target_country','GB','target_industry','dental_clinic','company_size','1-20',
    'target_role','owner/practice manager',
    'problem','site issues quietly costing enquiries (no form, slow, poor CWV)',
    'evidence','per-site audit with real Core Web Vitals + screenshots',
    'offer','free short audit, full report linked, invitation to discuss fixes',
    'cta','reply to get the notes',
    'contact_source','company_websites (public), verified email, sendable MX, never contacted',
    'stop_conditions', JSON_OBJECT('hard_bounce_pct',8,'complaint_any',true,'unsub_spike_pct',5))
WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE name='EXP-A Website Audit (dental, UK)');

-- ── Experiment B — OWN_PRODUCT_B2B: Clients.Help ─────────────────────────────
INSERT INTO campaigns (tenant_id, uuid, campaign_mode, lifecycle_state, name, subject,
                       sender_identity_id, status, html_body, text_body, mode_owner, max_send_volume, engine_config_json)
SELECT @tenant, UUID(), 'OWN_PRODUCT_B2B', 'DRAFT',
  'EXP-B Clients.Help missed-enquiries (UK service)',
  '{{company}} — stop losing website enquiries',
  @sender, 'draft', '', '', 'owner', 25,
  JSON_OBJECT(
    'product','Clients.Help chat widget',
    'target_country','GB','target_industry','local_service (cleaning/plumbing/electrical)',
    'company_size','1-20','target_role','owner',
    'problem','no working contact form / visitors leave without messaging',
    'evidence','audit finding: "No working contact form detected" on this exact site',
    'offer','widget that captures missed enquiries + Telegram alerts',
    'cta','reply for a 60-second demo',
    'contact_source','same vetted pool; only sites whose audit shows a contact-channel gap',
    'stop_conditions', JSON_OBJECT('hard_bounce_pct',8,'complaint_any',true,'unsub_spike_pct',5))
WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE name='EXP-B Clients.Help missed-enquiries (UK service)');

-- ── Experiment C — AFFILIATE: B2B SaaS (draft, gated) ────────────────────────
INSERT INTO campaigns (tenant_id, uuid, campaign_mode, lifecycle_state, name, subject,
                       sender_identity_id, status, html_body, text_body, affiliate_offer_id, mode_owner, max_send_volume, engine_config_json)
SELECT @tenant, UUID(), 'AFFILIATE', 'DRAFT',
  'EXP-C Affiliate B2B SaaS (draft, gated)',
  '(subject pending approved offer)',
  @sender, 'draft', '', '',
  (SELECT id FROM affiliate_offers WHERE offer_name='EXP-C placeholder B2B SaaS' LIMIT 1),
  'owner', 25,
  JSON_OBJECT(
    'note','BLOCKED by the compliance gate: offer is DRAFT + cold_email_allowed=0.',
    'requirement','activate only after a real program whose written terms explicitly allow cold email is registered, terms verified, and approved',
    'category','legitimate B2B SaaS / dev tools / support software only',
    'disclosure_required',true,
    'stop_conditions', JSON_OBJECT('hard_bounce_pct',8,'complaint_any',true,'unsub_spike_pct',5,'offer_status_not_approved',true))
WHERE NOT EXISTS (SELECT 1 FROM campaigns WHERE name='EXP-C Affiliate B2B SaaS (draft, gated)');

-- experiment records
INSERT INTO campaign_experiments (campaign_id, name, hypothesis, status)
SELECT c.id, CONCAT('EXP-', SUBSTRING(c.name,5)),
  'Prove own-product B2B before scaling; compare net revenue/complaints/replies vs affiliate.',
  'DRAFT'
FROM campaigns c
WHERE c.name IN ('EXP-A Website Audit (dental, UK)','EXP-B Clients.Help missed-enquiries (UK service)','EXP-C Affiliate B2B SaaS (draft, gated)')
  AND NOT EXISTS (SELECT 1 FROM campaign_experiments e WHERE e.campaign_id=c.id);
