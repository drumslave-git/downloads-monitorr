import { useEffect, useMemo, useRef, useState } from "react";

const VIEW_COPY = {
  hanging: {
    title: "Hanging downloads",
    subtitle: "Torrents observed in stalled download state beyond your threshold.",
  },
  stalled: {
    title: "All stalled downloads",
    subtitle: "Every incomplete torrent currently reported as stalled by qBittorrent.",
  },
  downloads: {
    title: "Active download queue",
    subtitle: "Incomplete torrents, including downloading, queued, paused, and stalled states.",
  },
  all: {
    title: "All torrents",
    subtitle: "Full qBittorrent torrent list returned by the Web API.",
  },
};

const FILTERS = [
  ["stalled", "All stalled"],
  ["hanging", "Hanging"],
  ["downloads", "Downloads"],
  ["all", "All"],
];

export default function App() {
  const [payload, setPayload] = useState(null);
  const [activeFilter, setActiveFilter] = useState("stalled");
  const [query, setQuery] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const refreshTimer = useRef(null);

  useEffect(() => {
    refresh();

    return () => clearTimeout(refreshTimer.current);
  }, []);

  const filteredTorrents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return (payload?.torrents || [])
      .filter((torrent) => {
        if (activeFilter === "hanging") {
          return torrent.isOverThreshold;
        }

        if (activeFilter === "stalled") {
          return torrent.isStalledDownload;
        }

        if (activeFilter === "downloads") {
          return torrent.isDownload;
        }

        return true;
      })
      .filter((torrent) => {
        if (!normalizedQuery) {
          return true;
        }

        return [torrent.name, torrent.category, torrent.tags, torrent.state]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(normalizedQuery));
      });
  }, [activeFilter, payload, query]);

  async function refresh(force = false) {
    setIsRefreshing(true);

    try {
      const response = await fetch(force ? "/api/refresh" : "/api/status", {
        method: force ? "POST" : "GET",
      });
      const nextPayload = await response.json();

      if (!response.ok) {
        throw new Error(nextPayload.error || `HTTP ${response.status}`);
      }

      setPayload(nextPayload);
      setLoadError(null);
      scheduleRefresh(nextPayload.config?.pollIntervalSeconds);
    } catch (error) {
      setLoadError(error.message);
      scheduleRefresh(payload?.config?.pollIntervalSeconds || 30);
    } finally {
      setIsRefreshing(false);
    }
  }

  function scheduleRefresh(seconds) {
    clearTimeout(refreshTimer.current);
    const interval = Number(seconds || 30) * 1000;
    refreshTimer.current = setTimeout(() => refresh(false), Math.max(5000, interval));
  }

  const summary = payload?.summary || {
    total: "-",
    downloading: "-",
    stalled: "-",
    hanging: "-",
  };
  const config = payload?.config;
  const statusMessage = loadError || payload?.lastError?.message || (config ? `Connected to ${config.qbittorrentUrl}` : "Starting...");
  const isError = Boolean(loadError || payload?.lastError);
  const copy = VIEW_COPY[activeFilter];

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">qBittorrent monitor</p>
          <h1>downloads-monitorr</h1>
          <p className="lede">Track downloads stuck in a stalled state long enough to need attention.</p>
        </div>
        <button type="button" onClick={() => refresh(true)} disabled={isRefreshing}>
          {isRefreshing ? "Refreshing..." : "Refresh now"}
        </button>
      </header>

      <section className="status-strip" aria-live="polite">
        <Metric label="Total torrents" value={summary.total} />
        <Metric label="Downloads" value={summary.downloading} />
        <Metric label="Stalled downloads" value={summary.stalled} tone="warning" />
        <Metric label="Hanging" value={summary.hanging} tone="danger" />
      </section>

      <section className={`connection-card${isError ? " error" : ""}`}>
        <ConnectionItem label="Status" value={statusMessage} />
        <ConnectionItem label="Last refresh" value={payload?.lastFetchAt ? relativeTime(payload.lastFetchAt) : loadError ? "Failed" : "Never"} />
        <ConnectionItem label="Threshold" value={config ? `${config.stalledThresholdMinutes} min` : "-"} />
        <ConnectionItem label="Polling" value={config ? `${config.pollIntervalSeconds}s` : "-"} />
      </section>

      <section className="toolbar">
        <div className="tabs" role="tablist" aria-label="Torrent filters">
          {FILTERS.map(([id, label]) => (
            <button
              className={`tab${activeFilter === id ? " active" : ""}`}
              type="button"
              key={id}
              onClick={() => setActiveFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="search">
          <span>Search</span>
          <input
            type="search"
            placeholder="Torrent name, category, tag..."
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </section>

      <section className="table-card">
        <div className="table-header">
          <h2>{copy.title}</h2>
          <p>{copy.subtitle}</p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>State</th>
                <th>Progress</th>
                <th>Stalled for</th>
                <th>Last activity</th>
                <th>Seeds</th>
                <th>Down</th>
                <th>ETA</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {filteredTorrents.map((torrent) => (
                <TorrentRow key={torrent.hash} torrent={torrent} />
              ))}
            </tbody>
          </table>
        </div>
        {filteredTorrents.length === 0 && (
          <p className="empty-state">
            {loadError ? "Could not load qBittorrent data. Check the server terminal and .env settings." : "No torrents match this view."}
          </p>
        )}
      </section>
    </main>
  );
}

function Metric({ label, value, tone = "" }) {
  return (
    <article className={`metric ${tone}`.trim()}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function ConnectionItem({ label, value }) {
  return (
    <div>
      <span className="label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TorrentRow({ torrent }) {
  const stateClass = torrent.isOverThreshold ? "danger" : torrent.isStalledDownload ? "warning" : "";
  const stalledText = torrent.isStalledDownload ? duration(torrent.stalledForMs) : "-";
  const tags = [torrent.category, torrent.tags].filter(Boolean).join(" / ");

  return (
    <tr>
      <td>
        <div className="torrent-name">{torrent.name || torrent.hash}</div>
        <div className="torrent-meta">{tags || torrent.savePath || "No category"}</div>
      </td>
      <td>
        <span className={`pill ${stateClass}`.trim()}>{torrent.state || "unknown"}</span>
      </td>
      <td>
        <div className="progress">
          <strong>{percent(torrent.progress)}</strong>
          <div className="bar" aria-hidden="true">
            <span style={{ width: `${Math.round((torrent.progress || 0) * 100)}%` }} />
          </div>
        </div>
      </td>
      <td className={torrent.isOverThreshold ? "danger-text" : ""}>{stalledText}</td>
      <td>{torrent.lastActivity ? relativeTime(torrent.lastActivity) : <span className="muted">Unknown</span>}</td>
      <td>
        {torrent.seeds} / {torrent.leeches}
      </td>
      <td>{bytes(torrent.downloadSpeed)}/s</td>
      <td>{eta(torrent.eta)}</td>
      <td>{bytes(torrent.size)}</td>
    </tr>
  );
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 1000) / 10}%`;
}

function bytes(value) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value || 0);
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function eta(value) {
  const seconds = Number(value || 0);

  if (!seconds || seconds >= 8640000) {
    return "-";
  }

  return duration(seconds * 1000);
}

function duration(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days) {
    return `${days}d ${hours}h`;
  }

  if (hours) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function relativeTime(timestamp) {
  const diff = Date.now() - Number(timestamp);

  if (diff < 60000) {
    return "Just now";
  }

  return `${duration(diff)} ago`;
}
