// Standard and Premium, as the dashboard sees them. The server half, and the
// full list of what Premium adds, is functions/plans.js.
//
// A meter's plan is read from devices/{id}/plan and a company's from
// companies/{id}/plan. Anything but "premium" - including a read that has
// not arrived or was refused - is Standard, so the dashboard never offers
// something the server would then turn down.
//
// Two kinds of gate here, and the difference matters:
//
//   The archive, the alert history and billing are served by Cloud
//   Functions that check the plan themselves. Hiding them here only spares
//   a Standard company a button that would be refused.
//
//   Per-second detail (the Raw ranges) and the weekly/monthly kWh totals
//   are hidden HERE ONLY. Their data sits under devices/{id}/history, which
//   the rules must keep readable for the minute rollups and the daily kWh
//   reading that Standard does include - and an RTDB read grant cascades to
//   everything beneath it, raw/ included. So a Standard customer writing
//   their own code against the database could still read them. The hard
//   limit is the box not pushing raw samples for a Standard meter at all.
//
// The 7-day chart is hidden for a plainer reason: without the archive it
// could only ever show the two days RTDB keeps.

export const PREMIUM = 'premium'

/** Admins are Instrubyte staff and see every feature on every plan. */
export const hasPremium = (plan, isAdmin) => Boolean(isAdmin) || plan === PREMIUM

/** Only what this plan includes, from a list of ranges marked `premium`. */
export const offered = (list, premium) => list.filter((r) => premium || !r.premium)
