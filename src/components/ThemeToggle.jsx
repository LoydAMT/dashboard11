/**
 * Explicit light/dark switch, shown only once signed in - a visitor on the
 * sign-in screen has no session worth persisting a preference against, and
 * the system default already renders correctly for them either way.
 */
export function ThemeToggle({ theme, onChange }) {
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      <button
        type="button"
        className={`theme-btn ${theme === 'light' ? 'theme-active' : ''}`}
        aria-pressed={theme === 'light'}
        onClick={() => onChange('light')}
        title="Light theme"
      >
        <SunIcon />
      </button>
      <button
        type="button"
        className={`theme-btn ${theme === 'dark' ? 'theme-active' : ''}`}
        aria-pressed={theme === 'dark'}
        onClick={() => onChange('dark')}
        title="Dark theme"
      >
        <MoonIcon />
      </button>
    </div>
  )
}

function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="2" />
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 2v2.2M12 19.8V22M4.2 4.2l1.55 1.55M18.25 18.25l1.55 1.55M2 12h2.2M19.8 12H22M4.2 19.8l1.55-1.55M18.25 5.75l1.55-1.55" />
      </g>
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z"
        fill="currentColor"
      />
    </svg>
  )
}
