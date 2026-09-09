export function ConfigNotice({ missing }) {
  return (
    <div className="notice">
      <h2>Firebase is not configured</h2>
      <p>
        Copy <code>.env.example</code> to <code>.env.local</code> and fill in the
        values from the Firebase console, then restart the dev server. Vite reads
        env files only at startup.
      </p>
      <p>Missing:</p>
      <ul>{missing.map((k) => <li key={k}><code>{k}</code></li>)}</ul>
    </div>
  )
}

export function ErrorNotice({ title, error }) {
  const denied = error?.code === 'PERMISSION_DENIED' ||
    /permission_denied/i.test(error?.message || '')

  return (
    <div className="notice">
      <h2>{title}</h2>
      <p>{error?.message || String(error)}</p>
      {denied && (
        <p>
          The database rules are rejecting this read. Deploy them with{' '}
          <code>firebase deploy --only database</code>, and confirm this
          account's uid is present under <code>devices/&#123;deviceId&#125;/viewers</code>{' '}
          or <code>operators</code> in the database.
        </p>
      )}
    </div>
  )
}
