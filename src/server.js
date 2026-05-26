const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

loadEnvFile(path.join(process.cwd(), ".env"));

const STATIC_DIR = path.join(process.cwd(), "dist");
const PORT = Number(process.env.PORT || 3020);
const POLL_INTERVAL_MS = secondsToMs(process.env.POLL_INTERVAL_SECONDS, 30);
const STALLED_THRESHOLD_MS = minutesToMs(process.env.STALLED_THRESHOLD_MINUTES, 30);

const config = {
  qbittorrentUrl: normalizeBaseUrl(process.env.QBITTORRENT_URL || "http://localhost:8080"),
  username: process.env.QBITTORRENT_USERNAME || "",
  password: process.env.QBITTORRENT_PASSWORD || "",
  arrApps: buildArrAppConfigs(),
};

const state = {
  lastFetchAt: null,
  lastError: null,
  arrLastFetchAt: null,
  arrErrors: [],
  torrents: [],
  pollInFlight: null,
};

class QBittorrentClient {
  constructor({ qbittorrentUrl, username, password }) {
    this.baseUrl = qbittorrentUrl;
    this.username = username;
    this.password = password;
    this.cookie = "";
    this.authenticated = false;
  }

  async login() {
    if (!this.username || !this.password) {
      throw new Error("QBITTORRENT_USERNAME and QBITTORRENT_PASSWORD are required for qBittorrent WebUI API login");
    }

    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
    });

    const response = await fetch(this.apiUrl("/api/v2/auth/login"), {
      method: "POST",
      redirect: "manual",
      headers: {
        ...this.webUiHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const text = (await response.text()).trim();
    const cookie = extractSessionCookie(response.headers);

    if (response.status === 403) {
      throw new Error("qBittorrent login rejected with HTTP 403. The WebUI API documents this as an IP ban after too many failed login attempts.");
    }

    if (response.status === 204 && cookie) {
      this.cookie = cookie;
      this.authenticated = true;
      return;
    }

    if (response.status !== 200) {
      throw new Error(
        `qBittorrent login returned HTTP ${response.status} ${text || response.statusText}. Expected a successful login response with a session cookie.`,
      );
    }

    if (text !== "Ok.") {
      throw new Error(`qBittorrent login failed: expected "Ok.", got "${text || "empty response"}"`);
    }

    if (!cookie) {
      throw new Error("qBittorrent login returned Ok. but did not include a WebUI session cookie");
    }

    this.cookie = cookie;
    this.authenticated = true;
  }

  async request(pathname, init = {}, retryAfterLogin = true) {
    if (!this.authenticated) {
      await this.login();
    }

    const headers = {
      ...this.webUiHeaders(),
      ...(init.headers || {}),
    };

    if (this.cookie) {
      headers.Cookie = this.cookie;
    }

    const response = await fetch(this.apiUrl(pathname), {
      ...init,
      redirect: "manual",
      headers,
    });

    if (response.status === 401 || response.status === 403) {
      if (!retryAfterLogin) {
        throw new Error(this.authErrorMessage(pathname, response.status));
      }

      this.cookie = "";
      this.authenticated = false;
      await this.login();
      return this.request(pathname, init, false);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`qBittorrent request failed: HTTP ${response.status} ${text || response.statusText}`);
    }

    return response;
  }

  async getTorrents() {
    const response = await this.request("/api/v2/torrents/info?filter=all");
    return response.json();
  }

  apiUrl(pathname) {
    const basePath = this.baseUrl.pathname.replace(/\/+$/, "");
    const apiPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return new URL(`${basePath}${apiPath}`, this.baseUrl.origin);
  }

  webUiHeaders() {
    return {
      Accept: "application/json, text/plain, */*",
      Referer: this.baseUrl.origin,
      "User-Agent": "downloads-monitorr/1.0",
    };
  }

  authErrorMessage(pathname, status) {
    return [
      `qBittorrent rejected ${pathname}: HTTP ${status}.`,
      "The Web API session is not authorized.",
      "Check QBITTORRENT_USERNAME/QBITTORRENT_PASSWORD and qBittorrent Web UI CSRF/host-header settings.",
    ].join(" ");
  }
}

