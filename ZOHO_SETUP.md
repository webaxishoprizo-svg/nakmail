# Zoho + Google admin setup (nakmedia.co)

## 1. Google login (admin: nakmediaco@gmail.com)
Google Cloud Console -> APIs & Services -> Credentials -> OAuth client ID (Web application).
Authorized redirect URI: `https://<your-worker-domain>/auth/google/callback`
(for local dev also add `http://localhost:5173/auth/google/callback`)

## 2. Zoho API client (India data center)
https://api-console.zoho.in -> Add Client -> **Server-based Applications**.
Authorized redirect URI: `https://<your-worker-domain>/auth/zoho/callback`
Scopes used: ZohoMail.accounts.READ, ZohoMail.folders.READ, ZohoMail.messages.ALL

## 3. Secrets
npx wrangler secret put SESSION_SECRET        # any long random string
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ZOHO_CLIENT_ID
npx wrangler secret put ZOHO_CLIENT_SECRET

## 4. Deploy
npm run deploy

## 5. First login
Open the site -> Google login as nakmediaco@gmail.com -> you are redirected to Zoho
-> sign in as connect@nakmedia.co and approve. Mail then syncs every 2 minutes
(or POST /api/v1/zoho/sync). If you sign in to Zoho with a different account it is rejected.

## 6. Alias users (admin: Settings -> Alias access)
1. Create the alias in Zoho (Mail Admin -> Users -> your mailbox -> Email Aliases) and make sure it
   is allowed as a "send as" address.
2. Open any mailbox -> Settings -> **Alias access**. Enter the alias and the person's Google account -> Assign.
3. That person signs in with Google and sees ONLY that alias's mailbox: mail where the alias is in
   To/Cc (received) or the From address (sent). They cannot open the main mailbox or other aliases,
   and cannot see Settings -> Alias access.
4. Remove access with the trash icon. It takes effect immediately.

Notes
- One alias can have several Google accounts; one Google account can have several aliases.
- Each alias has its own mailbox. Reading/starring/deleting there does not affect the main mailbox.
- Matching uses the To/Cc/From headers. Mail delivered to an alias only via Bcc or a mailing list
  (header does not contain the alias) appears in the main mailbox but not in the alias mailbox.
- When an alias is assigned, existing matching mail already synced into the main mailbox is copied over.
- Sending: a user sends as their alias. If Zoho rejects the alias as a sender, the UI now shows the error.

Tests: `npm test` (access control, login flow, alias routing).

## 7. Two admins (nakmediaco@gmail.com + nexusqteam@gmail.com)
`wrangler.jsonc` -> `vars.ADMINS` pairs each admin's Google login with their OWN Zoho user mailbox:
- nakmediaco@gmail.com  <->  connect@nakmedia.co   (FIRST = primary: aliases belong to this Zoho account)
- nexusqteam@gmail.com  <->  admin@nakmedia.co     (a separate Zoho user, not an alias)

Both admins can: read/send from their own mailbox, send FROM ANY ALIAS (pick it in the From box),
assign Google accounts to aliases (Settings -> Alias access), and open alias mailboxes.

First login of the second admin: Google login as nexusqteam@gmail.com -> redirected to Zoho ->
sign in as **admin@nakmedia.co**. Any other Zoho account is rejected. (If your browser is already
signed in to Zoho as connect@, use a private window or switch account on the Zoho screen.)

Rules
- Each admin's Zoho mailbox syncs into their own mailbox. Personal mailboxes are PRIVATE by default:
  nexusqteam can't open connect@ and vice versa. To let admins open each other's mailbox set
  `"ADMINS_SHARE_MAILBOXES": "true"`.
- Alias mail is read through the primary account (connect@), so the primary admin must have connected
  Zoho once for alias mailboxes to fill. Sending from an alias always goes through the primary account.
- Sending from admin@ uses admin@'s own Zoho account.
- Admin addresses cannot be assigned as aliases, and an admin's personal address is never offered as
  a From option to the other admin.
- Replying in a mailbox defaults From to the alias the mail was sent to (if you may send as it).

## 8. Hot / Warm leads
Sidebar -> **Hot** and **Warm** (with counts) under Inbox. Every thread gets a 0-100 score
(Hot 70+, Warm 40-69) from: they replied to you, back-and-forth depth, how recently they wrote,
buying / scheduling words, support requests, waiting for your reply, starred, regular customer
(list below) or regular contact (replied in 2+ threads over 30+ days), keeps in touch (3+ threads in
90 days). Newsletters, no-reply senders, auto-replies and old threads score low. Hover the Hot/Warm
chip on a row to see why. Weights live in `workers/lib/scoring.ts`.
Optional customer list: `PUT /api/v1/admin/customers {"emails":[...],"domains":["bigco.com"]}`
(a spreadsheet import will fill this later).

