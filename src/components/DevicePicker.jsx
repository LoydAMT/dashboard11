import { useDeviceName } from '../hooks/useDeviceName'

/**
 * Shown only when an account has access to more than one device - the common
 * case (exactly one) skips this entirely and goes straight to the dashboard.
 *
 * A custom name (set at /naming, shared with every signed-in account - see
 * hooks/useDeviceName.js) fully replaces the raw id here: once a device is
 * renamed the id does not appear anywhere in the UI. The id still lives on
 * in every path, rule and export filename, just not on screen.
 */
export function DevicePicker({ devices, onSelect }) {
  return (
    <div className="notice notice-info device-picker">
      <h2>Choose a device</h2>
      <p>This account has access to more than one.</p>
      <div className="device-picker-list">
        {devices.map((d) => (
          <DevicePickerItem key={d.id} deviceId={d.id} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

// Its own component, not inlined in the map above, because each row needs
// its own naming/{deviceId} subscription - one hook call per device, which a
// loop body cannot do directly without breaking the rule that a component's
// hook calls happen in the same order every render.
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