class ArrQueueClient {
  constructor({ id, name, url, apiKey }) {
    this.id = id;
    this.name = name;
    this.baseUrl = normalizeBaseUrl(url);
    this.apiKey = apiKey;
  }

  async getQueueItems() {
    const pageSize = 500;
    const records = [];

    for (let page = 1; page <= 20; page += 1) {
      const response = await fetch(this.apiUrl("/api/v3/queue", {
        page,
        pageSize,
        includeMovie: true,
        includeSeries: true,
        includeEpisode: true,
        includeUnknownMovieItems: true,
        includeUnknownSeriesItems: true,
      }), {
        headers: {
          Accept: "application/json",
          "X-Api-Key": this.apiKey,
          "User-Agent": "downloads-monitorr/1.0",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`${this.name} queue request failed: HTTP ${response.status} ${text || response.statusText}`);
      }

      const payload = await response.json();
      const pageRecords = Array.isArray(payload) ? payload : payload.records || [];
      records.push(...pageRecords.map((item) => this.normalizeQueueItem(item)));

      if (Array.isArray(payload) || records.length >= numberOrZero(payload.totalRecords) || pageRecords.length < pageSize) {
        break;
      }
    }

    return records;
  }

  normalizeQueueItem(item) {
    return {
      appId: this.id,
      appName: this.name,
      title: item.title || item.sourceTitle || item.movie?.title || item.series?.title || "Unknown item",
      downloadId: item.downloadId || item.downloadClientId || "",
      status: item.status || "",
      trackedDownloadStatus: item.trackedDownloadStatus || "",
      protocol: item.protocol || "",
    };
  }

  apiUrl(pathname, query = {}) {
    const basePath = this.baseUrl.pathname.replace(/\/+$/, "");
    const apiPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const url = new URL(`${basePath}${apiPath}`, this.baseUrl.origin);

    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }

    return url;
  }
}

class ArrQueueService {
  constructor(apps) {
    this.clients = apps.map((app) => new ArrQueueClient(app));
  }

  async getQueueIndex() {
    const results = await Promise.all(
      this.clients.map(async (client) => {
        try {
          return {
            client,
            items: await client.getQueueItems(),
            error: null,
          };
        } catch (error) {
          return {
            client,
            items: [],
            error,
          };
        }
      }),
    );

    const index = {
      byDownloadId: new Map(),
      byTitle: new Map(),
      errors: [],
      apps: this.clients.map((client) => ({
        id: client.id,
        name: client.name,
      })),
    };

    for (const result of results) {
      if (result.error) {
        index.errors.push({
          appId: result.client.id,
          appName: result.client.name,
          message: result.error.message,
        });
        continue;
      }

      for (const item of result.items) {
        addQueueMatch(index.byDownloadId, normalizeDownloadId(item.downloadId), item);
        addQueueMatch(index.byTitle, normalizeQueueTitle(item.title), item);
      }
    }

    return index;
  }
}

class TorrentTracker {
  constructor() {
    this.records = new Map();
  }

  update(rawTorrents, queueIndex) {
    const now = Date.now();
    const nextRecords = new Map();

    for (const torrent of rawTorrents) {
      const hash = torrent.hash;
      const previous = this.records.get(hash);
      const isDownload = Number(torrent.progress || 0) < 1;
      const isStalled = isDownload && String(torrent.state || "").toLowerCase().includes("stalled");
      const stateChanged = previous && previous.state !== torrent.state;

      const record = {
        hash,
        name: torrent.name || hash,
        state: torrent.state || "unknown",
        stateSince: stateChanged || !previous ? now : previous.stateSince,
        stalledSince: isStalled ? previous?.stalledSince || now : null,
        firstSeenAt: previous?.firstSeenAt || now,
      };

      nextRecords.set(hash, record);
    }

    this.records = nextRecords;

    return rawTorrents.map((torrent) => this.decorateTorrent(torrent, now, getArrQueueMatches(torrent, queueIndex)));
  }

