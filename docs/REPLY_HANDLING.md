# Reply Handling

How inbound replies are classified and escalated (TZ §11). A positive reply is **never**
auto-answered — it produces a draft for a human. Complaints and legal/privacy requests
are hard stops that suppress the sender globally.

## Classification

`api/src/services/replyClassifier.ts` — `classifyReply(subject, snippet, fromEmail)`
returns `{ classification, confidence, reason }`.

Classes: `interested`, `not_interested`, `do_not_contact`, `unsubscribe`, `wrong_person`,
`meeting_request`, `request_details`, `referral`, `complaint`, `legal_or_privacy`,
`not_now`, `unknown`.

## Escalation map

`REPLY_ESCALATION` in the same file maps a class to an action:

| Class | Action |
|-------|--------|
| `complaint` | `pause_campaign` |
| `legal_or_privacy` | `human_escalate` |
| `interested`, `meeting_request`, `request_details` | `draft_no_autosend` |
| `unknown` | `human_escalate` |

`draft_no_autosend` = generate a reply draft, never send automatically.

## Where actions run

`api/src/cli/importReplies.ts` fetches replies over IMAP, classifies them, and executes
the escalation:

- **Hard bounce** in the reply → `addSuppression(..., 'bounce_hard')` + global suppression
  row + queue rows marked `suppressed` / `do_not_contact`.
- **do_not_contact / unsubscribe** (confidence ≥ 0.9) → `addSuppression(..., 'unsubscribe')`
  + global suppression + `contact_points.status='do_not_contact'`.
- **complaint / legal_or_privacy** → global suppression (`complaint` uses reason
  `complaint`; legal maps to a human-review `manual` suppression, descriptive reason
  `legal_request` kept in the global row) + a loud `[ESCALATE]` log line for the operator,
  and the contact's queued items are set to `suppressed` / `do_not_contact`.

## Running the importer

```bash
cd /opt/email
docker compose exec api node dist/cli/importReplies.js
```

Watch for `[ESCALATE]` lines — they mark complaints and legal/privacy requests that a
person must review.

## Tests

`api/src/services/__tests__/replyClassifierExtended.test.ts` and `classifyReply*.test.ts`
cover the classes and the escalation map, including "positive interest still escalates to
a draft, never auto-send" (§21.17) and "legal/privacy is escalated" (§21.18). The
complaint→suppression action is covered by `engineInvariants.integration.test.ts`.
