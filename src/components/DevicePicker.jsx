/**
 * Shown only when an account has access to more than one device - the common
 * case (exactly one) skips this entirely and goes straight to the dashboard.
 * Device id is enough of a label for now; nothing in the data model gives a
 * device its own display name yet.
 */
export function DevicePicker({ devices, onSelect }) {
  return (
    <div className="notice notice-info device-picker">
      <h2>Choose a device</h2>
      <p>This account has access to more than one.</p>
      <div className="device-picker-list">
        {devices.map((d) => (
          <button
            key={d.id}
            type="button"
            className="device-picker-item"
            onClick={() => onSelect(d.id)}
          >
            {d.id}
          </button>
        ))}
      </div>
    </div>
  )
}
