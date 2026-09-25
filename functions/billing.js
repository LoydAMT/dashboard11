'use strict';

// Electricity billing: turning meter readings into a tenant's bill.
//
// WHERE THE READINGS COME FROM
// Each box takes its kWh reading at 22:00 Philippine time and keeps every
// reading for ever under devices/{id}/history/kWh/raw. That is the source of
// truth here - not the kwhDaily snapshot, which is a convenience derived from
// it (and which, it turned out, recorded nothing for its first week because
// of a missing index). Billing from the raw readings means a missed snapshot
// can never cost a tenant or a landlord a day.
//
// NO FIRMWARE INVOLVED. Rates, emails and bills are company data the box
// never sees, the same as alert thresholds and device names.
//
// WHAT A PERIOD MEANS
// A bill for 1-30 September runs from the reading taken at 22:00 on 31 August
// to the one taken at 22:00 on 30 September: meter read to meter read, the
// way a utility bill does it. Every day in the range is covered exactly once
// and consecutive periods neither overlap nor leave a gap.

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const READ_HOUR_UTC = 14;        // 22:00 PHT (UTC+8, no DST)
const MAX_PERIOD_DAYS = 400;
const OFFSET_WARN_MS = 2 * HOUR_MS;
const MAX_EMAILS = 10;

/** 'YYYY-MM-DD' -> epoch ms of that day's 22:00 PHT reading, or null. */
function readingTimeOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]) - 1; const d = Number(m[3]);
  const midnight = Date.UTC(y, mo, d);
  const back = new Date(midnight);
  // Round-trip check rejects dates that do not exist, e.g. 2026-02-30,
  // which Date.UTC would otherwise quietly roll into March.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo || back.getUTCDate() !== d) return null;
  // 22:00 PHT falls on the SAME calendar date at 14:00 UTC.
  return midnight + READ_HOUR_UTC * HOUR_MS;
}

/**
 * The two meter-read moments bounding a period, or { error }.
 *
 * `now` guards against billing a period whose closing reading has not been
 * taken yet - that bill would silently stop at whatever the latest reading
 * was and look complete.
 */
function periodBoundaries(from, to, now = Date.now()) {
  const fromRead = readingTimeOf(from);
  const endTs = readingTimeOf(to);
  if (fromRead === null) return { error: `"${from}" is not a valid start date` };
  if (endTs === null) return { error: `"${to}" is not a valid end date` };
  if (endTs < fromRead) return { error: 'The end date is before the start date' };
  const days = Math.round((endTs - fromRead) / DAY_MS) + 1;
  if (days > MAX_PERIOD_DAYS) return { error: `A billing period can cover at most ${MAX_PERIOD_DAYS} days` };
  if (endTs > now) {
    return { error: `The closing reading for ${to} is taken at 22:00 Philippine time and has not happened yet` };
  }
  return { startTs: fromRead - DAY_MS, endTs, days };
}

/**
 * The reading that stands for the meter at `target`.
 *
 * A box offline at 22:00 takes that day's reading on its first cycle after
 * coming back, so the first reading at or after the target - if it arrived
 * within the day - is the genuine one. Failing that, the latest reading
 * before it. Either way the offset is kept, so a bill built on a reading
 * hours away from the boundary says so instead of passing as exact.
 */
function pickReading(sorted, target) {
  let after = null;
  let before = null;
  for (const r of sorted) {
    if (r.ts >= target) { after = r; break; }
    before = r;
  }
  if (after && after.ts - target < DAY_MS) return { ...after, offsetMs: after.ts - target };
  if (before && target - before.ts <= 1.5 * DAY_MS) return { ...before, offsetMs: before.ts - target };
  const cands = [after, before].filter(Boolean);
  if (cands.length === 0) return null;
  cands.sort((a, b) => Math.abs(a.ts - target) - Math.abs(b.ts - target));
  return { ...cands[0], offsetMs: cands[0].ts - target };
}

/**
 * kWh consumed across a period, from raw readings.
 *
 * Summed as the rise between consecutive readings rather than end minus
 * start. A meter that resets - the simulated boxes do on every reboot, a
 * real one when it is replaced - makes end minus start negative or absurd.
 * A fall is instead counted as a reset: that step contributes nothing and
 * the bill is flagged, because the energy used around a reset cannot be
 * known and a person has to decide what to charge for it.
 */
function consumption(readings, startTs, endTs) {
  const sorted = (readings || [])
    .filter((r) => r && Number.isFinite(r.ts) && Number.isFinite(r.value))
    .sort((a, b) => a.ts - b.ts);

  const flags = [];
  const start = pickReading(sorted, startTs);
  const end = pickReading(sorted, endTs);

  if (!start || !end || end.ts <= start.ts) {
    flags.push('no-readings');
    return { kwh: null, start, end, resets: 0, flags };
  }

  const span = sorted.filter((r) => r.ts >= start.ts && r.ts <= end.ts);
  let kwh = 0;
  let resets = 0;
  for (let i = 1; i < span.length; i++) {
    const d = span[i].value - span[i - 1].value;
    if (d >= 0) kwh += d;
    else resets += 1;
  }

  if (resets > 0) flags.push('meter-reset');
  if (Math.abs(start.offsetMs) > OFFSET_WARN_MS) flags.push('start-reading-off');
  if (Math.abs(end.offsetMs) > OFFSET_WARN_MS) flags.push('end-reading-off');

  return { kwh: round(kwh, 3), start, end, resets, flags };
}

