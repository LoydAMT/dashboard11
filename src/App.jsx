import { lazy, Suspense, useMemo, useState } from 'react'
import { missingConfig } from './firebase'
import { useAuth } from './hooks/useAuth'
import { useDeviceAccess } from './hooks/useDeviceAccess'
import { useConnection } from './hooks/useConnection'
import { useRtdbValue } from './hooks/useRtdbValue'
import { useCadence } from './hooks/useCadence'
import { useSeriesHistory } from './hooks/useSeriesHistory'
import { useNow } from './hooks/useNow'
import { systemState, stalenessThreshold, tagStalenessThreshold, isStaleLevel } from './lib/health'
import { discoverTagKeys, buildTag, formatValue, displayUnit } from './lib/tags'
import { colorForIndex, MAX_SERIES } from './lib/palette'
import { mergeSeries } from './lib/series'
import { rangeById, DEFAULT_RANGE, isRawRange } from './lib/ranges'
import { buildTable } from './lib/table'
import { StatusBanner } from './components/StatusBanner'
import { TagCard } from './components/TagCard'
import { RangePicker } from './components/RangePicker'
import { ChartLegend } from './components/ChartLegend'
import { ConfigNotice, ErrorNotice } from './components/ConfigNotice'
import { DataTable } from './components/DataTable'
import { VfdControl } from './components/VfdControl'
import { SignIn } from './components/SignIn'
import { DevicePicker } from './components/DevicePicker'
import { signOutUser } from './auth'

// Recharts is by far the heaviest thing in the bundle and none of it is needed
// to answer the question the page exists to answer: what is the value right
// now, and can I trust it. Cards paint on the first chunk; the chart library
// arrives behind them. On plant wifi that is the difference between a readable
// screen and a spinner.
const HistoryChart = lazy(() =>
  import('./components/HistoryChart').then((m) => ({ default: m.HistoryChart })),
)

export default function App() {
  if (missingConfig.length) {
    return (
      <div className="app">
        <Masthead />
        <ConfigNotice missing={missingConfig} />
      </div>
    )
  }
  return <Dashboard />
}

