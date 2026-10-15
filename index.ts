// Supabase Edge Function: send-emails  (supabase/functions/send-emails/index.ts)
// Secrets (set in Supabase > Edge Functions > Secrets; never in browser code):
//   RESEND_API_KEY, EMAIL_FROM, APP_URL (no trailing slash), CRON_SECRET, optional CONTACT_EMAIL
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to Edge Functions automatically.
import { createClient } from "npm:@supabase/supabase-js@2.58.0";

const BRAND = "TejWeb Manager";
const MAX_ATTEMPTS = 5;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// One layout, seven+ templates. All dynamic text is escaped.
const T: Record<string, { eyebrow: string; button: string }> = {
  invitation: { eyebrow: "Your client portal invitation", button: "Set up your account" },
  project_update: { eyebrow: "Project update", button: "View project" },
  support_confirmation: { eyebrow: "Request received", button: "View your request" },
  support_response: { eyebrow: "Reply to your request", button: "Read the reply" },
  payment: { eyebrow: "Payment record updated", button: "View payment summary" },
  deadline: { eyebrow: "Upcoming project deadline", button: "View project" },
  maintenance: { eyebrow: "Website maintenance reminder", button: "View details" },
  support_request: { eyebrow: "New support request", button: "Open admin panel" },
};
const PREF: Record<string, string> = { project_update: "project_updates", support_confirmation: "support_updates", support_response: "support_updates",
  support_request: "support_updates", payment: "payment_updates", deadline: "deadline_reminders", maintenance: "deadline_reminders" };

function render(kind: string, title: string, body: string, url: string, contact?: string) {
  const t = T[kind] ?? { eyebrow: "Notification", button: "Open" };
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#0A1428"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A1428;padding:20px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;font-family:Arial,Helvetica,sans-serif">
<tr><td style="background:#0F1D3A;color:#fff;padding:18px 24px;font-size:18px;font-weight:700">${BRAND}</td></tr>
<tr><td style="padding:24px;color:#0A1428"><div style="color:#2F6BFF;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em">${esc(t.eyebrow)}</div>
<h1 style="font-size:20px;margin:8px 0 12px">${esc(title)}</h1><p style="font-size:15px;line-height:1.6;margin:0 0 20px">${esc(body)}</p>
<a href="${esc(url)}" style="background:#2F6BFF;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;display:inline-block;font-weight:700">${esc(t.button)}</a></td></tr>
<tr><td style="padding:14px 24px;background:#f3f6fd;color:#5a6785;font-size:12px;line-height:1.5">${contact ? "Questions? " + esc(contact) + "<br>" : ""}You are receiving this because of your notification settings in ${BRAND}.</td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  const env = (k: string) => Deno.env.get(k) ?? "";
  const secret = env("CRON_SECRET");
  const given = req.headers.get("x-cron-secret") ?? "";
  if (req.method !== "POST" || !secret || given.length !== secret.length || given !== secret) return new Response("Unauthorized", { status: 401 });
  const missing = ["RESEND_API_KEY", "EMAIL_FROM", "APP_URL"].filter((k) => !env(k));
  if (missing.length) return Response.json({ configured: false, missing }, { status: 503 }); // queue left untouched

  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const { data: batch, error } = await db.rpc("claim_email_deliveries", { p_limit: 20 });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const out = { claimed: batch?.length ?? 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  for (const d of batch ?? []) {
    const log = (outcome: string, http?: number, err?: string) =>
      db.from("email_delivery_attempts").insert({ delivery_id: d.id, attempt: d.attempts, outcome, http_status: http ?? null, error: err?.slice(0, 300) ?? null });
    const finish = async (status: string, patch: Record<string, unknown>, outcome: string, http?: number, err?: string) => {
      await db.from("notification_deliveries").update({ status, locked_at: null, ...patch }).eq("id", d.id);
      await log(outcome, http, err);
    };
    const skip = async (why: string) => { out.skipped++; await finish("failed", { permanent: true, last_error: "skipped: " + why }, "skipped", undefined, why); };
    const fail = async (msg: string, http: number | undefined, permanent: boolean) => {
      const exhausted = d.attempts >= MAX_ATTEMPTS;
      if (permanent || exhausted) { out.failed++; await finish("failed", { permanent, last_error: msg }, "failed", http, msg); }
      else { out.retried++; await finish("retry", { last_error: msg, next_attempt_at: new Date(Date.now() + 2 ** d.attempts * 60_000).toISOString() }, "retry", http, msg); }
    };
    try {
      // Re-check preferences and eligibility at send time.
      const { data: pref } = await db.from("notification_preferences").select("*").eq("user_id", d.recipient_user_id).maybeSingle();
      if (pref && pref.email_enabled === false) { await skip("email disabled by user"); continue; }
      const pk = PREF[d.kind];
      if (pref && pk && pref[pk] === false) { await skip("notification type disabled by user"); continue; }
      if (d.kind === "payment") {
        const pid = String(d.event_key).split(":")[1];
        const { data: pay } = await db.from("project_payments").select("confirmed").eq("id", pid).maybeSingle();
        if (!pay?.confirmed) { await skip("payment not confirmed"); continue; }
      }
      if (d.project_id) {
        const { data: pr } = await db.from("projects").select("client_user_id").eq("id", d.project_id).maybeSingle();
        const { data: adm } = await db.from("admins").select("user_id").eq("user_id", d.recipient_user_id).maybeSingle();
        if (!adm && pr?.client_user_id !== d.recipient_user_id) { await skip("recipient not related to project"); continue; }
      }
      const { data: u } = await db.auth.admin.getUserById(d.recipient_user_id);
      const to = u?.user?.email;
      if (!to) { await skip("recipient has no email address"); continue; }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json", "Idempotency-Key": d.id },
        body: JSON.stringify({ from: env("EMAIL_FROM"), to: [to], subject: d.subject,
          html: render(d.kind, d.title, d.body ?? "", env("APP_URL") + (d.link_path ?? "/portal.html"), env("CONTACT_EMAIL") || undefined) }),
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        // "sent" = accepted by Resend. "delivered" is only set from provider webhooks (not implemented).
        out.sent++;
        await finish("sent", { sent_at: new Date().toISOString(), provider_message_id: j.id ?? null, last_error: null }, "sent", res.status);
      } else {
        const permanent = [400, 422].includes(res.status);
        await fail(`provider HTTP ${res.status}`, res.status, permanent);
      }
    } catch (_) { await fail("network or processing error", undefined, false); }
  }
  return Response.json({ configured: true, ...out });
});
