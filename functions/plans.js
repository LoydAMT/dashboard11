'use strict';

// Which package a company is on - Standard or Premium - per the package
// comparison guide of 21 September 2026. Premium only ever adds; nothing a
// Standard company has is taken away by this file.
//
// THE PLAN LIVES ON THE COMPANY: companies/{companyId}/plan = "premium".
// Anything else, including no value at all, is Standard. An admin sets it
// on /naming (components/CompanyPlans.jsx), or by hand in the console.
//
// THE PLAN FOLLOWS THE METER. projectCompanyAccess writes each device's
// plan to devices/{deviceId}/plan, Premium when ANY company holding it is
// Premium. So a mall on Premium covers every tenant's meter, including when
// a tenant opens it through their own login, without each tenant's company
// needing a plan of its own.
//
// What Premium adds, and what refuses it on Standard:
//   history older than what RTDB still holds   readArchive
//   billing (the guide's "tenants billed from   billingApi, billingSend
//     these readings")
//   separate tenant logins                     projectCompanyAccess
//   per-second detail, weekly/monthly totals   the dashboard only - see
//                                              src/lib/plans.js for why
//
// The searchable alert history (readAlerts) was on that list and no longer
// is: since 6 October 2026 it is part of Standard, for one meter and for a
// whole company alike.
//
// Admins are Instrubyte staff and are never limited by a customer's plan.

const PREMIUM = 'premium';
const STANDARD = 'standard';

const planOf = (company) => (company && company.plan === PREMIUM ? PREMIUM : STANDARD);

// A company that is one tenant's own login under a building, marked with
// tenant: true (the same card on /naming). Its members only get the tenant's meter while that
// meter is on Premium - on Standard, building management is who signs in.
// Unmarked companies are never limited this way, so a forgotten flag leaves
// a login working rather than locking someone out.
const isTenantCompany = (company) => Boolean(company && company.tenant === true);

module.exports = { PREMIUM, STANDARD, planOf, isTenantCompany };