function Dashboard() {
  const { user, resolved, realUser } = useAuth()

  // access/{uid} - navigation data, not the security boundary (see
  // database.rules.json). Only ever asked for once there is a real identity
  // to ask it about.
  const deviceAccess = useDeviceAccess(realUser ? user : null)

  const [chosenDeviceId, setChosenDeviceId] = useState(null)

  // Auto-select the common case (exactly one device) without ever showing a
  // picker for it. A previously chosen device that has fallen out of the
  // access list (revoked mid-session) is not trusted just because state still
  // remembers it - falls back to auto-select, or back to the picker.
  const autoDeviceId = deviceAccess.devices.length === 1 ? deviceAccess.devices[0].id : null
  const chosenStillValid = deviceAccess.devices.some((d) => d.id === chosenDeviceId)
  const deviceId = (chosenStillValid ? chosenDeviceId : null) || autoDeviceId
  const role = deviceAccess.devices.find((d) => d.id === deviceId)?.role || null

  // Whether *this* device's data may be read. Distinct from `realUser`: a
  // real, authorized-somewhere account can still have no device selected yet
  // (the picker is showing) or lack access to this specific one.
  const ready = Boolean(deviceId)
  // Viewers and operators are treated identically this pass (VFD control is a
  // separate one) - `role` itself stays available so narrowing this to
  // `role === 'operator'` later is a one-line change, not a re-plumb.
  const mayControl = Boolean(role)

  // `.info/connected` is local to the SDK, so it is watched regardless of auth.
  const connected = useConnection()

  // Data reads wait for a resolved device; the rules would reject them
  // otherwise, and there is nothing to build a path from before then anyway.
  const latest = useRtdbValue(deviceId ? `devices/${deviceId}/latest` : null, ready)
  const tags = useRtdbValue(deviceId ? `devices/${deviceId}/tags` : null, ready)
  const status = useRtdbValue(deviceId ? `devices/${deviceId}/status` : null, ready)

  const now = useNow(1000)

  // The window edge only has to advance often enough for old points to fall
  // off; re-merging every series once a second would be waste.
  const coarseNow = useNow(30_000)

  // Measured publish cadence, not the assumed 5s.
  const periodMs = useCadence(status.data?.lastSeen)
  const thresholdMs = stalenessThreshold(periodMs)

  const state = useMemo(
    () => systemState({
      connected,
      status: status.data,
      nowMs: now,
      thresholdMs,
      authReady: ready,
    }),
    [connected, status.data, now, thresholdMs, ready],
  )

  const systemStale = isStaleLevel(state.level)

  // Tags are discovered from the data. Nothing here knows there are two.
  const tagList = useMemo(() => {
    const keys = discoverTagKeys(latest.data, tags.data)
    return keys.map((k) => buildTag(k, latest.data?.[k], tags.data?.[k]))
  }, [latest.data, tags.data])

  // Colour is fixed to the tag, by its place in the full discovered list — not
  // by its rank among the visible series. Hiding one trend must not repaint the
  // ones left behind, or the eye has to re-learn the chart on every toggle.
  const colors = useMemo(
    () => Object.fromEntries(tagList.map((t, i) => [t.key, colorForIndex(i)])),
    [tagList],
  )

  const [pickedKeys, setPickedKeys] = useState([])
  const [indexed, setIndexed] = useState(false)
  const [view, setView] = useState('chart')
  const [rangeId, setRangeId] = useState(DEFAULT_RANGE.id)
  const range = rangeById(rangeId)
  const rawView = isRawRange(range)

  // Derived rather than stored, for the same reason the single selection was:
  // the chart defaults to the first tag until someone chooses, and recovers by
  // itself if a shown tag stops being published. Holding the resolved list in
  // state would need an effect to repair it, and would render one frame
  // pointing at a tag that no longer exists.
  const visibleKeys = useMemo(() => {
    const live = pickedKeys.filter((k) => tagList.some((t) => t.key === k))
    if (live.length) return live
    // An explicit empty selection is a choice; only seed the default before one
    // has been made.
    if (pickedKeys.length) return []
    return tagList[0] ? [tagList[0].key] : []
  }, [pickedKeys, tagList])

  const visibleTags = useMemo(
    () => tagList.filter((t) => visibleKeys.includes(t.key)),
    [tagList, visibleKeys],
  )

  const atCapacity = visibleTags.length >= MAX_SERIES

  const toggleTag = (key) => {
    const next = visibleKeys.includes(key)
      ? visibleKeys.filter((k) => k !== key)
      : visibleKeys.length >= MAX_SERIES
        ? visibleKeys
        // Rebuilt in discovery order so the legend, the colours and the draw
        // order all agree however the tags were picked.
        : tagList.filter((t) => visibleKeys.includes(t.key) || t.key === key).map((t) => t.key)

    // A cleared selection has to be recorded as a real choice, not fall back to
    // the default; the sentinel is what tells visibleKeys the difference.
    setPickedKeys(next.length ? next : [CLEARED])
  }

  const single = visibleTags.length === 1 ? visibleTags[0] : null

  // Indexing is only meaningful across several trends, and its control is only
  // offered then — so it must not survive being hidden down to one series, or
  // the axis would stay in percent with no visible way back to real values.
  const indexedNow = indexed && visibleTags.length > 1

  // History is fetched per shown trend, and only for shown trends: hiding one
  // drops its listener. The billed bandwidth scales with what is on screen.
  // Tags, not bare keys — each one's own intervalMs decides whether its
  // history is read as minute rollups or as raw samples (see
  // useSeriesHistory), and a bare key has no interval to make that call with.
  const history = useSeriesHistory(visibleTags, range, deviceId, ready && visibleKeys.length > 0)

  const merged = useMemo(
    () => mergeSeries({
      byKey: history.byKey,
      keys: visibleKeys,
      range,
      nowMs: coarseNow,
      indexed: indexedNow,
    }),
    [history.byKey, visibleKeys, range, coarseNow, indexedNow],
  )

  const singleStats = single ? merged.stats[single.key] : null

  // Built from the raw rollups rather than the chart's downsampled rows, and
  // only while the table is the thing on screen: aligning ten thousand minutes
  // across four tags is not work to do on every tick of a chart nobody is
  // looking away from.
  const table = useMemo(
    () => (view === 'table'
      ? buildTable({
          byKey: history.byKey,
          tags: visibleTags,
          range,
          nowMs: coarseNow,
        })
      : EMPTY_TABLE),
    [view, history.byKey, visibleTags, range, coarseNow],
  )

  const dataError = latest.error || tags.error || status.error

  // Every data-fetching hook above is already called unconditionally on every
  // render regardless of auth state - each one's own `enabled` argument (fed
  // by `ready`) is what actually keeps it idle before this gate opens. So the
  // gate below only ever decides what gets *rendered*, never which hooks get
  // *called* - the one thing that would break the rules of hooks.
  return (
    <div className="app">
      <Masthead
        deviceId={ready ? deviceId : null}
        periodMs={periodMs}
        email={ready ? user?.email : null}
        onSignOut={signOutUser}
      />

      {!resolved && (
        <div className="notice notice-info">
          <h2>Loading…</h2>
          <p>Checking your session.</p>
        </div>
      )}

      {resolved && !realUser && <SignIn />}

      {resolved && realUser && deviceAccess.loading && (
        <div className="notice notice-info">
          <h2>Checking access…</h2>
          <p>Looking up which devices this account can see.</p>
        </div>
      )}

      {resolved && realUser && !deviceAccess.loading && deviceAccess.devices.length === 0 && (
        <NotAuthorized email={user?.email} onSignOut={signOutUser} />
      )}

      {resolved && realUser && !deviceAccess.loading && deviceAccess.devices.length > 1 && !deviceId && (
        <DevicePicker devices={deviceAccess.devices} onSelect={setChosenDeviceId} />
      )}

      {ready && (
        <>
        <StatusBanner state={state} status={status.data} />

        {/* mayControl reflects this device's role (viewer or operator both
            pass, per the spec - see the note where it is computed above).
            authResolved is always true here, since VfdControl only ever
            renders once `ready` (a resolved device) is true; kept as a prop
            so its own "checking session" copy stays correct if it is ever
            reused somewhere reachable before this gate. */}
        <VfdControl deviceId={deviceId} mayControl={mayControl} authResolved />
  
        {dataError && <ErrorNotice title="Could not read the database" error={dataError} />}
  
        {!dataError && tagList.length === 0 && (
          <div className="notice">
            <h2>{latest.loading ? 'Loading tags…' : 'No tags yet'}</h2>
            <p>
              {latest.loading
                ? 'Waiting for the first read.'
                : `Nothing under devices/${deviceId}/latest or tags/. The dashboard
                   discovers tags from the data, so they will appear here as soon as
                   the pusher writes them — no change needed on this side.`}
            </p>
          </div>
        )}
  
        {tagList.length > 0 && (
          <div className="grid">
            {tagList.map((tag) => {
              // A tag is stale if the link is down, or if this particular tag has
              // stopped reporting on its *own* schedule - a 12-hour accumulator
              // six hours quiet is not due yet, so it is judged against its own
              // interval, never the device-wide one.
              const ownAge = tag.ts != null ? now - tag.ts : null
              const tagThresholdMs = tagStalenessThreshold(tag.intervalMs)
              const tagStale = systemStale || ownAge == null || ownAge > tagThresholdMs
              const shown = visibleKeys.includes(tag.key)
  
              return (
                <TagCard
                  key={tag.key}
                  tag={tag}
                  stale={tagStale}
                  shown={shown}
                  color={colors[tag.key]}
                  blocked={!shown && atCapacity}
                  maxSeries={MAX_SERIES}
                  onSelect={toggleTag}
                  nowMs={now}
                />
              )
            })}
          </div>
        )}
  
        {tagList.length > 0 && (
          <section className="panel">
            <div className="panel-head">
              <div>
                <div className="panel-title">
                  {single ? single.name : `${visibleTags.length} trends`}
                </div>
                <div className="panel-sub">
                  {rawView
                    ? (view === 'table'
                        ? 'Every raw reading in the window, newest first — unaggregated'
                        : single
                          ? (single.description || 'Raw readings, unaggregated')
                          : 'Raw readings, unaggregated · tap a card or a legend entry to add or remove a trend')
                    : (view === 'table'
                        ? 'Every one-minute rollup in the window, newest first'
                        : single
                          ? (single.description ||
                             (single.unit ? `Unit: ${single.unit}` : 'One-minute rollups'))
                          : 'One-minute rollups · tap a card or a legend entry to add or remove a trend')}
                </div>
              </div>
  
              <div className="panel-controls">
                <div className="ranges" role="group" aria-label="View">
                  <button
                    type="button"
                    className={`range-btn ${view === 'chart' ? 'range-active' : ''}`}
                    aria-pressed={view === 'chart'}
                    onClick={() => setView('chart')}
                  >
                    Chart
                  </button>
                  <button
                    type="button"
                    className={`range-btn ${view === 'table' ? 'range-active' : ''}`}
                    aria-pressed={view === 'table'}
                    onClick={() => setView('table')}
                  >
                    Table
                  </button>
                </div>
  
                {view === 'chart' && visibleTags.length > 1 && (
                  <div className="ranges" role="group" aria-label="Value axis">
                    {/* Two measures of different magnitude on one axis flattens
                        the smaller into the baseline. A second y-axis would be
                        the usual reflex and is the wrong answer — it lets the
                        author place any two lines anywhere relative to each
                        other. Indexing each trend against its own range keeps a
                        single honest axis, and the tooltip still quotes the real
                        values. */}
                    <button
                      type="button"
                      className={`range-btn ${indexed ? '' : 'range-active'}`}
                      aria-pressed={!indexed}
                      onClick={() => setIndexed(false)}
                    >
                      Actual
                    </button>
                    <button
                      type="button"
                      className={`range-btn ${indexed ? 'range-active' : ''}`}
                      aria-pressed={indexed}
                      onClick={() => setIndexed(true)}
                      title="Plot each trend as a percentage of its own range in this window"
                    >
                      Indexed
                    </button>
                  </div>
                )}
                <RangePicker value={rangeId} onChange={setRangeId} />
              </div>
            </div>
  
            {/* Summary figures are for a single measurement. Across an overlay
                they would need a column each, and the mean of a boolean is 0.5 as
                often as not, which formatValue would render as ON. */}
            {singleStats && single.dataType !== 'bool' && single.dataType !== 'text' && (
              <dl className="stats" aria-label={`${single.name} over the last ${range.label}`}>
                <Stat label="min" tag={single} value={singleStats.min} />
                <Stat label="mean" tag={single} value={singleStats.avg} />
                <Stat label="max" tag={single} value={singleStats.max} />
                <Stat label="now" tag={single} value={single.value} live />
              </dl>
            )}
  
            {view === 'table' ? (
              <DataTable
                columns={table.columns}
                groups={table.groups}
                rows={table.rows}
                colors={colors}
                range={range}
                deviceId={deviceId}
                loading={history.loading}
                error={history.error}
              />
            ) : (
              <Suspense
                fallback={<div className="chart-wrap"><div className="placeholder">Loading chart…</div></div>}
              >
                <HistoryChart
                  tags={visibleTags}
                  colors={colors}
                  data={merged.rows}
                  rangeMs={range.ms}
                  raw={rawView}
                  indexed={indexedNow}
                  loading={history.loading}
                  error={history.error}
                />
              </Suspense>
            )}
  
            <ChartLegend
              tags={tagList}
              visible={visibleKeys}
              colors={colors}
              onToggle={toggleTag}
              atCapacity={atCapacity}
              maxSeries={MAX_SERIES}
            />
          </section>
        )}
  
        <footer className="footnote">
          Values are one-minute rollups from {deviceId}; timestamps shown in your
          local time. Staleness threshold {Math.round(thresholdMs / 1000)}s, derived
          from an observed publish interval of {formatInterval(periodMs)}.
          {' '}History is loaded only for the trends on the chart, up to {MAX_SERIES} at once.
        </footer>
        </>
      )}
    </div>
  )
}

