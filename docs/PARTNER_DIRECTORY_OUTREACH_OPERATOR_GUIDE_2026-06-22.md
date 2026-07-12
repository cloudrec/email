# Partner Directory Outreach — Operator Guide (2026-06-22)

**Page:** `/partner-outreach` · **API mount:** `/partner-outreach` · Phase 22G

## Why this is NOT email blasting
This is a **non-email, manual outreach task channel**. It does **not** send email,
does **not** submit any web form automatically, and never bypasses login, captcha,
rate limits, or hidden/private APIs. The system only helps you *prepare* a short,
relevant partner message that **you** copy and paste into a directory's own Contact
form, in your own browser session, one company at a time.

Think of it as a checklist + clipboard + reply tracker — not a sender.

## The 5 tabs
1. **Today** — next action, how many tasks/submissions you've done today vs the limits.
2. **Sources** — the partner directories you outreach into (e.g. Intuit / ZiftOne).
3. **Targets** — companies you saved from a directory, plus the import box.
4. **Tasks** — one contact-form task per company: open form, copy message, mark submitted.
5. **Templates** — the partner-message pack (`<<< REPLACE: … >>>` fields you fill in).

## How to import directory companies
Automated browser discovery is **unavailable** (no headless browser is installed,
and the Intuit/ZiftOne directory is login/captcha-gated — we never bypass that).
Use **manual import** instead:

1. Open the directory in **your own logged-in browser**.
2. Copy the **visible** listing data only (company name, profile/website URL, category,
   country, whether a Contact button is shown). Do **not** collect hidden or private data.
3. In **Targets → Import**, paste either:
   - a **CSV** with a header row
     (`company_name,website_url,profile_url,category,country,contact_form_url`), or
   - one **profile/website URL** or **company name** per line.
4. Click **Preview (dry-run)** — nothing is saved yet.
5. Click **Confirm import** to save. Duplicates (same profile URL / website host / name)
   are skipped automatically. Max **200 rows** per import.

## How to create contact-form tasks
1. In **Targets**, tick the companies you want.
2. Pick a **Template** and fill the REPLACE fields (your name, website/project,
   directory name). Company name is filled in automatically.
3. Click **Create contact-form tasks**. One task = one company.
   - A task is **ready** when the message is complete and a contact URL exists.
   - A task is **pending_review** if the message still has unfilled `<<< REPLACE: … >>>`
     placeholders or no contact URL — fix it before sending.

## How to use a task (copy / open / manual submit)
For each task in the **Tasks** tab:
1. **Open form** — opens the directory Contact form in a new tab.
2. **Copy message** — copies the message to your clipboard (and logs a `copied` touch).
3. Paste it into the form, review it, and **submit it yourself**.
4. Click **Mark submitted manually** — records a `sent_manual` touch and counts toward
   your daily submission limit.

There is **no "submit all" button and no automatic submission**. Every form is sent
by you, by hand.

## Tracking replies
When a company responds, mark the outcome on the task:
- **Mark replied / Interested** — writes an inbound touch.
- **Not interested** — stops further follow-ups for that company.
- **Do not contact** — suppresses the company; it will never be queued again.
- **Skip** — drops this task without contacting.

## Suppression
**Do not contact** sets the target to `do_not_contact`, cancels any open tasks for it,
and blocks it from any future task creation. **Skip** and **blocked** targets are also
excluded from new tasks.

## Limits (safety)
- Max **5** contact-form submissions **per source per day**.
- Max **20** tasks created **per day**.
- No bulk submit, no hidden auto-submit, no captcha/login bypass.
- No duplicate company tasks (an open task already exists → blocked).
- No contact to `do_not_contact` / `skipped` / `blocked` targets.

## What not to do
- Don't bypass login, captcha, or rate limits.
- Don't scrape personal/hidden data — only visible, public directory fields.
- Don't submit duplicate or irrelevant messages.
- Don't use the directory as a mass-mail channel. Low-volume, relevant, honest only.
- Remember: **this directory may have its own terms.** Respect them.
