# Self-Hosted SMTP Node Readiness — Operator Guide

_Phase 22F · emails.cheap · plain-English._

## What is an SMTP node?
A "node" here is a **dedicated server (VPS) whose only job is to send your email**.
It runs its own mail software, has its own IP address, and its own reputation. We do
**not** install that software in this phase. This screen only tells you whether a node
you plan to build is **safe and ready** — like a pre-flight checklist before you ever
send a single message.

## Why not just use proxies?
A proxy hides where traffic comes from. Mailbox providers (Gmail, Outlook) decide whether
to trust you based on the **IP address and its history**. Rotating proxies / random IPs
look exactly like spammers and get blocked instantly. There is no reputation to build on a
borrowed IP. **A real sending setup needs one stable, dedicated IP you own and warm up** —
the opposite of a proxy. That is why this product has no proxy/rotation features and never
will.

## Why a dedicated IP matters
Reputation sticks to the IP. If you share an IP with other senders, their spam hurts you.
A dedicated IP means **your good behaviour is the only thing that counts** — and it can be
warmed up slowly so providers learn to trust it.

## Why the production server IP must NOT be used
This app (emails.cheap, IP `84.247.139.105`) runs your website, dashboard, and database.
If you send cold email from that same IP and get blacklisted, **your whole platform's
reputation is damaged** and unrelated services can break. The readiness checker therefore
**hard-blocks** any node whose IP equals the production IP. Cold outreach always goes from a
**separate** box.

## What is PTR / rDNS?
- **A record:** name → IP (e.g. `mail.example.com → 203.0.113.10`). "Forward DNS."
- **PTR (reverse DNS):** IP → name (e.g. `203.0.113.10 → mail.example.com`). "rDNS."

Receivers check that the IP points back to the hostname you send as. **No PTR, or a
mismatch, = instant spam folder.** PTR is set at your **VPS provider's panel**, not in your
domain's DNS zone.

## What are SPF / DKIM / DMARC?
- **SPF** (a TXT record on your domain): lists which IPs are allowed to send for the domain.
  e.g. `v=spf1 ip4:203.0.113.10 -all`.
- **DKIM** (a TXT record at `selector._domainkey.domain`): a cryptographic signature so
  receivers know the mail wasn't forged or altered.
- **DMARC** (a TXT record at `_dmarc.domain`): tells receivers what to do if SPF/DKIM fail,
  and where to send reports. `p=none` is fine while warming up; tighten later.

All three together are what make mail "authenticated." Missing any of them is a **critical
blocker**.

## Why abuse@ and postmaster@ matter
Mailbox providers and RFC 2142 expect every sending domain to have working `abuse@` and
`postmaster@` mailboxes. They're how providers and recipients reach you about problems.
Missing them looks unprofessional and hurts trust.

## Why bounce handling matters
Every send can bounce (bad address, full mailbox, rejection). If you keep mailing addresses
that bounce, your reputation tanks fast. You need a **bounce mailbox / return-path** so
bounces are captured and those addresses are suppressed automatically.

## Why warmup starts at 5/day
A brand-new IP has no trust. Blasting thousands of emails on day one is the #1 way to get
blacklisted. You start tiny (≈5/day), prove good behaviour (low bounces, no complaints),
and increase slowly over weeks. The readiness manager and the rest of the platform default
to these conservative limits and **never raise them automatically**.

## Why the system blocks sending by default
Safety-first. `safe_to_send` stays **false** until **every critical check passes**:
dedicated (non-production) IP, PTR pass, SPF, DKIM, DMARC, bounce handling, not blacklisted.
If anything is missing the node is `blocked` and no provider profile can be armed.

## What you must do before any live test
1. Get a **separate** VPS with a **dedicated IP** (never the production IP).
2. Ask the VPS provider to set **PTR/rDNS** for the IP → your mail hostname.
3. Publish **SPF, DKIM, DMARC** for the sending domain (use the generated DNS checklist).
4. Create **abuse@**, **postmaster@**, and a **bounce** mailbox.
5. Run manual **blacklist** checks (Spamhaus, Barracuda, MS SNDS, Google Postmaster) and
   record the results on the node.
6. Run the **readiness check** until score is high and level reaches `ready_for_tiny_test`.
7. Only then create a **draft provider profile** (it stays disabled, limits 5/day · 2/hour).
8. A human reviews everything, then a tiny first send is configured deliberately —
   **outside this phase**.

## How to use the screen (`/smtp-nodes`)
- **Add node** → fill name, hostname, IP, expected PTR, sending domain, optional DKIM
  selector, purpose, isolation.
- **Run readiness check** → see score, level, blockers, warnings, and the single next fix.
- **Manual blacklist / reputation** → record clean/listed per provider.
- **DNS checklist** → copy the records into your DNS provider + VPS panel. Nothing is changed
  automatically.
- **Export report** (Markdown/JSON) → share or archive.
- **Create draft provider profile** → only unlocks at `ready_for_tiny_test`; creates a
  disabled provider, no secrets, no sending.

> **No email is ever sent from this screen. No mail server is installed. No port is opened.
> No DNS is changed. The node cannot send until you resolve every critical blocker.**