// Stands in for "the user has chosen to show nothing", which an empty array
// cannot express without being mistaken for "no choice made yet". A forward
// slash is the one character an RTDB key can never contain, so this can never
// collide with a real tag and always resolves to an empty visible list.
const CLEARED = '/cleared'

// A stable identity for "no table built", so the memo below it does not hand
// the component a fresh empty object on every chart tick.
const EMPTY_TABLE = { columns: [], groups: [], rows: [] }

/**
 * One figure from the selected window. `live` marks the only one of the four
 * that is a present-tense reading rather than a summary of the range, because a
 * row of four numbers with no such distinction invites reading the mean as the
 * current value.
 */
function Stat({ label, tag, value, live = false }) {
  const unit = displayUnit(tag)
  const text = value == null
    ? '—'
    : formatValue({ value, dataType: tag.dataType })

  return (
    <div className={`stat${live ? ' stat-live' : ''}`}>
      <dt>{label}</dt>
      <dd>
        {text}
        {unit && value != null && <span className="stat-unit">{unit}</span>}
      </dd>
    </div>
  )
}

function Masthead({ deviceId, periodMs, email, onSignOut }) {
  return (
    <header className="masthead">
      <div className="masthead-brand">
        {/* Decorative: the wordmark beside it already names the company, so a
            screen reader gaining nothing from "image" would only add noise. */}
        <img className="masthead-logo" src="/favicon-48.png" alt="" aria-hidden="true" />
        <div className="masthead-text">
          <h1>INSTRUBYTE</h1>
          <span className="masthead-tagline">Telemetry</span>
        </div>
      </div>
      <div className="masthead-right">
        {deviceId && (
          <span className="device">
            {deviceId}
            {periodMs ? ` · every ${formatInterval(periodMs)}` : ''}
          </span>
        )}
        {/* Only a signed-in, authorized session ever gets an email to show -
            App.jsx passes null on every other screen, sign-in form included,
            where there is nothing yet to sign out of. */}
        {email && (
          <button type="button" className="signout-btn" onClick={onSignOut} title={email}>
            Sign out
          </button>
        )}
      </div>
    </header>
  )
}

/**
 * A real, non-anonymous sign-in with no entries under access/{uid} - not on
 * any device's viewers or operators list yet. Distinct from the sign-in
 * form: the password was correct, an administrator simply has not granted
 * this account a device yet - a normal, expected state with manual,
 * out-of-band provisioning (see database.rules.json), not an error.
 */
function NotAuthorized({ email, onSignOut }) {
  return (
    <div className="notice notice-info">
      <h2>No device access yet</h2>
      <p>
        {email ? <>The account <code>{email}</code> is</> : 'This account is'}{' '}
        signed in, but has not been granted access to any device. Contact
        whoever administers this dashboard to be added.
      </p>
      <button type="button" className="signout-btn" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  )
}

const formatInterval = (ms) =>
  ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
