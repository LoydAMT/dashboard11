// Client logos shown beside the Instrubyte mark in the masthead.
//
// Keyed by device id, so they appear only while that device's dashboard is
// open - never on another client's meters, and never on the demo boxes. A
// device not listed here shows the Instrubyte mark alone, as before.
//
// A box that serves several meters is also keyed by its company id, so the
// same logo stays up on that company's overview page, where no single meter
// is open.
//
// The images live in public/logo/<client>/. They are trimmed copies of the
// originals in the same folders: the source files carry wide white margins
// that would shrink the actual mark to a speck at header height.
//
// A logo is drawn on a small white plate unless it is marked `bare`, which
// is for an image with a transparent background whose colours hold up on
// both the light and the dark page.

const AYALA_CENTRAL_BLOC = [
  // ?v= because the file was replaced in place (it used to be on white), and
  // a browser holding the old one would keep showing a white box.
  { src: '/logo/ayalamalls/ayalamalls.png?v=2', alt: 'Ayala Malls Central Bloc', bare: true },
]

const DEVICE_BRANDS = {
  'UMPD-MCWD': [
    { src: '/logo/pwri/pwri.png', alt: 'Pilipinas Water Resources Inc' },
    { src: '/logo/mcwd/mcwd.png', alt: 'Metro Cebu Water District' },
  ],
}

// Every meter on a box, however many it reads - box 1 grew from 3 meters to
// 23, and listing them one by one left the newer ones without the logo.
const PREFIX_BRANDS = [
  ['ayala-box1-', AYALA_CENTRAL_BLOC],
  ['ayala-box2-', AYALA_CENTRAL_BLOC],
]

const COMPANY_BRANDS = {
  'ayala-box1': AYALA_CENTRAL_BLOC,
  'amcb-4th-floor-zone-3': AYALA_CENTRAL_BLOC,
}

const NONE = []

/** Logos for a device, in display order. Always an array, possibly empty. */
export function brandsFor(deviceId) {
  if (!deviceId) return NONE
  if (DEVICE_BRANDS[deviceId]) return DEVICE_BRANDS[deviceId]
  const hit = PREFIX_BRANDS.find(([prefix]) => deviceId.startsWith(prefix))
  return hit ? hit[1] : NONE
}

/** Logos for a company's overview page. Always an array, possibly empty. */
export function brandsForCompany(companyId) {
  return (companyId && COMPANY_BRANDS[companyId]) || NONE
}
