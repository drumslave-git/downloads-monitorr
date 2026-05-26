# downloads-monitorr

downloads-monitorr is a small local dashboard for watching qBittorrent downloads that stay in a stalled state for too long.

It connects to the qBittorrent Web API from the Node server, keeps credentials out of the browser, and tracks how long incomplete torrents have continuously appeared in a stalled state.

## Requirements

- Node.js 20.19 or newer
- qBittorrent with Web UI enabled

In qBittorrent, enable the Web UI from:

`Tools -> Options -> Web UI -> Web User Interface`

## Setup

Copy the example environment file:

```powershell
Copy-Item .env.example .env
```

Edit `.env` with your qBittorrent Web UI URL and credentials:

```env
PORT=3020
QBITTORRENT_URL=http://localhost:8080
QBITTORRENT_USERNAME=admin
QBITTORRENT_PASSWORD=change-me
RADARR_URL=
RADARR_API_KEY=
SONARR_URL=
SONARR_API_KEY=
WHISPARR_URL=
WHISPARR_API_KEY=
STALLED_THRESHOLD_MINUTES=30
POLL_INTERVAL_SECONDS=30
```

downloads-monitorr logs in through the qBittorrent WebUI API, stores the returned WebUI session cookie in memory, and sends that cookie with authenticated API requests.

Radarr, Sonarr, and Whisparr are optional. Configure any app by setting both its URL and API key. The API key is available in each app under `Settings -> General -> Security`. downloads-monitorr reads `/api/v3/queue` from each configured app and marks matching torrents by queue `downloadId` first, with a title fallback for clients that do not expose a hash-like ID.

Start the dashboard:

```powershell
npm install
npm start
```

Open:

```text
http://localhost:3020
```

For development, run:

```powershell
npm run dev
```

Then open the Vite dev server URL shown in the terminal, usually:

```text
http://127.0.0.1:5173
```

The Vite dev server proxies `/api` requests to the Node backend on `PORT`.

## How Hanging Detection Works

A torrent appears in the **Hanging** view when qBittorrent reports it as a stalled incomplete download and its `last_activity` age is greater than `STALLED_THRESHOLD_MINUTES`.

The stalled timer is still shown for context, but the threshold is applied to qBittorrent's last activity timestamp.

## Replacement Action

When a torrent is matched to a Radarr, Sonarr, or Whisparr queue item, the dashboard shows a **Replace** button. After confirmation, downloads-monitorr:

1. Deletes the torrent and its files from qBittorrent.
2. Removes and blocklists the matching Arr queue item.
3. Triggers a replacement search in the matching Arr app.

The button is disabled for torrents that are not matched to an Arr queue item.

## Scripts

- `npm run dev` starts the Node backend and Vite React dev server together.
- `npm run build` builds the React frontend into `dist/`.
- `npm start` builds the React frontend and starts the Node dashboard server.
- `npm run serve` starts only the Node server and expects `dist/` to already exist.
- `npm run check` validates server JavaScript syntax and builds the React frontend.
