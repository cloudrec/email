# Real send/delivery/reply audit — last 7 days
2026-07-16

Pulled straight from Postal's own delivery log (`postal-server-1.messages`) and the reply-import table — not the app's own daily counters, which don't reflect final delivery outcome.

## Per-domain totals, last 7 days

| Domain | Sent (real 250 OK) | Held (never left Postal) | Hard bounced | Soft-fail | Total attempted |
|---|---|---|---|---|---|
| emails.cheap | 206 | 4 | 49 | 2 | 261 |
| clients.help | 105 | 29 | 16 | 7 | 157 |
| treasurenetwork.space | 66 | 8 | 7 | 0 | 81 |
| patent.rocks | 50 | 0 | 9 | 0 | 59 |
| clearorchard.online | 5 | 0 | 0 | 1 | 6 |
| **469diamond.com** | **0** | **5** | 0 | 0 | 5 |
| **acap.network** | **0** | **5** | 0 | 0 | 5 |

**~432 messages genuinely left the building this week. ~51 got stuck in Postal's `Held` queue and never sent at all.**

## The 469diamond.com / acap.network problem
100% of this week's attempts on both tracks are sitting in `Held` — literally zero delivered. Confirmed via Postal's message inspection (`spam_score=0`, `spam=false`, `threat=false` — not a spam-engine flag, something else is holding them, each with a 7-day auto-expiry). Root cause not yet found — same shared SMTP credential (id 1) is used by domains that deliver fine, so it's not simply "this credential is held." Also saw partial holding on specific `clients.help` mailboxes (`no-reply@clients.help`: 21/21 held this week, 100%; `hello@clients.help`: 8/32 held; `hi@`/`team@`/`widget@`: almost none held) — looks tied to the specific from-address, not the domain as a whole. **Needs further investigation before trusting these two tracks are sending anything at all.**

## Real reply signal, last 7 days
| Classification | Count |
|---|---|
| unsubscribe | 8 |
| auto_reply (out-of-office / ticket ack) | 5 |
| unknown | 10 |

Checked every "unknown" row by hand — all 10 are noise: my own MX test messages (4), auto-responder acknowledgments from support inboxes (3: hostinguk, opace, diamondshine), and unrelated newsletters (WayForPay, PostJobFree). **Zero genuine prospect inquiries or interest this week**, out of ~432 real deliveries. 8 unsubscribes is the only unambiguous human signal, and it's a negative one.

## Honest read
For the domains that are actually delivering (emails.cheap, clients.help, treasurenetwork.space, patent.rocks, clearorchard), mail is really leaving and mostly not bouncing — but is producing no measurable interest. That's either an inbox-placement problem (Postal reporting "250 OK accepted" only proves the receiving server took the message, not that it landed in the inbox rather than spam), a targeting/content problem, or both. For 469diamond.com/acap.network, the more basic problem is that nothing is being delivered at all.

## Suggested next steps (not yet started)
1. Find why messages are held (Postal-side setting, not spam score) — likely quick once found.
2. Check actual inbox placement (send a test to a real Gmail/Outlook test account and see where it lands) rather than trusting Postal's "Sent" status as a proxy for inbox delivery.
3. Consider whether copy/targeting on the tracks with zero interest needs rethinking.
