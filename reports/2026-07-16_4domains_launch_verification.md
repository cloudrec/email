# 4-domain mini-site launch — verification report
2026-07-16

## Scope
privatechannel.online, openfoundry.online, clearorchard.online, commonharbor.online.
pricejob.online and steadygrove.online untouched, as instructed (no page, no DNS beyond registration, no campaign).

## What was built
Static site per domain at `/opt/miniapps/<name>/` (index + privacy.html + unsubscribe.html), nginx vhost per domain, no backend, no fake companies/clients/testimonials. Content matches the exact positioning given for each domain:

- **privatechannel.online** — privacy-first E2EE messenger for journalists/lawyers/founders/NGOs/activists. No "unhackable"/"military-grade" language; explicit "what we don't say" section.
- **openfoundry.online** — custom software & AI automation studio, generic/durable positioning (not tied to one product).
- **clearorchard.online** — website audits / technical SEO, honest "no one can guarantee rankings" framing.
- **commonharbor.online** — missed-conversation recovery / lead-capture widget for WordPress/WooCommerce/e-commerce/service businesses.

## Verification results

| Check | privatechannel | openfoundry | clearorchard | commonharbor |
|---|---|---|---|---|
| HTTP (80) | 200 | 200 | 200 | 200 |
| HTTPS (443, Cloudflare Origin CA cert) | 200 | 200 | 200 | 200 |
| HTTPS on www. | 200 | 200 | 200 | 200 |
| /privacy.html | 200 | 200 | 200 | 200 |
| /unsubscribe.html | 200 | 200 | 200 | 200 |
| Footer links (privacy/unsubscribe/mailto) correct & self-consistent | ✅ | ✅ | ✅ | ✅ |
| MX record (10 mx.emails.cheap) | ✅ | ✅ | ✅ | ✅ |
| Postal domain + inbound Route (hello@ → andrii@emails.cheap) | ✅ | ✅ | ✅ | ✅ |
| Real test email delivered end-to-end into andrii@emails.cheap's monitored inbox | ✅ (inbox_replies id 80) | ✅ (id 82) | ✅ (id 83) | ✅ (id 81) |

**"Working contact" requirement is confirmed live for all 4 domains** — a real message sent to `hello@<domain>` reaches the monitored mailbox and is picked up by the existing reply-import worker.

One thing worth flagging, not a blocker: on 2 of the 4 test sends (privatechannel, clearorchard), Postal's first inbound delivery attempt hit a transient `530 Authentication required` softfail against an internal `_dc-mx.*.emails.cheap` hostname, then auto-retried ~6 minutes later and succeeded (`250 OK`) via the real destination MX. Net effect is a ~6-minute delay on some messages, not a failure — but if this keeps happening at scale it's worth a closer look at Postal's internal MX resolution for that hostname.

No emails have been sent to any outside recipient. No campaign has been started. This was internal test traffic only (from hello@emails.cheap to each new domain's own hello@ address).

## Proposed first pilot campaign

Recommending **clearorchard.online** (SEO audits) as the single first pilot, not all 4 at once:

- **Why this one first**: lowest deliverability/reputation risk for a domain with zero sending history — it's a standard, expected B2B pitch (free audit offer), easy to make genuinely non-generic (cite one real, verified issue per recipient), and backed by real infrastructure (seoseo.cheap) so the offer can actually be honored if someone replies. privatechannel carries the highest risk to pilot first (privacy-conscious recipients report cold email aggressively); openfoundry's offer is harder to personalize; commonharbor's niche already shows 2 competitors actively emailing the same inbox we monitor (hostinguk, mementor) — useful signal the niche responds to this pitch, but better as pilot #2 once clearorchard's domain reputation has some track record.
- **Recipients**: 20–30 max, small business / local e-commerce sites with one real, individually-verified technical SEO issue each (missing meta description, broken canonical, no sitemap, poor Core Web Vitals, etc.) — sourced the same way as existing tracks (OSM + lead pipeline), filtered against `global_contact_suppression`.
- **Personalization**: subject/opening line names the specific issue found on their site — not a template blast.
- **Pacing**: send in a trickle (5–8/day) rather than all at once, consistent with how the other warmup tracks are throttled — a brand-new domain shouldn't front-load volume even at "pilot" scale.
- **Gating**: per-domain complaint/bounce health check (already fixed earlier this session to be domain-scoped, not platform-wide) runs before each day's batch; any single complaint pauses that domain only.
- **Approval**: I will prepare the candidate list + per-recipient draft for review before anything sends — no auto-start, per your instruction.

Awaiting a decision on: (a) approve clearorchard as pilot #1, (b) pick a different domain, or (c) hold all sending for now and just leave the 4 pages live.