## 9. iRIS assistant
- Header robot button -> iRIS chat. Ask "how many emails did we send today?" (answers come from real
  counts, in `TIMEZONE`, default Asia/Kolkata) or ask it to write an email.
- Compose -> **Write with iRIS**: describe the email, preview the draft, "Use this draft".
- iRIS only writes text. It cannot send mail or change anything.
- Model: iRIS can use Workers AI, an OpenAI-compatible chat completions API, or the Flowlith chat API
  (`IRIS_API_FORMAT=iris-chat`, `{message, history}` -> `{reply}`). The supplied Flowlith endpoint is
  online, but its current agent answers as Flowlith and does not follow NAK Mail's mailbox context.
  A live check with a synthetic sent-mail count returned an unrelated Flowlith answer, so keep this
  endpoint disabled until its backend prompt is configured for NAK Mail. To enable it afterward, set
  `IRIS_API_URL=https://iris-ai.nakserver.workers.dev` and `IRIS_API_FORMAT=iris-chat` in Wrangler vars.
  Set `IRIS_API_KEY` only if the backend requires one. If `IRIS_API_URL` is unset, the app uses
  Workers AI on your Cloudflare account.

## 10. Cold-mail automation engine (Sidebar -> Automation, admins only)
Deploy note: this adds a new Durable Object (`AutomationDO`, migration v4) and a second cron (every minute).
`npm run deploy` applies both. Nothing is sent until you switch things on.

How it works
1. **Campaign**: choose a sender alias, your real name, company, postal address and a factual brief of what you offer.
2. **Leads**: upload Excel (.xlsx) or CSV, paste CSV, or paste a Google Sheets link (shared "Anyone with the link can view").
   Needs an `email` column; `name, company, role, website, notes` are used; any other columns go to iRIS as context.
3. **Preview 3 emails** (nothing is sent) to judge the writing.
4. **Start** (all safety checks must pass) -> engine writes ONE email per minute-tick at most.
   - Draft-only: up to 10 drafts wait for your Approve / Edit / Reject.
   - Auto-send: only after you press "Grant permission" (expires in 1-30 days).
5. **STOP ALL** (top of the Automation page) blocks every send immediately. It is checked again right before each send,
   and auto-written drafts are discarded. Pause / Stop work per campaign.

Hard rules enforced by the engine (not just the screen)
- NEVER sends from admin@, connect@, support@, sales@, noreply@, noreplay@, no-reply@ (any domain), or any admin
  mailbox. Extra blocked senders: set var `COLD_BLOCKED_SENDERS` (comma list). A campaign using one is paused.
- Master switch OFF by default. Auto-send needs explicit, expiring permission. Contacts must be confirmed legitimate.
- SPF (including Zoho) and DMARC must exist for the sending domain; DKIM is checked (set var `DKIM_SELECTOR` to make it mandatory).
- Warm-up ramp per alias: 5/day -> 10 -> 20 -> 30 -> 50 over 3 weeks. Absolute max 50/alias/day, 150 total/day.
- Random gap between sends (your min..max, never below 4 min), only inside your sending hours and days.
- Max 2 emails/day per recipient domain; nobody emailed in the last 30 days (any campaign); max 3 follow-ups.
- A reply, bounce or opt-out ("no thanks", "stop", "not interested") ends that lead's sequence and suppresses it;
  out-of-office delays the follow-up 7 days. Follow-ups wait until the inbox sync is fresh (< 10 min).
- Each email must pass content rules (no links by default, no spam phrases, no ALL CAPS, 45-150 words, plain text, no
  fake "Re:") and must not resemble recent emails (wording, opening line, subject). Style (opening, structure, call to
  action, tone, length, subject) is chosen differently each time.
- Every email gets your name, company, postal address and a "reply no thanks" opt-out line automatically; an email
  without them is refused.
- A send is atomic: a crash can never produce a duplicate; unknown outcomes are flagged for review, not retried.
- 3 sends failing in a row, or bounces above 3% (after 20 sends) auto-pause the campaign.

Writer model: Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (falls back to Llama 4 Scout). Change with var `WRITER_MODEL`.
Replies from leads show up in Hot automatically (they replied to you).
Not possible via the Zoho API: a List-Unsubscribe header. Opt-out is by reply. For EU/UK recipients check local rules.
