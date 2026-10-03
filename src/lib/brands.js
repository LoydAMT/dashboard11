// Client logos shown beside the Instrubyte mark in the masthead, per device.
//
// Keyed by device id, so they appear only while that device's dashboard is
// open - never on another client's meters, and never on the demo boxes. A
// device not listed here shows the Instrubyte mark alone, as before.
//
// The images live in public/logo/<client>/. They are trimmed copies of the
// originals in the same folders: the source files carry wide white margins
// that would shrink the actual mark to a speck at header height.

const DEVICE_BRANDS = {
  'UMPD-MCWD': [
    { src: '/logo/pwri/pwri.png', alt: 'Pilipinas Water Resources Inc' },
    { src: '/logo/mcwd/mcwd.png', alt: 'Metro Cebu Water District' },
  ],
}

const NONE = []

/** Logos for a device, in display order. Always an array, possibly empty. */
export function brandsFor(deviceId) {
  return (deviceId && DEVICE_BRANDS[deviceId]) || NONE
}
