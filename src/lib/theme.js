// Theme primitives, kept framework-free so the no-flash inline script in
// index.html and this app agree on the exact same rules for where the choice
// lives and how it falls back.

const KEY = 'rhw-theme' // 'light' | 'dark' in storage; absent means "follow system"

export function storedTheme() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

export function storeTheme(theme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // Private browsing or storage disabled: the toggle still works for this
    // load, it just does not survive a reload.
  }
}

export function systemTheme() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
}
