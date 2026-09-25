/**
 * The one way back out of a sub-page.
 *
 * Top-left and labelled with WHERE it goes, not just "Back". There are three
 * levels now - device dashboard, mall wall, mall-wide log - and a bare
 * "Back" leaves someone guessing which of them they will land on. Styled as
 * a quiet link rather than a boxed button: it is navigation, and it should
 * not compete with the page's own controls for attention.
 */
export function BackButton({ onClick, children = 'Back' }) {
  return (
    <button type="button" className="back-link" onClick={onClick}>
      <svg className="back-link-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8"
              strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>{children}</span>
    </button>
  )
}
