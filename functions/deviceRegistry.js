'use strict';

// Which devices the server-side sweeps should iterate.
//
// WHY THIS REPLACED A HARDCODED ARRAY
// Every sweep - archive, alerts, kWh - walked a literal list in index.js.
// That is fine for three boxes and untenable for a mall: ninety tenant
// devices maintained by hand in source means that sooner or later one is
// missing, and a missing device does not fail loudly. It silently stops
// being archived and stops raising alerts, on a site nobody is watching
// precisely because it looked fine.
//
// companies/ is already the source of truth for which devices exist -
// projectCompanyAccess treats it that way when it decides who may read
// what. Deriving the sweep list from the same place means adding a tenant
// is ONE edit, in the place you were already going to edit, and the sweeps
// pick it up on their next run.
//
// THE SEED EXISTS FOR A REAL CASE, not as a belt-and-braces habit: a box
// can be commissioned and publishing before anyone has set up its company.
// Dropping it from the sweeps during that window is exactly the silent gap
// this is meant to close, so seeds are unioned in rather than used only as
// a fallback.

/**
 * @param companies  the companies/ node, { [companyId]: { devices, members } }
 * @param seed       device ids to include regardless
 * @returns sorted, de-duplicated device ids
 */
function listDevices({ companies = {}, seed = [] } = {}) {
  const ids = new Set();

  for (const id of seed) {
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }

  for (const company of Object.values(companies || {})) {
    if (!company || typeof company !== 'object') continue;
    for (const id of Object.keys(company.devices || {})) {
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }

  // Sorted so sweep order is stable between runs. An unstable order makes
  // one slow device look like a different device timing out each time.
  return [...ids].sort();
}

/**
 * device id -> the companies holding it.
 *
 * A device can belong to several companies at once, and on a mall site it
 * always does: the tenant's own company and the mall's. That is the whole
 * point of the model rather than an edge case, so this returns a list.
 */
function companiesByDevice(companies = {}) {
  const out = {};
  for (const [companyId, company] of Object.entries(companies || {})) {
    if (!company || typeof company !== 'object') continue;
    for (const deviceId of Object.keys(company.devices || {})) {
      out[deviceId] = out[deviceId] || [];
      if (!out[deviceId].includes(companyId)) out[deviceId].push(companyId);
    }
  }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

/**
 * Companies that get a rolled-up overview.
 *
 * Holding more than one device IS the landlord case - a mall company lists
 * every tenant in it, a tenant company lists only itself. So no extra flag
 * is needed to tell them apart, and none can be forgotten when a mall is
 * set up. A one-device company would be showing a summary of a single
 * device it can already open directly.
 */
function overviewCompanies(companies = {}) {
  return Object.entries(companies || {})
    .filter(([, c]) => c && typeof c === 'object' && Object.keys(c.devices || {}).length > 1)
    .map(([id]) => id)
    .sort();
}

module.exports = { listDevices, companiesByDevice, overviewCompanies };
