'use strict';

// The bill as a tenant receives it.
//
// Inline styles and tables only: email clients strip <style> blocks and
// ignore most modern CSS, so anything else renders differently in Gmail,
// Outlook and a phone's mail app. Every value from the database goes
// through esc() - a tenant name is typed by a person, and one containing
// markup must arrive as text, not as part of the email.

const PH_OFFSET_MS = 8 * 3600000;

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(v, currency = 'PHP') {
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(v || 0);
}

function kwhText(v) {
  return Number.isFinite(v)
    ? `${new Intl.NumberFormat('en-PH', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(v)} kWh`
    : '—';
}

// Dates are formatted by hand rather than through toLocaleDateString. Locale
// data differs between runtimes - this Node writes "Sept", others "Sep" -
// and a financial document should not change its wording because the server
// picked up a newer ICU.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** A moment as a Philippine date (and time), whatever zone the server runs in. */
function phWhen(ms, withTime = true) {
  const d = new Date(ms + PH_OFFSET_MS);
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return withTime ? `${date}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date;
}

/** '2026-09-01' -> '1 Sep 2026' */
function dayText(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * @param bill     a bill document (see billing.draftBill)
 * @param run      { periodFrom, periodTo }
 * @param company  { name, senderName, replyTo, footer }
 */
function buildBillEmail({ bill, run, company }) {
  const who = company.senderName || company.name || 'Your landlord';
  const period = `${dayText(run.periodFrom)} – ${dayText(run.periodTo)}`;
  const cur = bill.currency || 'PHP';
  const subject = `Electricity bill · ${bill.tenantName} · ${period}`;

  const row = (label, value, strong = false) => `
    <tr>
      <td style="padding:7px 0;color:#5b636f;font-size:14px;">${esc(label)}</td>
      <td style="padding:7px 0;text-align:right;font-size:14px;${strong ? 'font-weight:700;color:#14171c;' : 'color:#14171c;'}">${esc(value)}</td>
    </tr>`;

  const adjusted = Number.isFinite(bill.adjustKwh);
  const lines = [
    row('Previous reading', bill.start ? `${kwhText(bill.start.value)} · ${phWhen(bill.start.ts)}` : '—'),
    row('Present reading', bill.end ? `${kwhText(bill.end.value)} · ${phWhen(bill.end.ts)}` : '—'),
    row(adjusted ? 'Consumption (adjusted)' : 'Consumption', kwhText(bill.kwh), true),
    row(`Energy · ${money(bill.rate, cur)} per kWh`, money(bill.energy, cur)),
  ];
  if (bill.fixed > 0) lines.push(row('Fixed charge', money(bill.fixed, cur)));
  if (bill.vatPct > 0) lines.push(row(`VAT ${bill.vatPct}%`, money(bill.vat, cur)));

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d8dbe0;border-radius:12px;">
  <tr><td style="padding:22px 26px 6px;">
    <div style="font-size:13px;color:#5b636f;">${esc(who)}</div>
    <div style="font-size:21px;font-weight:700;color:#14171c;margin-top:2px;">Electricity bill</div>
  </td></tr>
  <tr><td style="padding:8px 26px 0;">
    <div style="font-size:15px;color:#14171c;font-weight:600;">${esc(bill.tenantName)}</div>
    <div style="font-size:13px;color:#5b636f;margin-top:2px;">Billing period ${esc(period)}</div>
  </td></tr>
  <tr><td style="padding:14px 26px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eceef1;">
      ${lines.join('')}
    </table>
  </td></tr>
  <tr><td style="padding:6px 26px 20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef4fd;border-radius:10px;">
      <tr>
        <td style="padding:14px 16px;font-size:14px;color:#14171c;font-weight:600;">Amount due</td>
        <td style="padding:14px 16px;text-align:right;font-size:22px;font-weight:800;color:#14171c;">${esc(money(bill.total, cur))}</td>
      </tr>
    </table>
  </td></tr>
  ${adjusted && bill.adjustNote ? `<tr><td style="padding:0 26px 14px;font-size:12px;color:#5b636f;">Note on consumption: ${esc(bill.adjustNote)}</td></tr>` : ''}
  ${company.footer ? `<tr><td style="padding:0 26px 16px;font-size:13px;color:#14171c;white-space:pre-line;">${esc(company.footer)}</td></tr>` : ''}
  <tr><td style="padding:14px 26px 20px;border-top:1px solid #eceef1;font-size:12px;color:#878f9b;">
    ${company.replyTo ? `Questions about this bill? Reply to this email and it will reach ${esc(who)}.<br>` : ''}
    Readings are taken automatically at 22:00 Philippine time by the meter on your supply.
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    `${who} — Electricity bill`,
    '',
    bill.tenantName,
    `Billing period ${period}`,
    '',
    `Previous reading: ${bill.start ? `${kwhText(bill.start.value)} (${phWhen(bill.start.ts)})` : '—'}`,
    `Present reading:  ${bill.end ? `${kwhText(bill.end.value)} (${phWhen(bill.end.ts)})` : '—'}`,
    `Consumption${adjusted ? ' (adjusted)' : ''}: ${kwhText(bill.kwh)}`,
    `Energy at ${money(bill.rate, cur)}/kWh: ${money(bill.energy, cur)}`,
    ...(bill.fixed > 0 ? [`Fixed charge: ${money(bill.fixed, cur)}`] : []),
    ...(bill.vatPct > 0 ? [`VAT ${bill.vatPct}%: ${money(bill.vat, cur)}`] : []),
    '',
    `AMOUNT DUE: ${money(bill.total, cur)}`,
    ...(adjusted && bill.adjustNote ? ['', `Note on consumption: ${bill.adjustNote}`] : []),
    ...(company.footer ? ['', company.footer] : []),
    '',
    company.replyTo ? `Questions? Reply to this email to reach ${who}.` : '',
  ].join('\n');

  return { subject, html, text };
}

module.exports = { buildBillEmail, esc, money, phWhen, dayText };