/**
 * The money. Worked in whole centavos so that 0.1 + 0.2 never appears on a
 * bill, then returned in pesos.
 *
 * VAT is charged on energy PLUS the fixed charge, since both are part of
 * the supply. The rate is treated as VAT-exclusive; a mall quoting a
 * VAT-inclusive rate sets VAT to 0.
 */
function amounts({ kwh, ratePerKwh, vatPct = 0, fixedCharge = 0 }) {
  const c = (x) => Math.round(x * 100);
  const energy = c((kwh || 0) * (ratePerKwh || 0));
  const fixed = c(fixedCharge || 0);
  const subtotal = energy + fixed;
  const vat = Math.round(subtotal * (vatPct || 0) / 100);
  return {
    energy: energy / 100,
    fixed: fixed / 100,
    subtotal: subtotal / 100,
    vat: vat / 100,
    total: (subtotal + vat) / 100,
  };
}

/**
 * "a@x.com, B@Y.com; junk" -> { valid: ['a@x.com','b@y.com'], invalid: ['junk'] }.
 *
 * Deliberately loose - a full RFC check rejects real addresses. It exists to
 * catch the typo that would otherwise send a bill nowhere without anyone
 * noticing, not to be a validator of record.
 */
function parseEmails(raw) {
  const valid = [];
  const invalid = [];
  for (const part of String(raw || '').split(/[,;\s]+/)) {
    const e = part.trim().toLowerCase();
    if (!e) continue;
    if (/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(e)) {
      if (!valid.includes(e)) valid.push(e);
    } else if (!invalid.includes(part.trim())) {
      invalid.push(part.trim());
    }
  }
  return { valid: valid.slice(0, MAX_EMAILS), invalid };
}

/** Company billing settings, validated. Returns { settings } or { error }. */
function readSettings(raw) {
  const s = raw || {};
  const rate = Number(s.ratePerKwh);
  if (!Number.isFinite(rate) || rate <= 0) {
    return { error: 'Set a rate per kWh in billing settings before preparing bills' };
  }
  const vat = Number(s.vatPct || 0);
  const fixed = Number(s.fixedCharge || 0);
  const reply = parseEmails(s.replyTo).valid[0] || null;
  return {
    settings: {
      ratePerKwh: rate,
      vatPct: Number.isFinite(vat) && vat >= 0 && vat <= 100 ? vat : 0,
      fixedCharge: Number.isFinite(fixed) && fixed >= 0 ? fixed : 0,
      replyTo: reply,
      senderName: cleanName(s.senderName) || null,
      footer: typeof s.footer === 'string' ? s.footer.slice(0, 1000) : '',
      currency: 'PHP',
    },
  };
}

/**
 * Header-safe display name: no angle brackets, quotes or line breaks. A
 * name containing "\r\n" would otherwise be a header-injection hole in the
 * From line, and a quote or bracket breaks the address syntax.
 */
function cleanName(v) {
  return typeof v === 'string' ? v.replace(/[<>"\r\n]/g, '').trim().slice(0, 80) : '';
}

/**
 * Build one tenant's draft bill.
 *
 * Everything needed to reproduce it is stored ON the bill - both readings
 * with their times, the rate, VAT and fixed charge as they were - so a rate
 * change next month cannot silently rewrite what this one said.
 */
function draftBill({ deviceId, tenantName, emails, readings, period, settings, keep = {} }) {
  const c = consumption(readings, period.startTs, period.endTs);
  const adjusted = Number.isFinite(keep.adjustKwh) ? keep.adjustKwh : null;
  const kwh = adjusted !== null ? adjusted : c.kwh;
  const addr = parseEmails(emails);
  const flags = [...c.flags];
  if (addr.valid.length === 0) flags.push('no-email');

  return {
    deviceId,
    tenantName: cleanName(tenantName) || deviceId,
    to: addr.valid,
    start: c.start ? { ts: c.start.ts, value: c.start.value, offsetMs: c.start.offsetMs } : null,
    end: c.end ? { ts: c.end.ts, value: c.end.value, offsetMs: c.end.offsetMs } : null,
    measuredKwh: c.kwh,
    kwh,
    adjustKwh: adjusted,
    adjustNote: adjusted !== null ? String(keep.adjustNote || '').slice(0, 300) : null,
    resets: c.resets,
    flags,
    rate: settings.ratePerKwh,
    vatPct: settings.vatPct,
    fixedCharge: settings.fixedCharge,
    currency: settings.currency,
    ...amounts({ kwh, ...settings }),
    // A bill with no kWh cannot be sent until someone enters a figure or
    // leaves it out. Carried forward on refresh so an exclusion survives.
    included: keep.included === undefined ? kwh !== null : Boolean(keep.included),
  };
}

/**
 * Can this bill go out? Returns null when it can, or the reason it cannot.
 * Checked on the server at send time - the review screen is a convenience,
 * not the gate.
 */
function sendBlocker(bill) {
  if (!bill) return 'missing';
  if (bill.status === 'sent') return 'already sent';
  if (!bill.included) return 'left out of this run';
  if (!Number.isFinite(bill.kwh)) return 'no kWh figure';
  if (!Array.isArray(bill.to) || bill.to.length === 0) return 'no email address';
  return null;
}

function round(v, dp) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

module.exports = {
  readingTimeOf, periodBoundaries, pickReading, consumption, amounts,
  parseEmails, readSettings, cleanName, draftBill, sendBlocker,
  DAY_MS, HOUR_MS,
};
