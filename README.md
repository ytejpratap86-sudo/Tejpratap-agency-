# TejWeb Manager

Agency website, admin panel, client portal, notifications and email queue (static HTML + Supabase).

## Files
- `index.html` - public agency website with the enquiry form (saves leads to Supabase)
- `admin.html` - admin panel: leads CRM, projects, clients, support requests, email queue, notifications
- `portal.html` - client portal: projects, payments (read-only), support requests, notifications, profile
- `supabase/migrations/` - first two migrations only (see note below)
- `supabase/functions/send-emails/index.ts` - Edge Function that sends queued emails through Resend
- `supabase/cron_email_setup.sql` - schedules the email function (run after deploying it)

## Important note on the database
Your Supabase project already contains later migrations (projects, tasks, payments, client portal, notifications,
email queue) that were applied directly and are NOT in this repo yet. Export them before treating this repo as the
full source of truth: `supabase db pull` (Supabase CLI) writes them into `supabase/migrations/`.

## Config (public values only; never commit secrets)
The Supabase URL and publishable key are set at the top of the script in each HTML file. They are public by design;
Row Level Security protects the data. Never put the service-role key in any HTML file.
Edge Function secrets (set in Supabase, not in this repo): RESEND_API_KEY, EMAIL_FROM, APP_URL, CRON_SECRET, optional CONTACT_EMAIL.

## Hosting
Host the three HTML files on one domain over HTTPS (Netlify, Vercel, GitHub Pages or your own hosting).

## Email setup order
1. Create a Resend account, verify your domain, create an API key.
2. Deploy: `supabase functions deploy send-emails --no-verify-jwt`
3. Set secrets: `supabase secrets set RESEND_API_KEY=... EMAIL_FROM=... APP_URL=... CRON_SECRET=...`
4. Store the same secret in Vault and run `supabase/cron_email_setup.sql`.

## Status
Database security rules were tested with rolled-back test data. The HTML screens, the email function and Resend sending have not been tested end to end.
