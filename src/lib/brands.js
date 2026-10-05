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
  'ayala-box1-1': AYALA_CENTRAL_BLOC,
  'ayala-box1-2': AYALA_CENTRAL_BLOC,
  'ayala-box1-3': AYALA_CENTRAL_BLOC,
}

const COMPANY_BRANDS = {
  'ayala-box1': AYALA_CENTRAL_BLOC,
}

const NONE = []

/** Logos for a device, in display order. Always an array, possibly empty. */
export function brandsFor(deviceId) {
  return (deviceId && DEVICE_BRANDS[deviceId]) || NONE
}

/** Logos for a company's overview page. Always an array, possibly empty. */
export function brandsForCompany(companyId) {
  return (companyId && COMPANY_BRANDS[companyId]) || NONE
}
