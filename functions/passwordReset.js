'use strict';

// "Forgot your password?" - our own email instead of Firebase's.
//
// Firebase can send a reset email by itself, but only its own plain template
// from a firebaseapp.com address, and editing that template is locked for
// this project. So the reset LINK is still Firebase's (made here with the
// Admin SDK, opening Firebase's own "choose a new password" page) and only
// the email around it is ours, sent through Resend from our own domain.
//
// WHAT THIS MUST NOT DO
//   Say whether an address has an account. The answer is the same either
//   way; a stranger learns nothing by typing addresses into the form.
//   Send without limit. Anyone can call this, signed in or not - that is
//   what a forgotten password means - so each address is limited, or the
//   form becomes a way to fill someone's inbox and spend the sending quota.
//
// The handler takes everything it touches as an argument, so it is tested
// without Firebase, Resend or a clock.

const crypto = require('node:crypto');

// One reset email per address per minute, and five per hour.
const MIN_GAP_MS = 60000;
const WINDOW_MS = 60 * 60000;
const MAX_PER_WINDOW = 5;

// How "no such account" is reported: the Admin SDK says email-not-found,
// the client SDK user-not-found.
const NO_ACCOUNT = new Set(['auth/user-not-found', 'auth/email-not-found']);

const EMAIL_RE =/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The key an address is limited under - a hash, so no address is stored. */
function limitKey(email) {
  return crypto.createHash('sha256').update(email).digest('hex').slice(0, 40);
}

/**
 * Whether one more email may go to this address, and the state to store.
 * @param prev  { last, windowStart, count } or null
 * @returns { allowed, retryMs, next }
 */
function checkLimit(prev, now) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const last = Number(p.last) || 0;
  const inWindow = now - (Number(p.windowStart) || 0) < WINDOW_MS;
  const count = inWindow ? Number(p.count) || 0 : 0;
  const windowStart = inWindow ? Number(p.windowStart) : now;

  if (now - last < MIN_GAP_MS) return { allowed: false, retryMs: MIN_GAP_MS - (now - last), next: null };
  if (count >= MAX_PER_WINDOW) return { allowed: false, retryMs: windowStart + WINDOW_MS - now, next: null };
  return { allowed: true, retryMs: 0, next: { last: now, windowStart, count: count + 1 } };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * The email. Tables and inline styles, because that is what mail programs
 * draw the same way; `text` is the same message for one that shows no HTML.
 */
function buildResetEmail({ email, link, logoUrl }) {
  const e = esc(email);
  const l = esc(link);
  const logo = logoUrl
    ? `<td style="padding-right:10px;"><img src="${esc(logoUrl)}" width="36" height="36" alt="" style="display:block;border:0;"></td>`
    : '';
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e6ec;border-radius:10px;">
<tr><td style="padding:20px 28px;border-bottom:3px solid #1f6feb;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>${logo}
<td><div style="font-size:17px;font-weight:bold;color:#111827;letter-spacing:.3px;">INSTRUBYTE</div>
<div style="font-size:11px;color:#6b7280;letter-spacing:1.5px;">TELEMETRY</div></td>
</tr></table>
</td></tr>
<tr><td style="padding:28px;">
<h1 style="margin:0 0 12px;font-size:20px;color:#111827;">Reset your password</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#374151;">We received a request to reset the password for <strong>${e}</strong>. Click the button below to choose a new one.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr>
<td style="background:#1f6feb;border-radius:8px;"><a href="${l}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">Reset password</a></td>
</tr></table>
<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#6b7280;">If the button does not work, copy this link into your browser:</p>
<p style="margin:0 0 20px;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${l}" style="color:#1f6feb;">${l}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#6b7280;">If you did not ask for this, you can ignore this email. Your password will stay the same.</p>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e2e6ec;font-size:12px;color:#9ca3af;">Instrubyte Telemetry &middot; This is an automated message, please do not reply.</td></tr>
</table>
</td></tr>
</table>`;
  const text = [
    'Reset your password',
    '',
    `We received a request to reset the password for ${email}.`,
    'Open this link to choose a new one:',
    '',
    link,
    '',
    'If you did not ask for this, you can ignore this email. Your password will stay the same.',
    '',
    'Instrubyte Telemetry',
  ].join('\n');
  return { subject: 'Reset your Instrubyte Telemetry password', html, text };
}

function cors(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return true; }
  return false;
}

/**
 * @param deps.generateLink  async (email) -> link; throws with
 *                           code 'auth/user-not-found' for no such account
 * @param deps.takeTurn      async (key, now) -> { allowed, retryMs }; must
 *                           record the turn it grants (see checkLimit)
 * @param deps.apiKey        () -> the Resend key
 * @param deps.fromAddress   'Name <address@verified-domain>'
 * @param deps.logoUrl       optional image shown in the header
 * @param deps.fetchImpl     fetch
 * @param deps.now           () -> ms
 * @param deps.log           (message) -> void
 */
function createPasswordReset(deps) {
  const doFetch = deps.fetchImpl || fetch;
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});

  return async (req, res) => {
    if (cors(req, res)) return;
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }

    // Limited BEFORE anything is looked up, and for every address alike, so
    // being told to wait says nothing about whether the account exists.
    const turn = await deps.takeTurn(limitKey(email), now());
    if (!turn.allowed) {
      res.status(429).json({
        error: 'A reset email was sent to this address a moment ago. Check your inbox, or try again later.',
        retrySeconds: Math.ceil(turn.retryMs / 1000),
      });
      return;
    }

    let link;
    try {
      link = await deps.generateLink(email);
    } catch (err) {
      if (err && NO_ACCOUNT.has(err.code)) {
        // The same answer an existing account gets. Nothing is sent.
        res.json({ ok: true });
        return;
      }
      log(`passwordReset: could not create a link (${(err && err.code) || 'error'}) ` +
        String((err && err.message) || '').slice(0, 300));
      res.status(500).json({ error: 'Could not start the reset. Try again in a moment.' });
      return;
    }

    const mail = buildResetEmail({ email, link, logoUrl: deps.logoUrl });
    try {
      const resp = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${deps.apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: deps.fromAddress, to: [email], subject: mail.subject, html: mail.html, text: mail.text,
        }),
      });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || !body.id) {
        log(`passwordReset: Resend refused (${resp.status}) ${String(body.message || body.name || '').slice(0, 200)}`);
        // 502 tells the page to fall back to Firebase's own email, so a
        // problem with our sender never leaves someone locked out.
        res.status(502).json({ error: 'Could not send the reset email.' });
        return;
      }
    } catch (err) {
      log(`passwordReset: Resend unreachable (${(err && err.name) || 'error'})`);
      res.status(502).json({ error: 'Could not send the reset email.' });
      return;
    }

    res.json({ ok: true });
  };
}

module.exports = {
  createPasswordReset, buildResetEmail, checkLimit, limitKey,
  MIN_GAP_MS, WINDOW_MS, MAX_PER_WINDOW,
};
