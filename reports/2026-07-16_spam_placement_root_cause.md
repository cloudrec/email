# Spam placement investigation — corrected report
2026-07-16, corrected same day after owner caught an IP-octet-order error in the first version

**Correction notice**: the first version of this report wrongly claimed the server IP had no PTR record. That check actually queried `105.139.247.84` — which is the *reversed-octet form* used internally in DNSBL query hostnames — as if it were the real IP itself. The real server IP is **84.247.139.105**. All findings below are re-verified against the correct IP.

I don't have access to the owner's Gmail inbox/spam folder, so I can't literally see where a message lands. Everything below is objective, independently verifiable technical signal.

## PTR / reverse DNS — CORRECT, confirmed
```
PTR  84.247.139.105 -> mail.emails.cheap.
A    mail.emails.cheap -> 84.247.139.105
```
Full forward-confirmed reverse DNS (FCrDNS) match. No issue here — the owner was right, my first report was wrong.

## HELO/EHLO — confirmed live, matches
Connected directly to the Postal SMTP server on port 25 and read the real banner:
```
220 mail.emails.cheap ESMTP Postal/SH0W0JYA
```
HELO/EHLO hostname matches the PTR exactly. Fully consistent chain: PTR ↔ A record ↔ live SMTP banner.

## Spamhaus (SBL / CSS / XBL / PBL) — NOT LISTED
Re-checked via 6 independent DNS resolvers after getting an inconsistent first result:
- **Clean (NXDOMAIN, trustworthy):** local resolver, Google 8.8.8.8, Level3 4.2.2.2 — 3 independent sources agree, not listed on any Spamhaus list.
- **Inconclusive (policy-block, not a real answer):** Cloudflare 1.1.1.1, Quad9 9.9.9.9 returned `127.255.255.254` (Spamhaus's documented "you're on a rate-limited public resolver" code, not a blocklist hit); OpenDNS returned `REFUSED` with an EDE "Censored" flag for the same reason. These three are well-known large public resolvers that Spamhaus deliberately blocks from free-tier zone lookups — their responses are not informative about the target IP at all.
- Spamhaus's own web checker (`check.spamhaus.org`) returned HTTP 403 to a non-browser fetch, so it couldn't be used directly to double-confirm — but the 3-resolver agreement is solid.

**Conclusion: 84.247.139.105 is not on Spamhaus SBL, CSS, XBL, or PBL.** The PBL finding in the first version of this report was wrong (same root cause as the PTR error — some checks in that pass may have been run against the wrong IP or hit a resolver-policy artifact that looked like a real PBL code).

## SORBS — technically listed, but the list itself appears dead
`84.247.139.105` does return a listed response (`188.214.128.77`) consistently across 4 independent resolvers (local, Google, Level3, Quad9) — this part is a real, reproducible DNS answer, not a fluke. However, `sorbs.net` and `www.sorbs.net` **don't resolve at all** — SORBS's own web infrastructure appears to be defunct. A blocklist whose own site is unreachable is very unlikely to be actively queried or trusted by any real-world mail filter (Gmail, Outlook, etc. don't rely on SORBS). Not treating this as a meaningful deliverability risk, but noting it for completeness — no action taken, no removal attempted, since there's no live SORBS service to submit a request to.

## Checked clean (unchanged from before): SpamCop, Barracuda.

## Revised conclusion
The infrastructure (PTR, HELO, SPF, DKIM, DMARC, IP reputation on the lists that matter) is actually in good shape. There is no evidence of a blacklist or reverse-DNS cause for poor deliverability. The most likely remaining explanations for the week's zero replies are:
1. The spintax rendering bug (fixed same day — see `project_email_spintax_fill_order_bug` memory), which shipped visibly broken text on 3 of 9 templates.
2. Genuine cold-email response-rate reality — brand-new domains with no prior sending history and no existing relationship to the recipient often see very low or zero reply rates in the first weeks even with clean infrastructure and good copy; this needs to be watched over a longer window, not just one week.
3. Possible inbox-vs-promotions-tab placement (Gmail's tab system, not spam) — worth the owner checking Promotions/Updates tabs too, not just Spam, when reviewing the test copies.

## Control delivery test sent
Sent `[CONTROL TEST] Deliverability check after PTR fix confirmation` to the owner's Gmail (confirmed `Sent` — real 250 OK from Google's MX, not held/bounced). Awaiting the owner to report where it landed (inbox / promotions / spam).

**Outlook control test not yet done** — no Outlook/Hotmail mailbox exists anywhere in this system that I can use as a check target. Need the owner to provide a real Outlook/Hotmail address, or confirm they want one created, before this leg can run.

## Update: owner confirmed real ground truth — 100% landed in spam
Owner checked their own Gmail and confirmed: the ACAP (#27) and Patent.rocks (#28) review copies, plus the `[CONTROL TEST]` message, all landed in spam. Since the infra checks above are genuinely clean, this points to Gmail's own reputation/content-based classifier rather than DNSBL/PTR.

**Found and fixed a real, concrete contributing bug**: the unsubscribe link in every message from `acap.network`, `patent.rocks`, `469diamond.com`, `treasurenetwork.space`, and `clients.help` pointed to `https://emails.cheap/u/m/...` — a completely different domain than the one actually sending. A From-domain/Unsubscribe-domain mismatch is a known spam-filter heuristic. Fixed: added an nginx proxy for `/u/m/` on all 5 branded domains (verified live, each now serves the real unsubscribe page) and changed `warmup_send_pilot.mjs`'s `unsub()` to build the link on the actual sending domain. See `project_email_unsub_domain_mismatch_fix` memory for full detail.

Also fixed in the same pass: a duplicated-signature bug (`sender_name` was built as brand-name + brand-name, e.g. "Best,\nACAP Network, ACAP Network" — looked templated/robotic).

Sent a third round of review copies (`[REVIEW v3 #...]`) with both fixes applied. Remaining open question: whether these two fixes are enough to clear Gmail's spam classification, or whether it's primarily new-domain reputation that just needs time/volume — can't know until the owner checks where `[REVIEW v3 #...]` lands.
