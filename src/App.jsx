import { useEffect, useMemo, useRef, useState } from "react";

const VIEW_COPY = {
  hanging: {
    title: "Hanging downloads",
    subtitle: "Stalled downloads whose last activity is older than your threshold.",
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
  const [actionMessage, setActionMessage] = useState(null);
  const [replacingHashes, setReplacingHashes] = useState(() => new Set());
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

        return [
          torrent.name,
          torrent.category,
          torrent.tags,
          torrent.state,
          ...(torrent.arrQueueApps || []),
          ...(torrent.arrQueues || []).map((queue) => queue.mediaTitle || queue.title),
        ]
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

  async function replaceTorrent(torrent) {
    const appNames = (torrent.arrQueueApps || []).join(", ");
    const confirmed = window.confirm(
      `Delete "${torrent.name}" and its data from qBittorrent, then blocklist and search for a replacement in ${appNames}?`,
    );

    if (!confirmed) {
      return;
    }

    setActionMessage(null);
    setReplacingHashes((current) => new Set(current).add(torrent.hash));

    try {
      const response = await fetch(`/api/torrents/${encodeURIComponent(torrent.hash)}/replace`, {
        method: "POST",
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      const failedApps = payload.arrResults.filter((result) => !result.ok);
      const successfulApps = payload.arrResults.filter((result) => result.ok).map((result) => result.appName);

      setActionMessage({
        type: failedApps.length ? "warning" : "success",
        text: failedApps.length
          ? `Deleted from qBittorrent, but some Arr actions failed: ${failedApps.map((result) => `${result.appName}: ${result.error}`).join(" | ")}`
          : `Deleted from qBittorrent and triggered replacement search in ${successfulApps.join(", ")}.`,
      });
      await refresh(true);
    } catch (error) {
      setActionMessage({
        type: "error",
        text: error.message,
      });
    } finally {
      setReplacingHashes((current) => {
        const next = new Set(current);
        next.delete(torrent.hash);
        return next;
      });
    }
  }

  const summary = payload?.summary || {
    total: "-",
    downloading: "-",
    stalled: "-",
    hanging: "-",
    inArrQueue: "-",
  };
  const config = payload?.config;
  const statusMessage = loadError || payload?.lastError?.message || (config ? `Connected to ${config.qbittorrentUrl}` : "Starting...");
  const isError = Boolean(loadError || payload?.lastError);
  const arrErrors = payload?.arr?.errors || [];
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
        <Metric label="Arr queue" value={summary.inArrQueue} />
      </section>

      <section className={`connection-card${isError ? " error" : ""}`}>
        <ConnectionItem label="Status" value={statusMessage} />
        <ConnectionItem label="Last refresh" value={payload?.lastFetchAt ? relativeTime(payload.lastFetchAt) : loadError ? "Failed" : "Never"} />
        <ConnectionItem label="Threshold" value={config ? `${config.stalledThresholdMinutes} min` : "-"} />
        <ConnectionItem label="Polling" value={config ? `${config.pollIntervalSeconds}s` : "-"} />
      </section>
      <ArrErrors errors={arrErrors} />
      <ActionMessage message={actionMessage} />

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
                <th>Arr queue</th>
                <th>Progress</th>
                <th>Stalled for</th>
                <th>Last activity</th>
                <th>Seeds</th>
                <th>Down</th>
                <th>ETA</th>
                <th>Size</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredTorrents.map((torrent) => (
                <TorrentRow
                  key={torrent.hash}
                  torrent={torrent}
                  isReplacing={replacingHashes.has(torrent.hash)}
                  onReplace={replaceTorrent}
                />
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

function ArrErrors({ errors }) {
  if (errors.length === 0) {
    return null;
  }

  return (
    <section className="alert">
      <strong>Arr queue warnings:</strong>{" "}
      {errors.map((error) => `${error.appName}: ${error.message}`).join(" | ")}
    </section>
  );
}

function ActionMessage({ message }) {
  if (!message) {
    return null;
  }

  return <section className={`alert ${message.type}`.trim()}>{message.text}</section>;
}

function TorrentRow({ torrent, isReplacing, onReplace }) {
  const stateClass = torrent.isOverThreshold ? "danger" : torrent.isStalledDownload ? "warning" : "";
  const stalledText = torrent.isStalledDownload ? duration(torrent.stalledForMs) : "-";
  const tags = [torrent.category, torrent.tags].filter(Boolean).join(" / ");
  const canReplace = (torrent.arrQueues || []).length > 0;
  const arrTitles = uniqueValues((torrent.arrQueues || []).map((queue) => queue.mediaTitle || queue.title));

  return (
    <tr>
      <td data-label="Name">
        <div className="torrent-name">{torrent.name || torrent.hash}</div>
        <ArrItemNames titles={arrTitles} />
        <div className="torrent-meta">{tags || torrent.savePath || "No category"}</div>
      </td>
      <td data-label="State">
        <span className={`pill ${stateClass}`.trim()}>{torrent.state || "unknown"}</span>
      </td>
      <td data-label="Arr queue">
        <ArrQueueBadges queues={torrent.arrQueues || []} />
      </td>
      <td data-label="Progress">
        <div className="progress">
          <strong>{percent(torrent.progress)}</strong>
          <div className="bar" aria-hidden="true">
            <span style={{ width: `${Math.round((torrent.progress || 0) * 100)}%` }} />
          </div>
        </div>
      </td>
      <td data-label="Stalled for" className={torrent.isOverThreshold ? "danger-text" : ""}>{stalledText}</td>
      <td data-label="Last activity">{torrent.lastActivity ? relativeTime(torrent.lastActivity) : <span className="muted">Unknown</span>}</td>
      <td data-label="Seeds">
        {torrent.seeds} / {torrent.leeches}
      </td>
      <td data-label="Down">{bytes(torrent.downloadSpeed)}/s</td>
      <td data-label="ETA">{eta(torrent.eta)}</td>
      <td data-label="Size">{bytes(torrent.size)}</td>
      <td data-label="Action">
        <button className="danger-action" type="button" disabled={!canReplace || isReplacing} onClick={() => onReplace(torrent)}>
          {isReplacing ? "Replacing..." : "Replace"}
        </button>
      </td>
    </tr>
  );
}

function ArrItemNames({ titles }) {
  if (titles.length === 0) {
    return null;
  }

  return (
    <div className="arr-item-names">
      <span>Media</span>
      {titles.join(" / ")}
    </div>
  );
}

function ArrQueueBadges({ queues }) {
  if (queues.length === 0) {
    return <span className="muted">-</span>;
  }

  return (
    <div className="arr-badges">
      {queues.map((queue) => (
        <span className="pill arr" title={queue.title} key={`${queue.appId}:${queue.downloadId || queue.title}`}>
          {queue.appName}
        </span>
      ))}
    </div>
  );
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
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
