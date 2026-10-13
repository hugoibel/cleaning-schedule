# Cleaning Schedule

Master cleaning schedule for the plant: daily, twice-weekly, weekly and monthly tasks, marked from a phone or a computer and shared live by the team.

- **App:** https://hugoibel.github.io/cleaning-schedule/ (installable: Chrome/Edge "Install", Android "Install app", iPhone "Add to Home Screen").
- **Data:** a Cloudflare Worker + D1 database (`worker/worker.js`), protected by a team PIN stored as a Worker secret. No data lives in this repository.
- English by default, Spanish in Settings. Works offline: marks wait on the device and sync when the connection is back.
