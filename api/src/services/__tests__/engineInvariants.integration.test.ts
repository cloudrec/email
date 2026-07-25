// TZ §21 integration invariants — the items whose real enforcement mechanism is the
// database itself (suppression gating, unsubscribe→global suppression, hard-bounce→
// suppression, idempotent conversion ingest / worker-restart-no-dup). These cannot be
// meaningfully unit-tested as pure functions: "duplicate is ignored" and "restart does
// not duplicate" ARE claims about the UNIQUE constraints and INSERT IGNORE semantics,
// so they are exercised against a live DB.
//
// This suite is SKIPPED unless RUN_DB_TESTS=1 and a reachable DB is configured, so the
// default host `vitest run` (fake DB creds) stays green. To run it:
//   docker run --rm --network email-platform_internal --env-file /opt/email/.env \
//     -e DB_HOST=db -e RUN_DB_TESTS=1 -v /opt/email/api:/app -w /app node:20 \
//     node_modules/.bin/vitest run src/services/__tests__/engineInvariants.integration.test.ts
// (see docs/CAMPAIGN_OPERATIONS.md / the test report for the canonical command.)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, pool } from '../../db.js';
import { addSuppression, isSuppressed, isSuppressedGlobal } from '../suppression.js';

const RUN = process.env.RUN_DB_TESTS === '1';
const d = RUN ? describe : describe.skip;

// Scratch data lives under the legacy tenant 1 with an unmistakable marker domain so
// cleanup is a single, safe wildcard delete that can never touch real contacts.
const TENANT = 1;
const MARK = '@engine-test.invalid';
const stamp = Date.now();
const email = (tag: string) => `qa-${tag}-${stamp}${MARK}`;

async function cleanup() {
  await query(`DELETE FROM suppressions WHERE tenant_id=? AND email LIKE ?`, [TENANT, `%${MARK}`]);
  await query(`DELETE FROM contacts WHERE tenant_id=? AND email LIKE ?`, [TENANT, `%${MARK}`]);
  await query(`DELETE FROM conversion_events WHERE idempotency_key LIKE ?`, [`enginetest-${stamp}-%`]);
  await query(`DELETE FROM click_events WHERE idempotency_key LIKE ?`, [`enginetest-${stamp}-%`]);
}

async function seedContact(addr: string) {
  await query(
    `INSERT INTO contacts (tenant_id, email, status) VALUES (?,?, 'subscribed')
       ON DUPLICATE KEY UPDATE status='subscribed', unsubscribed_at=NULL, bounced_at=NULL, complained_at=NULL`,
    [TENANT, addr],
  );
}

async function contactStatus(addr: string): Promise<string | null> {
  const rows = await query(`SELECT status FROM contacts WHERE tenant_id=? AND email=? LIMIT 1`, [TENANT, addr]);
  return rows[0]?.status ?? null;
}