  decorateTorrent(torrent, now, arrQueues) {
    const record = this.records.get(torrent.hash);
    const stalledForMs = record?.stalledSince ? now - record.stalledSince : 0;
    const stateForMs = record?.stateSince ? now - record.stateSince : 0;
    const lastActivityMs = unixSecondsToMs(torrent.last_activity);
    const lastActivityAgeMs = lastActivityMs ? Math.max(0, now - lastActivityMs) : null;

    return {
      hash: torrent.hash,
      name: torrent.name,
      category: torrent.category,
      tags: torrent.tags,
      savePath: torrent.save_path,
      state: torrent.state,
      progress: numberOrZero(torrent.progress),
      size: numberOrZero(torrent.size),
      amountLeft: numberOrZero(torrent.amount_left),
      downloadSpeed: numberOrZero(torrent.dlspeed),
      uploadSpeed: numberOrZero(torrent.upspeed),
      eta: numberOrZero(torrent.eta),
      ratio: numberOrZero(torrent.ratio),
      seeds: numberOrZero(torrent.num_seeds),
      leeches: numberOrZero(torrent.num_leechs),
      addedOn: unixSecondsToMs(torrent.added_on),
      lastActivity: lastActivityMs,
      lastActivityAgeMs,
      stateSince: record?.stateSince || null,
      stateForMs,
      stalledSince: record?.stalledSince || null,
      stalledForMs,
      arrQueues,
      arrQueueApps: arrQueues.map((queue) => queue.appName),
      isDownload: numberOrZero(torrent.progress) < 1,
      isStalledDownload: Boolean(record?.stalledSince),
      isOverThreshold: stalledForMs >= STALLED_THRESHOLD_MS,
    };
  }
}

const client = new QBittorrentClient(config);
const arrQueueService = new ArrQueueService(config.arrApps);
const tracker = new TorrentTracker();

async function pollTorrents() {
  if (state.pollInFlight) {
    return state.pollInFlight;
  }

  state.pollInFlight = (async () => {
    const [torrentResult, queueIndex] = await Promise.all([
      client.getTorrents(),
      arrQueueService.getQueueIndex(),
    ]);
    const torrents = Array.isArray(torrentResult) ? torrentResult : [];

    state.torrents = tracker.update(torrents, queueIndex);
    state.arrLastFetchAt = Date.now();
    state.arrErrors = queueIndex.errors;
    state.lastFetchAt = Date.now();
    state.lastError = null;
    return state.torrents;
  })()
    .catch((error) => {
      state.lastError = {
        message: error.message,
        at: Date.now(),
      };
      throw error;
    })
    .finally(() => {
      state.pollInFlight = null;
    });

  return state.pollInFlight;
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);

    if (requestUrl.pathname === "/api/status") {
      return sendJson(response, buildStatusPayload());
    }

    if (requestUrl.pathname === "/api/refresh" && request.method === "POST") {
      await pollTorrents();
      return sendJson(response, buildStatusPayload());
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      return sendJson(response, { error: "Not found" }, 404);
    }

    return serveStatic(requestUrl.pathname, response);
  } catch (error) {
    return sendJson(response, { error: error.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`downloads-monitorr is running at http://localhost:${PORT}`);
  console.log(`qBittorrent API target: ${config.qbittorrentUrl.origin}`);
  pollTorrents().catch((error) => {
    console.error(error.message);
  });
});

setInterval(() => {
  pollTorrents().catch((error) => {
    console.error(error.message);
  });
}, POLL_INTERVAL_MS);

