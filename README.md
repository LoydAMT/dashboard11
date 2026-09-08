# RH-W Telemetry Dashboard

React frontend for the Wecon V-BOX RH-W pipeline. Reads from Firebase Realtime
Database, deploys to Firebase Hosting, viewable from anywhere.

```
bench PC (logger) ──outbound HTTPS──> Firebase RTDB <──reads── this dashboard
```

The dashboard never talks to the plant. It only reads Firebase, and it writes
nothing at all.

---

## Setup

Requires Node 18+ (built and tested on Node 22).

```
npm install
cp .env.example .env.local     # then fill it in
npm run dev
```

If `.env.local` is missing or incomplete the app renders a setup notice naming
the exact variables still to be filled, rather than a blank page.

### Environment variables

All live in `.env.local`, which is gitignored. Values come from the Firebase
console under **Project settings → General → Your apps → SDK setup and
configuration**.

| Variable | Notes |
|---|---|
| `VITE_FIREBASE_API_KEY` | |
| `VITE_FIREBASE_AUTH_DOMAIN` | `your-project.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | |
| `VITE_FIREBASE_APP_ID` | |
| `VITE_FIREBASE_DATABASE_URL` | Full RTDB URL **including region** |
| `VITE_DEVICE_ID` | Which `status/{id}` node to watch. Defaults to `RHW01` |

`VITE_FIREBASE_DATABASE_URL` must be the Realtime Database URL, not Firestore —
something like `https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app`.
Get it from **Build → Realtime Database**; the region matters and the SDK will
not guess it.

Vite reads env files only at startup, so restart `npm run dev` after editing.

None of these are secrets. A Firebase web config is public by design — it ships
in the bundle for anyone to read. What protects the data is `database.rules.json`.

---

## Deployment

Once, per machine:

```
npm install -g firebase-tools
firebase login
```

Set your project id in `.firebaserc` — the checked-in value is a placeholder:

```json
{ "projects": { "default": "your-firebase-project-id" } }
```

Then:

```
npm run build
firebase deploy --only hosting,database
```

`--only database` uploads `database.rules.json`. Deploy it at least once before
sharing the URL, or the default rules apply.

Before the first run, enable **Authentication → Sign-in method → Anonymous** in
the console. Sign-in fails without it and the dashboard will say so rather than
sitting empty.

---

## Security model

`database.rules.json` grants read to any authenticated user and denies every
client write:

- The logger writes through the **Admin SDK**, which bypasses rules entirely, so
  denying client writes costs the pusher nothing.
- Read requires `auth != null`. Today that is anonymous auth — a speed bump, not
  a wall, since anyone can mint an anonymous user. It keeps the database off the
  open internet and gives each session an identity to build on.

To move to real accounts: change `ensureSignedIn()` in [src/auth.js](src/auth.js)
to your chosen flow and tighten the read conditions in the rules. Nothing else
in the app inspects *how* a user signed in — it only waits for one, so the change
stays in those two files.

---

## What it does

**Tags are discovered, never declared.** The tag list is the union of the keys
under `latest/` and `tags/`. Adding process tags to the MQTT publish list is
enough; the dashboard needs no change. Tags configured in `tags/` but not yet
reporting are shown as awaiting data rather than hidden.

**Three connection states**, in precedence order — a broken link to Firebase
outranks anything the data appears to say:

| State | Meaning | Shown as |
|---|---|---|
| **Disconnected** | `.info/connected` is false | Red banner, heavier border, all values greyed |
| **Stale** | `lastSeen` older than the threshold, or `status.online` is false | Amber banner, values greyed, explicit "last updated N minutes ago" |
| **Live** | Connected, online, `lastSeen` recent | Green banner with a pulsing dot |

Plus two honest unknowns: **Connecting** (before `.info/connected` resolves) and
**No data** (connected, but the logger has never reported) — neither of which is
allowed to look like Live.

A stale number is never rendered as though it were current. Cards carry their own
freshness too, so one tag going quiet while the rest report normally is visible
on that card rather than only page-wide.

**Staleness is derived, not assumed.** The brief notes the 5 s publish interval
may change, so [useCadence](src/hooks/useCadence.js) measures how often `lastSeen`
actually advances and the threshold is 6× that median, clamped to 15 s–5 min. At
the nominal 5 s that gives exactly the ~30 s the brief specifies; if the pusher
slows to a write a minute, the window widens instead of alarming forever. The
median ignores the single huge gap an outage leaves behind, which a mean would
let mask real staleness for minutes afterwards.

**Limits.** A value outside `loLimit`/`hiLimit` colours the card and states which
bound it crossed. Limits are drawn on the chart as dashed reference lines and are
kept inside the axis domain so a breach is always in frame. Alarm styling is
suppressed on a stale card — an alarm colour on a frozen number would be wrong
twice over.

**Booleans render as states.** SQLite stores them as `1.0` / `0.0`; a tag with
`dataType: "bool"` shows an ON/OFF pill, never a number, and charts as a step
line on an ON/OFF axis.

**Timestamps** cross the wire as epoch milliseconds UTC and are converted to the
viewer's local zone for display only. Cards show relative age; tooltips and the
stale banner also give the absolute local time.

---

## Bandwidth

Bandwidth is the billed resource, so:

- `latest/`, `tags/` and `status/{device}` are live `onValue` subscriptions —
  push, never poll. After the first payload only changes come down.
- **History is fetched for the selected tag only.** Loading every tag's window at
  once would multiply cost by the tag count, and the tag count is expected to
  grow. Tapping a card selects it.
- History loads in two parts: one `get()` for the chosen window, then a
  `limitToLast(2)` listener for the leading edge. A live listener over the whole
  range re-downloads all of it on every reconnect, which is expensive on a phone
  moving between plant wifi and cellular.
- Seven days is 10,080 one-minute rollups per tag. The chart thins that to a few
  hundred points, but each plotted point keeps the true **min and max** of what it
  absorbed, drawn as a band behind the mean — averaging alone would erase exactly
  the brief excursion someone opened the chart to find.
- Gaps in the data are drawn as gaps. Recharts would otherwise interpolate a
  straight line across a logger outage, which is fiction.
- Recharts is lazy-loaded, so the cards paint before the chart library arrives:
  ~133 kB gzip initial, ~107 kB deferred.

---

## Project layout

```
src/
  firebase.js            app/database/auth handles, config validation
  auth.js                sign-in strategy — the only file that knows it's anonymous
  App.jsx                composition and layout
  lib/
    health.js            the three states and the staleness threshold
    tags.js              tag discovery, merging, limits, value formatting
    downsample.js        min/max-preserving thinning, gap insertion
    ranges.js            1h / 6h / 24h / 7d definitions and render budgets
    time.js              epoch-ms to local, relative ages
  hooks/
    useAuth.js           waits for a signed-in user
    useConnection.js     .info/connected
    useRtdbValue.js      generic onValue subscription
    useHistory.js        windowed backfill plus live tail
    useCadence.js        measures the real publish interval
    useNow.js            ticking clock, so silence is noticed
  components/
    StatusBanner.jsx     the page-level state
    TagCard.jsx          one tag, with its own freshness
    HistoryChart.jsx     trend with min/max band and limit lines
    RangePicker.jsx
    ConfigNotice.jsx     setup and error messages
