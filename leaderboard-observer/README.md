# Trolley leaderboard observer

`pnpm run start` runs the observer and a leaderboard dashboard together. The observer uses three signed-in game tabs in parallel. Each tab reads the displayed opponent name and defense, and checks `/leaderboard` when it discovers a new defense. Page navigations are spaced at least two seconds apart per tab (including leaderboard checks); set `OBSERVER_INTERVAL_MS` to a larger value to slow them down. It only navigates pages; it never presses Judge or creates a round. The dashboard listens on **http://127.0.0.1:9871/** and refetches the site's leaderboard every 90 seconds. Its added columns show the last observed defense and a History popup with recorded scores. The dashboard serves only read-only routes; it does not expose session data or import operations. You can put a reverse proxy in front of it if you want others to view it.

The initial HTML includes the current table, so rows appear without waiting for browser JavaScript. The page follows the upstream leaderboard's layout and adds defense columns. GitHub avatars and profile links come from the source leaderboard's existing URLs. The navigation links to the game, the installable userscript, and this repository.

Below the game's top 100, the table lists other observed players by their latest recorded Elo. These scores may be stale; players without a recorded Elo appear last with N/A.


The service uses the same `trolley-defense-history-v1` format as the userscript. Exact displayed names identify players; duplicate names are treated as one person. Unchanged defenses add no encounters or score samples. A return to an earlier defense updates its `lastSeen` time without duplicating its text.

```sh
cd leaderboard-observer
pnpm install
pnpm exec playwright install chromium
pnpm auth       # interactive, headful GitHub sign-in; saves session
pnpm run start  # observer + local dashboard; Ctrl-C to stop
```

To bring over your existing userscript history, update the userscript, click **Download data**, and run:

```sh
pnpm run import -- /path/to/trolley-defense-history-YYYY-MM-DD.json
```

The import merges by displayed name and exact defense text, keeps distinct observations, and may be run while `pnpm run start` is running. Run it on the machine hosting the dashboard. Import is a local CLI command, never a web endpoint.

By default, `data/session.json` contains Playwright cookies and site storage, and `data/history.json` contains the observation history. **Sync the entire `data/` directory between machines**, keep it private, and run only one observer against a synced directory at a time. The directory is gitignored. Set `OBSERVER_DATA_DIR=/absolute/path` to put it elsewhere. Session state is portable JSON; it may need refreshing with `pnpm auth` when the site's login expires. `OBSERVER_INTERVAL_MS` defaults to 15000 and must be at least 5000. `TROLLEY_URL` overrides the website origin for local testing.

The live leaderboard reflects the website; recorded Elo is the score observed when a defense version was first seen. If the leaderboard request fails, the defense stays saved and its score is retried when that opponent appears again. Browser clients poll the dashboard every 10 seconds; the dashboard itself fetches the source leaderboard every 90 seconds.
