// TEMPORARY visual check - deleted after the screenshot is taken.
import { createRoot } from 'react-dom/client'
import './index.css'
import { TagCard } from './components/TagCard'
import { brandsFor } from './lib/brands'

if (new URLSearchParams(location.search).has('dark')) {
  document.documentElement.dataset.theme = 'dark'
}

const now = Date.now()
const mk = (key, name, value, unit, extra = {}) => ({
  key, name, value, unit, dataType: 'num', hasReading: true, ts: now,
  loLimit: null, hiLimit: null, ...extra,
})
const around = (v, s) => Array.from({ length: 40 }, (_, i) => v + Math.sin(i) * s)

const cards = [
  [mk('Conductivity', 'Conductivity', 868.09, 'µS/cm'), around(867, 17)],
  [mk('FlowRateA', 'FlowRateA', 205.3, 'm³/h'), around(206, 4)],
  [mk('pH', 'pH', 7.88, 'pH'), around(7.85, 0.15)],
  [mk('Turbidity', 'Turbidity', 0.12, 'NTU'), around(0.12, 0.002)],
  [mk('TotalizerA', 'TotalizerA', 1259520, 'm³'), around(1259503, 25000)],
  [mk('Voltage', 'Voltage (alert set)', 231.1, 'V', { loLimit: 207, hiLimit: 240 }), []],
  [mk('Hot', 'Over threshold', 243.2, 'V', { loLimit: 207, hiLimit: 240 }), []],
  [mk('TotalizerB', 'TotalizerB (dial off)', 1204288, 'm³', { gaugeOff: true }), around(1204279, 24000)],
]

function Harness() {
  const partners = brandsFor('UMPD-MCWD')
  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-brand">
          <img className="masthead-logo" src="/favicon-48.png" alt="" />
          <div className="masthead-text">
            <h1>INSTRUBYTE</h1>
            <span className="masthead-tagline">Telemetry</span>
          </div>
          <div className="masthead-partners">
            {partners.map((p) => (
              <img key={p.src} className="masthead-partner" src={p.src} alt={p.alt} />
            ))}
          </div>
        </div>
      </header>
      <div className="grid">
        {cards.map(([tag, samples]) => (
          <TagCard key={tag.key} tag={tag} stale={false} shown={false} color="var(--series-1)"
                   blocked={false} maxSeries={4} onSelect={() => {}} nowMs={now} samples={samples} />
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
