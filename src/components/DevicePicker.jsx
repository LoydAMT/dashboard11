import { useCallback, useEffect, useState } from 'react'
import { useDeviceName } from '../hooks/useDeviceName'
import { useCompany } from '../hooks/useCompanies'

/**
 * Shown only when an account has access to more than one device - the common
 * case (exactly one) skips this entirely and goes straight to the dashboard.
 *
 * Devices are grouped by company when the account belongs to any. Grouping is
 * presentation only: `devices` is still the authoritative list, from
 * access/{uid}, and a device is never shown because a company claims it -
 * only because the account actually has it. That ordering matters. If the
 * company list and the access list ever disagree, the narrower one wins and
 * the device simply appears ungrouped rather than being offered and then
 * refused on click.
 *
 * An admin typically belongs to no company at all (admins/ grants every
 * device directly), so they see a flat list - which is the correct view for
 * someone whose access is not company-derived.
 *
 * A custom name (set at /naming, shared with every signed-in account - see
 * hooks/useDeviceName.js) fully replaces the raw id here: once a device is
 * renamed the id does not appear anywhere in the UI. The id still lives on
 * in every path, rule and export filename, just not on screen.
 */
export function DevicePicker({ devices, companyIds = [], onSelect }) {
  const grouped = companyIds.length > 0

  return (
    <div className="notice notice-info device-picker">
      <h2>Choose a device</h2>
      <p>This account has access to more than one.</p>

      {grouped ? (
        <CompanyGroups devices={devices} companyIds={companyIds} onSelect={onSelect} />
      ) : (
        <div className="device-picker-list">
          {devices.map((d) => (
            <DevicePickerItem key={d.id} deviceId={d.id} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

function CompanyGroups({ devices, companyIds, onSelect }) {
  const allowed = new Set(devices.map((d) => d.id))

  // Which devices each company claims, reported upward by the groups
  // themselves. It is collected here rather than by calling useCompany once
  // per id in a loop: companyIds can change length at runtime (the
  // projection function rewrites userCompanies/{uid} whenever membership
  // changes), and a hook whose call count varies between renders crashes
  // React outright.
  const [claimedBy, setClaimedBy] = useState({})

  const report = useCallback((companyId, deviceIds) => {
    setClaimedBy((prev) => {
      const before = prev[companyId]
      if (before && before.length === deviceIds.length
          && before.every((d, i) => d === deviceIds[i])) {
        return prev                        // no change - do not re-render
      }
      return { ...prev, [companyId]: deviceIds }
    })
  }, [])

  const claimed = new Set()
  for (const ids of Object.values(claimedBy)) for (const d of ids) claimed.add(d)
  const rest = devices.filter((d) => !claimed.has(d.id))

  return (
    <>
      {companyIds.map((id) => (
        <CompanyGroup
          key={id}
          companyId={id}
          allowed={allowed}
          onSelect={onSelect}
          onDevices={report}
        />
      ))}

      {/* Anything reachable that no company of theirs claims. Normally
          empty; it exists so a device can never become invisible merely
          because its company membership is missing or still propagating. */}
      {rest.length > 0 && (
        <div className="device-picker-group">
          <h3 className="device-picker-group-name">Other</h3>
          <div className="device-picker-list">
            {rest.map((d) => (
              <DevicePickerItem key={d.id} deviceId={d.id} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}
    </>
  )
}

// Its own component, not inlined in the map above, because each company needs
// its own companies/{id} subscription - one hook call per company, which a
// loop body cannot do without breaking the rule that a component's hook calls
// happen in the same order every render. Same reason DevicePickerItem exists.
function CompanyGroup({ companyId, allowed, onSelect, onDevices }) {
  const { name, deviceIds } = useCompany(companyId)

  // Report what this company claims, so the parent can work out which
  // devices no company covers. Reported even when the intersection below is
  // empty - a claim the account cannot act on is still a claim, and leaving
  // it out would list the device twice under "Other".
  useEffect(() => {
    onDevices(companyId, deviceIds)
  }, [companyId, deviceIds, onDevices])

  // Intersected with what the account actually has. A company listing a
  // device this account cannot read must not put a button on screen that
  // fails when pressed.
  const visible = deviceIds.filter((id) => allowed.has(id))
  if (visible.length === 0) return null

  return (
    <div className="device-picker-group">
      <h3 className="device-picker-group-name">{name}</h3>
      <div className="device-picker-list">
        {visible.map((id) => (
          <DevicePickerItem key={id} deviceId={id} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}


function DevicePickerItem({ deviceId, onSelect }) {
  const { name } = useDeviceName(deviceId)

  return (
    <button
      type="button"
      className="device-picker-item"
      onClick={() => onSelect(deviceId)}
    >
      {name}
    </button>
  )
}
