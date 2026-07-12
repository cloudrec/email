# Email Platform

Self-hosted multi-tenant email marketing & marketing automation SaaS.

- **Path:** `/opt/email`
- **Primary domain:** `email.clients.help`
- **Stack:** Nginx + Next.js portal + Node API + worker + MariaDB + Redis + Postal (SMTP)
- **i18n:** EN / RU / UA
- **Spec:** `email_platform_sonnet_spec_en_v2_email_clients_help.docx`

## Quick start

```bash
cd /opt/email
cp .env.example .env          # edit secrets
make build
make up
make migrate
make seed
make health
```

Then open `https://email.clients.help`.

## Documentation

| File | Purpose |
|---|---|
| `docs/SONNET_AUDIT.md` | Phase 0 audit + risk register |
| `docs/DEPLOYMENT.md` | Install/upgrade procedure |
| `docs/RUNBOOK.md` | Incident & operations playbook |
| `docs/DNS_GUIDE.md` | SPF/DKIM/DMARC/tracking CNAME setup for tenants |
| `docs/API.md` | REST API reference |

## Layout

```
/opt/email/
├── docker-compose.yml
├── .env.example          # never commit .env
├── Makefile
├── nginx/                # reverse proxy vhosts
├── portal/               # Next.js customer + admin UI
├── api/                  # REST API
├── workers/              # queue consumers (send, verify, bounce)
├── db/migrations/        # SQL schema
├── scripts/              # setup/health/backup/restore/create-tenant
├── docs/
├── backups/              # encrypted dumps (gitignored)
└── logs/                 # rotated logs (gitignored)
```

## Operating rules

See `docs/SONNET_AUDIT.md` §3. Short version:

- Routine edits, builds, restarts of `/opt/email` containers: autonomous.
- Destructive: deleting prod data, wiping volumes, registrar DNS, force-push, bulk email send → confirm first.
- Secrets stay out of git, docs, logs, screenshots.