d('TZ §21 engine invariants (DB integration)', () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  // §21.4 — unsubscribe creates a global suppression AND flips the contact status.
  it('unsubscribe creates a global suppression', async () => {
    const addr = email('unsub');
    await seedContact(addr);
    await addSuppression(TENANT, addr, 'unsubscribe');
    expect(await isSuppressed(TENANT, addr)).toBe(true);
    expect(await contactStatus(addr)).toBe('unsubscribed');
  });

  // §21.3 — a hard bounce creates a suppression and marks the contact bounced.
  it('hard bounce creates a suppression', async () => {
    const addr = email('bounce');
    await seedContact(addr);
    await addSuppression(TENANT, addr, 'bounce_hard');
    expect(await isSuppressed(TENANT, addr)).toBe(true);
    expect(await contactStatus(addr)).toBe('bounced');
  });

  // §21.5 (action) — a complaint suppresses the contact (the escalation action taken by
  // importReplies) and marks it complained.
  it('complaint suppresses the contact', async () => {
    const addr = email('complaint');
    await seedContact(addr);
    await addSuppression(TENANT, addr, 'complaint');
    expect(await isSuppressed(TENANT, addr)).toBe(true);
    expect(await contactStatus(addr)).toBe('complained');
  });

  // §21.1 & §21.2 — the guard both the queue-insert and the send-gate consult sees a
  // suppressed address as suppressed. isSuppressedGlobal is the exact predicate used at
  // routes/manualOutreach.ts enqueue and evaluateSendGate (re-exported there as
  // isEmailSuppressed).
  it('suppressed address is reported suppressed to the queue/send guard', async () => {
    const addr = email('guard');
    await addSuppression(TENANT, addr, 'manual');
    expect(await isSuppressedGlobal(TENANT, addr)).toBe(true);
    // A never-suppressed address is not blocked.
    expect(await isSuppressedGlobal(TENANT, `clean-${stamp}${MARK}`)).toBe(false);
  });

  // §21 — suppression insert is idempotent (INSERT IGNORE + UNIQUE): replaying it never
  // produces a duplicate row.
  it('repeated suppression of the same address stays a single row', async () => {
    const addr = email('idem');
    await addSuppression(TENANT, addr, 'unsubscribe');
    await addSuppression(TENANT, addr, 'unsubscribe');
    const rows = await query(`SELECT COUNT(*) AS n FROM suppressions WHERE tenant_id=? AND email=?`, [TENANT, addr]);
    expect(Number(rows[0].n)).toBe(1);
  });

  // §21.12 & §21.16 — duplicate conversion is ignored / a worker restart replaying the
  // same event does not duplicate: the UNIQUE(idempotency_key) makes the ingest a no-op
  // on replay. (Mirrors the INSERT IGNORE the postback route uses.)
  it('replaying a conversion with the same idempotency_key inserts one row', async () => {
    const key = `enginetest-${stamp}-conv1`;
    const ins = () =>
      query(
        `INSERT IGNORE INTO conversion_events (campaign_id, offer_id, contact_email, event_type, idempotency_key)
         VALUES (NULL, NULL, ?, 'sale', ?)`,
        [email('conv'), key],
      );
    await ins();
    await ins(); // simulated worker restart / postback retry
    const rows = await query(`SELECT COUNT(*) AS n FROM conversion_events WHERE idempotency_key=?`, [key]);
    expect(Number(rows[0].n)).toBe(1);
  });

  // §21.19 — tracking parameters map a conversion back to campaign / contact / offer.
  // The click and the conversion carry the same campaign_id/offer_id/contact_email/
  // click_id, so a conversion is attributable to the exact campaign, offer and contact
  // that produced the click (the mapping the postback route persists).
  it('conversion tracking params map to campaign, contact and offer', async () => {
    const campaignId = 970001;
    const offerId = 970002;
    const contact = email('attrib');
    const clickId = `ck-${stamp}`;
    const subId = `sub-${stamp}`;
    const clickKey = `enginetest-${stamp}-click19`;
    const convKey = `enginetest-${stamp}-conv19`;

    await query(
      `INSERT IGNORE INTO click_events (campaign_id, offer_id, contact_email, sub_id, click_id, idempotency_key)
       VALUES (?,?,?,?,?,?)`,
      [campaignId, offerId, contact, subId, clickId, clickKey],
    );
    await query(
      `INSERT IGNORE INTO conversion_events (campaign_id, offer_id, contact_email, event_type, sub_id, click_id, idempotency_key)
       VALUES (?,?,?, 'sale', ?,?,?)`,
      [campaignId, offerId, contact, subId, clickId, convKey],
    );

    // The stored conversion round-trips every tracking dimension.
    const [conv] = await query(
      `SELECT campaign_id, offer_id, contact_email, click_id, sub_id FROM conversion_events WHERE idempotency_key=?`,
      [convKey],
    );
    expect(Number(conv.campaign_id)).toBe(campaignId);
    expect(Number(conv.offer_id)).toBe(offerId);
    expect(conv.contact_email).toBe(contact);
    expect(conv.click_id).toBe(clickId);

    // And it joins back to its originating click on click_id, agreeing on campaign/offer/contact.
    const [joined] = await query(
      `SELECT cv.campaign_id, cv.offer_id, cv.contact_email
         FROM conversion_events cv
         JOIN click_events ck ON ck.click_id = cv.click_id
        WHERE cv.idempotency_key=? AND ck.idempotency_key=?
          AND ck.campaign_id = cv.campaign_id AND ck.offer_id = cv.offer_id
          AND ck.contact_email = cv.contact_email`,
      [convKey, clickKey],
    );
    expect(joined).toBeTruthy();
    expect(joined.contact_email).toBe(contact);
  });
});