```

The logic in `lib/` is pure — no React, no Firebase — so it can be exercised
directly. `useNow` is what makes the page notice silence: if the logger dies no
snapshot ever arrives, and a dashboard driven only by data events would sit there
showing a confident green badge indefinitely.

---

## Data contract

Built against section 3 of the brief, unchanged. `latest/{tagKey}`,
`history/{tagKey}/{minuteEpoch}` as `{min, avg, max, n}`, `status/{deviceId}` as
`{lastSeen, online, loggerStarted}`, and `tags/{tagKey}` as
`{name, unit, description, loLimit, hiLimit, dataType}`.

Tag keys are the sanitised form (`d_Test1`); `tags/{tagKey}/name` holds the
original (`d/Test1`) and is what gets displayed.

**No schema changes are needed.** Three notes for whoever writes the pusher:

1. **`history` keys must stay 13-digit epoch-ms strings.** They exceed the 32-bit
   range RTDB treats as numeric, so `orderByKey` compares them as strings.
   Equal-length digit strings compare identically either way, which is what makes
   `startAt(String(since))` correct — and epoch-ms stays 13 digits until 2286.
   Zero-padding or a different key width would silently break range queries.

2. **Write `history/{tagKey}/{minuteEpoch}` with `n`.** Present in the contract
   and already handled; the chart weights its averages by it, so a minute with 12
   samples doesn't carry the same weight as one with 2. Missing `n` is treated
   as 1.

3. **`status.online` is trusted to say "down", not to say "up".** If the pusher
   dies mid-write the flag stays `true` forever, so freshness is judged from
   `lastSeen` regardless. Set `online: false` on a clean shutdown if you can — it
   makes the state explicit rather than inferred — but nothing depends on it.

`latest/{tagKey}/unit` is read as a fallback when `tags/` has no entry for a tag
yet, so a newly registered tag still shows its unit before metadata catches up.

---

## Commands

```
npm run dev       dev server with HMR
npm run build     production build into dist/
npm run preview   serve the built bundle locally
npm run lint      oxlint
```
