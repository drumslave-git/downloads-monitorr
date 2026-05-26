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
STALLED_THRESHOLD_MINUTES=30
POLL_INTERVAL_SECONDS=30
```

downloads-monitorr logs in through the qBittorrent WebUI API, stores the returned WebUI session cookie in memory, and sends that cookie with authenticated API requests.

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

qBittorrent reports torrent state, but it does not report the exact time a torrent entered `stalledDL`. downloads-monitorr starts timing a torrent when it first observes an incomplete torrent in a stalled state. If it remains stalled longer than `STALLED_THRESHOLD_MINUTES`, it appears in the **Hanging** view.

The timer resets when the torrent leaves the stalled state, completes, or disappears from qBittorrent.

## Scripts

- `npm run dev` starts the Node backend and Vite React dev server together.
- `npm run build` builds the React frontend into `dist/`.
- `npm start` builds the React frontend and starts the Node dashboard server.
- `npm run serve` starts only the Node server and expects `dist/` to already exist.
- `npm run check` validates server JavaScript syntax and builds the React frontend.
