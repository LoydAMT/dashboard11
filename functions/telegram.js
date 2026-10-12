'use strict';

// Telegram notifications for alerts a box reports (index.js: boxAlertEvent).
//
// Sent from here rather than from the box: a box that stops to make a web
// request stops reading its meters for as long as the request takes, and
// the bot token would have to sit in every box's script. Here it is one
// secret, and one message per alert.
//
// Everything that DECIDES is a pure function in this file, so it is tested
// without a network. sendTelegram is the only thing that talks to Telegram.

// WHICH malls post, and WHAT they post, is set on the admin page (the Alarms
// tab) and stored at telegramNotify/{companyId}:
//   'limits'  a reading going over or under its limit
//   'all'     that, and spikes
//   absent    nothing from this mall
// A meter in no mall with a setting is never announced.
const KINDS_BY_MODE = {
  limits: new Set(['alarm-high', 'alarm-low']),
  all: new Set(['alarm-high', 'alarm-low', 'spike']),
};

// What a mall is called at the start of a message, where the stored name
// ("AMCB 4th Floor IT Services") is too long to lead every one. A mall not
// listed here uses its stored name.
const MALL_LABELS = {
  'ayala-box1': 'IT Services',
  'amcb-4th-floor-zone-3': 'Zone 3',
};

// The same meter and reading is not announced again within this long. A
// reading sitting right at its limit crosses it, clears and crosses again
// every few seconds, and a group that gets a message a minute stops being
// read at all. The first crossing is always announced at once; the alert log
// on the dashboard still records every one of them.
const TELEGRAM_COOLDOWN_MS = 10 * 60000;

/**
 * Where this meter's alerts are announced: { label, kinds } for the first
 * mall it belongs to that has a setting, or null when none has.
 *
 * @param owning    company ids holding the meter
 * @param modes     telegramNotify/ as stored
 * @param companies companies/ as stored, for a mall's own name
 */
function notifyTargetFor(owning = [], modes = {}, companies = {}) {
  for (const companyId of owning) {
    const kinds = KINDS_BY_MODE[modes && modes[companyId]];
    if (!kinds) continue;
    const stored = companies[companyId] && companies[companyId].name;
    const label = MALL_LABELS[companyId] || (typeof stored === 'string' && stored) || companyId;
    return { label, kinds };
  }
  return null;
}

/**
 * Whether this alert is announced, given when this meter's reading was last
 * announced. `lastSentTs` is the ts of that alert, or undefined.
 *
 * An alert no newer than the last one sent is refused too: the database
 * delivers an event at least once, and the second delivery must not post a
 * second message.
 */
function shouldNotify({ alert, target, lastSentTs, cooldownMs = TELEGRAM_COOLDOWN_MS }) {
  if (!alert || !target || !target.kinds.has(alert.kind)) return false;
  if (typeof lastSentTs !== 'number' || !Number.isFinite(lastSentTs)) return true;
  return alert.ts - lastSentTs >= cooldownMs;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 231.87 -> "232", 12.44 -> "12.4", 0.537 -> "0.54". */
function formatReading(v) {
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** "10:42 PM" in Philippine time, whatever zone the function runs in. */
function clockPH(ts) {
  return new Date(ts).toLocaleTimeString('en-US', {
    timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * The message, e.g. "IT Services - Wow Travel: Current spiked to 12.4 A (10:42 PM)".
 *
 * Plain text, no Markdown: a store name with an underscore or an asterisk in
 * it would otherwise be read as formatting and the message refused.
 */
function telegramText({ alert, mallLabel, meterName, unit }) {
  const who = `${mallLabel} - ${meterName || alert.device}`;
  const tag = alert.tagName || alert.tagKey;
  const reading = isNum(alert.value)
    ? `${formatReading(alert.value)}${unit ? ` ${unit}` : ''}`
    : null;
  const when = `(${clockPH(alert.ts)})`;

  if (alert.kind === 'spike') {
    return `${who}: ${tag} spiked${reading ? ` to ${reading}` : ''} ${when}`;
  }
  if (alert.kind === 'alarm-high' || alert.kind === 'alarm-low') {
    const side = alert.kind === 'alarm-high' ? 'high' : 'low';
    return `${who}: ${tag} exceeded its ${side} limit${reading ? `, now ${reading}` : ''} ${when}`;
  }
  if (alert.kind === 'alarm-clear') {
    return `${who}: ${tag} back within its limits${reading ? `, now ${reading}` : ''} ${when}`;
  }
  return `${who}: ${alert.message || alert.kind} ${when}`;
}

/**
 * Posts one message. Resolves { ok, status, description } and never throws:
 * a notification that cannot be sent must not undo the alert it is about,
 * which is already filed by the time this is called.
 *
 * The token goes in the URL because that is Telegram's API; it is never
 * logged, and neither is the URL.
 */
async function sendTelegram({ token, chatId, text, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!token || !chatId) return { ok: false, status: 0, description: 'not configured' };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let description = '';
    try { description = (await res.json()).description || ''; } catch { /* no body */ }
    return { ok: res.ok, status: res.status, description };
  } catch (err) {
    // err.message from fetch names the failure ("fetch failed", a timeout),
    // not the address it was sent to.
    return { ok: false, status: 0, description: String((err && err.name) || 'error') };
  }
}

module.exports = {
  KINDS_BY_MODE, MALL_LABELS, TELEGRAM_COOLDOWN_MS,
  notifyTargetFor, shouldNotify, telegramText, sendTelegram,
};
