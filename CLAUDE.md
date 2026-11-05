# Instrubyte Telemetry

Electricity and process monitoring: Wecon V-BOX / RH-W gateways run a Lua script (`fbpush`) that reads Modbus meters and writes straight to Firebase Realtime Database (project `testononlinedb`, asia-southeast1). Cloud Functions in `functions/` archive history to Firestore, file alerts, send Telegram messages and build mall summaries. The React + Vite website in `src/` is deployed by Vercel from `main` (www.instrubytemonitoring.com).

## Keep the system guide up to date — always

The full explanation of how everything is built lives outside this repo, in:

`C:\Users\Star 15\Desktop\Instrubyte Telemetry - How It Is Built\`

**Whenever you change anything below, update the matching guide file in the same piece of work, and add a dated line to `13 - Change log and key decisions.md`.** Don't wait to be asked; a change isn't finished until the guide matches it. Update `00 - START HERE.md`'s "Last updated" date too.

| If you change… | Update |
|---|---|
| A box Lua script (`Desktop\Box scripts\...`; deployed ones in `1 - DEPLOYED - on the boxes now\<box>\`), its settings, registers, timers or generators | `02 - Wecon box Lua scripts.md`, and `03 - Meters and Modbus registers.md` for addresses; copy changed generators into `tools\` |
| Boxes, meters, sites, the overall data flow | `01 - System architecture.md` |
| Any RTDB path or Firestore collection | `04 - Database (Realtime Database and Firestore).md` |
| `database.rules.json`, `firestore.rules`, admins, malls, plans, accounts, secrets | `05 - Security, accounts and access.md` |
| `functions/` (a function, schedule, trigger, constant) | `06 - Cloud Functions.md` |
| Alert logic, limits, Telegram | `07 - Alerts and Telegram.md` |
| kWh readings, daily snapshot, billing, exports | `08 - kWh readings, billing and exports.md` |
| `src/` pages, data reading, pausing, design (`src/index.css`) | `09 - Website (dashboard).md` |
| Deploy steps, hosting, backups, CLI quirks | `10 - Deploying, operations and backups.md` |
| A new failure mode and its fix | `11 - Troubleshooting runbook.md` |
| Anything that changes usage or cost | `12 - Costs and usage.md` |

Write the guide for a person maintaining the system: plain words, what it does and why, exact paths and settings. **Never copy a secret into it**: the database secret in box scripts, bot tokens, API keys. Say where the secret lives instead.

## Standing rules

- **Live values and alarm speed come first.** Check every cost or performance change against how fast live readings and alarms arrive, and state the effect before making it.
- **The 22:00 kWh reading is the billing number**; nothing may risk losing it.
- **Box scripts:** every `"@W_..."` Modbus address must be one complete string literal (PIStudio rewrites literals only), on a connection number that exists in that box's PIStudio project.
- **Box scripts contain the database secret.** Never paste them into chats, issues or commits.
- **UI changes:** verify by rendering every affected page with sample data at phone (390/360 px) and desktop (1280 px) width, light and dark, before calling them done.
- **Firebase CLI on this PC:** read the database from PowerShell (Git Bash mangles `/paths`); never read `/` or `/devices` without `--shallow`; exit code 2 / "unexpected error" can follow a command that worked. A slow functions deploy needs `$env:FUNCTIONS_DISCOVERY_TIMEOUT=90`.
- The user commits and pushes; don't commit or push unless asked.

## Commands

```
npm run dev | npm run build | npm run lint        website
cd functions && npm test                           Cloud Function tests
firebase deploy --only functions|database|firestore --project testononlinedb
```