function buildStatusPayload() {
  const torrents = [...state.torrents].sort(sortTorrents);
  const stalled = torrents.filter((torrent) => torrent.isStalledDownload);
  const hanging = stalled.filter((torrent) => torrent.isOverThreshold);

  return {
    ok: !state.lastError,
    lastFetchAt: state.lastFetchAt,
    lastError: state.lastError,
    config: {
      qbittorrentUrl: config.qbittorrentUrl.origin,
      arrApps: config.arrApps.map((app) => ({
        id: app.id,
        name: app.name,
        configured: true,
      })),
      pollIntervalSeconds: Math.round(POLL_INTERVAL_MS / 1000),
      stalledThresholdMinutes: Math.round(STALLED_THRESHOLD_MS / 60000),
    },
    arr: {
      lastFetchAt: state.arrLastFetchAt,
      errors: state.arrErrors,
    },
    summary: {
      total: torrents.length,
      downloading: torrents.filter((torrent) => torrent.isDownload).length,
      stalled: stalled.length,
      hanging: hanging.length,
      inArrQueue: torrents.filter((torrent) => torrent.arrQueues.length > 0).length,
    },
    torrents,
  };
}

function sortTorrents(a, b) {
  if (a.isOverThreshold !== b.isOverThreshold) {
    return a.isOverThreshold ? -1 : 1;
  }

  if (a.isStalledDownload !== b.isStalledDownload) {
    return a.isStalledDownload ? -1 : 1;
  }

  return b.stalledForMs - a.stalledForMs || a.name.localeCompare(b.name);
}

function serveStatic(pathname, response) {
  const safePathname = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(STATIC_DIR, safePathname.replace(/^\/+/, ""));
  const relativePath = path.relative(STATIC_DIR, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return sendText(response, "Forbidden", 403);
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      return sendIndexFallback(pathname, response);
    }

    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": "no-store",
    });
    response.end(data);
  });
}

function sendIndexFallback(pathname, response) {
  if (path.extname(pathname)) {
    return sendText(response, "Not found", 404);
  }

  fs.readFile(path.join(STATIC_DIR, "index.html"), (error, data) => {
    if (error) {
      return sendText(response, "Build the React app first with `npm run build`.", 404);
    }

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(data);
  });
}

function sendJson(response, payload, statusCode = 200) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, text, statusCode = 200) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };

  return types[extension] || "application/octet-stream";
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function buildArrAppConfigs() {
  return [
    buildArrAppConfig("radarr", "Radarr", "RADARR"),
    buildArrAppConfig("sonarr", "Sonarr", "SONARR"),
    buildArrAppConfig("whisparr", "Whisparr", "WHISPARR"),
  ].filter(Boolean);
}

function buildArrAppConfig(id, name, prefix) {
  const url = process.env[`${prefix}_URL`];
  const apiKey = process.env[`${prefix}_API_KEY`];

  if (!url && !apiKey) {
    return null;
  }

  if (!url || !apiKey) {
    throw new Error(`${prefix}_URL and ${prefix}_API_KEY must both be set when configuring ${name}`);
  }

  return {
    id,
    name,
    url,
    apiKey,
  };
}

function getArrQueueMatches(torrent, queueIndex) {
  if (!queueIndex) {
    return [];
  }

  const matches = [
    ...getQueueMatches(queueIndex.byDownloadId, normalizeDownloadId(torrent.hash)),
    ...getQueueMatches(queueIndex.byTitle, normalizeQueueTitle(torrent.name)),
  ];
  const seen = new Set();

  return matches.filter((match) => {
    const key = `${match.appId}:${match.downloadId || match.title}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getQueueMatches(index, key) {
  if (!key || !index) {
    return [];
  }

  return index.get(key) || [];
}

function addQueueMatch(index, key, item) {
  if (!key) {
    return;
  }

  const matches = index.get(key) || [];
  matches.push(item);
  index.set(key, matches);
}

function normalizeDownloadId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeQueueTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractSessionCookie(headers) {
  const cookieHeaders =
    typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
  const sessionCookie = cookieHeaders.find((cookie) => /(?:^|;\s*)(?:SID|QBT_SID(?:_\d+)?)=/.test(cookie));

  return sessionCookie ? sessionCookie.split(";")[0] : "";
}

function secondsToMs(value, fallback) {
  const seconds = Number(value || fallback);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback * 1000;
}

function minutesToMs(value, fallback) {
  const minutes = Number(value || fallback);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : fallback * 60 * 1000;
}

function unixSecondsToMs(value) {
  const seconds = Number(value || 0);
  return seconds > 0 ? seconds * 1000 : null;
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
