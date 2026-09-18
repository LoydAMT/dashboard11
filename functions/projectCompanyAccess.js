'use strict';

// Projects companies/ down into the flat nodes the security rules can
// actually reach.
//
// WHY THIS EXISTS
// A rule cannot iterate. It cannot ask "is there any company that contains
// this device and lists me as a member" - it can only do direct lookups
// like root.child('devices/X/viewers/UID'). So the fan-out has to happen
// once, ahead of time, into a shape a lookup can reach.
//
// companies/ is the source of truth. This writes:
//   devices/{deviceId}/viewers/{uid}   = true
//   devices/{deviceId}/operators/{uid} = true
//   access/{uid}/{deviceId}            = "viewer" | "operator"
//   userCompanies/{uid}/{companyId}    = true
//
// It is a FULL recompute from companies/ on every run, not a delta. A delta
// would need to know what the previous state was to un-grant correctly, and
// getting that wrong silently leaves someone with access they were removed
// from - the exact failure this is meant to prevent. A full recompute is
// idempotent and has no such state.
//
// Telemetry is never touched. A company is a set of devices plus a set of
// members; the data stays where it is.

// Super admins are granted everything by admins/{uid} in the rules, so they
// do not need per-device entries. But they must never be REMOVED by a
// company edit either - an admin locked out by someone editing a company is
// a far worse failure than a redundant grant. So any uid in admins/ is
// preserved wherever it already appears.
function computeProjection({ companies, adminUids = [], existing = {} }) {
  const admins = new Set(adminUids);
  const deviceGrants = {};
  const access = {};
  const userCompanies = {};

  for (const [companyId, company] of Object.entries(companies || {})) {
    if (!company || typeof company !== 'object') continue;
    const devices = Object.keys(company.devices || {});
    const members = company.members || {};

    for (const [uid, role] of Object.entries(members)) {
      if (typeof uid !== 'string' || uid.length === 0) continue;
      userCompanies[uid] = userCompanies[uid] || {};
      userCompanies[uid][companyId] = true;

      for (const deviceId of devices) {
        deviceGrants[deviceId] = deviceGrants[deviceId] || { viewers: {}, operators: {} };
        access[uid] = access[uid] || {};

        // Operator wins over viewer when someone is both, via two companies
        // on the same device. Taking the weaker role would silently revoke
        // a capability they legitimately hold elsewhere.
        //
        // Both are recorded here and the contradiction is resolved after
        // the loop. Deciding it inline only works if the operator grant
        // happens to be visited first, which depends on object key order -
        // the same uid would land in BOTH lists depending on what the
        // companies were named.
        if (role === 'operator') {
          deviceGrants[deviceId].operators[uid] = true;
          access[uid][deviceId] = 'operator';
        } else {
          deviceGrants[deviceId].viewers[uid] = true;
          if (access[uid][deviceId] !== 'operator') access[uid][deviceId] = 'viewer';
        }
      }
    }
  }

  // Resolve viewer/operator collisions in one pass, independent of the
  // order the companies happened to be iterated in. Being in both lists is
  // not harmless: the rules read them separately, and a stale viewers entry
  // would survive the operator grant being taken away.
  for (const grants of Object.values(deviceGrants)) {
    for (const uid of Object.keys(grants.operators)) delete grants.viewers[uid];
  }

  // Make sure every device that exists in any company has an entry, so a
  // company losing its last member actually clears that device's lists
  // rather than leaving them untouched.
  for (const company of Object.values(companies || {})) {
    for (const deviceId of Object.keys((company && company.devices) || {})) {
      deviceGrants[deviceId] = deviceGrants[deviceId] || { viewers: {}, operators: {} };
    }
  }

  // Preserve admins wherever they currently sit.
  for (const [deviceId, grants] of Object.entries(existing.deviceGrants || {})) {
    for (const uid of Object.keys(grants.viewers || {})) {
      if (admins.has(uid)) {
        deviceGrants[deviceId] = deviceGrants[deviceId] || { viewers: {}, operators: {} };
        deviceGrants[deviceId].viewers[uid] = true;
      }
    }
    for (const uid of Object.keys(grants.operators || {})) {
      if (admins.has(uid)) {
        deviceGrants[deviceId] = deviceGrants[deviceId] || { viewers: {}, operators: {} };
        deviceGrants[deviceId].operators[uid] = true;
      }
    }
  }
  for (const [uid, devs] of Object.entries(existing.access || {})) {
    if (!admins.has(uid)) continue;
    access[uid] = { ...devs, ...(access[uid] || {}) };
  }

  return { deviceGrants, access, userCompanies };
}

// Turns the projection into one multi-path update. Nodes are replaced
// wholesale (null when empty) rather than merged, because a merge can only
// ever add - it could never remove a member who was taken off a company.
function toUpdates(projection, { knownUids = [] } = {}) {
  const updates = {};

  for (const [deviceId, grants] of Object.entries(projection.deviceGrants)) {
    const v = Object.keys(grants.viewers).length ? grants.viewers : null;
    const o = Object.keys(grants.operators).length ? grants.operators : null;
    updates[`devices/${deviceId}/viewers`] = v;
    updates[`devices/${deviceId}/operators`] = o;
  }

  // Every uid that has ever had an index entry must be considered, or a
  // removed member keeps a stale access/ node pointing at devices they can
  // no longer read.
  const uids = new Set([...knownUids, ...Object.keys(projection.access), ...Object.keys(projection.userCompanies)]);
  for (const uid of uids) {
    const a = projection.access[uid];
    const c = projection.userCompanies[uid];
    updates[`access/${uid}`] = a && Object.keys(a).length ? a : null;
    updates[`userCompanies/${uid}`] = c && Object.keys(c).length ? c : null;
  }

  return updates;
}

module.exports = { computeProjection, toUpdates };
