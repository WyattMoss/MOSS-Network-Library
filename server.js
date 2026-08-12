// server.js
// One Express app, one port, three things:
//  1. LibreNMS proxy routes  -> /api/devices, /api/alerts, /api/health-summary
//  2. FortiGate proxy routes -> /api/fortigate/*
//  3. A WAN throughput poller that samples wan1/wan2 counters on an
//     interval, computes Mbps in/out, and stores a rolling few hours of
//     history in a small SQLite file -> /api/wan/history
//
// Secrets (LIBRENMS_*, FORTIGATE_*) live in env/.env — never sent to the browser.
// Which interfaces to graph lives in env/config.json, re-read on every poll
// so you can edit it without rebuilding the container.

const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// --- LibreNMS ----------------------------------------------------------
const LIBRENMS_URL = (process.env.LIBRENMS_URL || '').replace(/\/+$/, '');
const LIBRENMS_TOKEN = process.env.LIBRENMS_TOKEN || '';
const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL_MS || '30000';

// --- FortiGate -----------------------------------------------------------
const FORTIGATE_URL = (process.env.FORTIGATE_URL || '').replace(/\/+$/, '');
const FORTIGATE_TOKEN = process.env.FORTIGATE_TOKEN || '';
const FORTIGATE_VDOM = process.env.FORTIGATE_VDOM || 'root';

// --- WAN throughput polling ---------------------------------------------
const WAN_POLL_INTERVAL_MS = Number(process.env.WAN_POLL_INTERVAL_MS || 30000);
const WAN_HISTORY_RETENTION_HOURS = Number(process.env.WAN_HISTORY_RETENTION_HOURS || 3);
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'env', 'config.json');
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'wan-history.sqlite');

if (String(process.env.FORTIGATE_INSECURE_TLS).toLowerCase() === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('[startup] FORTIGATE_INSECURE_TLS=true — TLS certificate verification is disabled process-wide.');
}

if (!LIBRENMS_URL || !LIBRENMS_TOKEN) {
  console.warn(
    '[startup] LIBRENMS_URL and/or LIBRENMS_TOKEN are not set. ' +
    'Copy env/.env.example to env/.env and fill them in, then restart the container.'
  );
}
if (!FORTIGATE_URL || !FORTIGATE_TOKEN) {
  console.warn('[startup] FORTIGATE_URL and/or FORTIGATE_TOKEN are not set. WAN graph and FortiGate routes will be idle.');
}

// --- config.json (hot-reloaded each poll) --------------------------------

let currentConfig = { WanInterfaces: [] };

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.WanInterfaces)) {
      throw new Error('config.json is missing a "WanInterfaces" array');
    }
    currentConfig = parsed;
  } catch (err) {
    console.error(`[config] Failed to read ${CONFIG_PATH}: ${err.message}. Keeping last known config.`);
  }
  return currentConfig;
}

loadConfig();

// --- SQLite: rolling WAN sample history -----------------------------------

fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
const db = new Database(SQLITE_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS wan_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    iface TEXT NOT NULL,
    t INTEGER NOT NULL,
    rx_mbps REAL NOT NULL,
    tx_mbps REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wan_samples_iface_t ON wan_samples (iface, t);
`);

const insertSample = db.prepare('INSERT INTO wan_samples (iface, t, rx_mbps, tx_mbps) VALUES (?, ?, ?, ?)');
const pruneOld = db.prepare('DELETE FROM wan_samples WHERE t < ?');
const selectHistory = db.prepare('SELECT t, rx_mbps AS rx, tx_mbps AS tx FROM wan_samples WHERE iface = ? AND t >= ? ORDER BY t ASC');

// lastCounters[interfaceKey] = { t: epochMs, rxBytes, txBytes } — kept in
// memory only; we need the previous raw counter to compute a rate, but we
// don't need to persist it since a gap on restart just skips one sample.
const lastCounters = {};

async function fetchFortiInterfaces() {
  const params = new URLSearchParams({ vdom: FORTIGATE_VDOM });  // <---- Here for VDOMs, not using so temp disabled
  const upstream = await fetch(`${FORTIGATE_URL}/api/v2/monitor/system/interface?${params.toString()}`, {
    headers: { Authorization: `Bearer ${FORTIGATE_TOKEN}` },
  });
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => '');
    throw new Error(`FortiGate returned ${upstream.status}: ${body.slice(0, 200)}`);
  }
  const body = await upstream.json();

  // FortiOS returns `results` either as an object keyed by interface name
  // or as an array of objects with a `name` field, depending on version.
  const results = body.results;
  const byName = {};
  if (Array.isArray(results)) {
    for (const item of results) if (item && item.name) byName[item.name] = item;
  } else if (results && typeof results === 'object') {
    Object.assign(byName, results);
  }
  return byName;
}

let lastPollError = null;
let lastPollAt = null;

async function pollOnce() {
  const cfg = loadConfig();
  if (!FORTIGATE_URL || !FORTIGATE_TOKEN || cfg.WanInterfaces.length === 0) return;

  try {
    const byName = await fetchFortiInterfaces();
    const now = Date.now();

    for (const wan of cfg.WanInterfaces) {
      const key = wan.Interface;
      const stats = byName[key];
      if (!stats) {
        console.warn(`[poll] Interface "${key}" not found in FortiGate response.`);
        continue;
      }

      const rxBytes = Number(stats.rx_bytes ?? stats.rx_bytecount ?? 0);
      const txBytes = Number(stats.tx_bytes ?? stats.tx_bytecount ?? 0);

      const prev = lastCounters[key];
      if (prev) {
        const deltaSeconds = (now - prev.t) / 1000;
        const deltaRx = rxBytes - prev.rxBytes;
        const deltaTx = txBytes - prev.txBytes;
        // A negative delta usually means a counter reset (flap/reboot) —
        // record 0 rather than a bogus spike.
        const rxMbps = deltaRx >= 0 && deltaSeconds > 0 ? (deltaRx * 8) / deltaSeconds / 1e6 : 0;
        const txMbps = deltaTx >= 0 && deltaSeconds > 0 ? (deltaTx * 8) / deltaSeconds / 1e6 : 0;

        insertSample.run(key, now, Number(rxMbps.toFixed(3)), Number(txMbps.toFixed(3)));
      }

      lastCounters[key] = { t: now, rxBytes, txBytes };
    }

    pruneOld.run(Date.now() - WAN_HISTORY_RETENTION_HOURS * 60 * 60 * 1000);
    lastPollError = null;
  } catch (err) {
    lastPollError = err.message;
    console.error('[poll] failed:', err.message);
  } finally {
    lastPollAt = Date.now();
  }
}

pollOnce().catch((err) => {
  console.error('[poll] Initial poll failed:', err.message);
});
setInterval(() => {
  pollOnce().catch((err) => {
    console.error('[poll] Poll cycle failed:', err.message);
  });
}, WAN_POLL_INTERVAL_MS);

// --- HTTP API ------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({
    refreshIntervalMs: Number(REFRESH_INTERVAL),
    configured: Boolean(LIBRENMS_URL && LIBRENMS_TOKEN),
    fortigateConfigured: Boolean(FORTIGATE_URL && FORTIGATE_TOKEN),
    wanPollIntervalMs: WAN_POLL_INTERVAL_MS,
    wanHistoryRetentionHours: WAN_HISTORY_RETENTION_HOURS,
    wanInterfaces: currentConfig.WanInterfaces,
    lastPollAt,
    lastPollError,
  });
});

app.get('/api/wan/history', (req, res) => {
  const since = Date.now() - WAN_HISTORY_RETENTION_HOURS * 60 * 60 * 1000;
  const out = {};
  for (const wan of currentConfig.WanInterfaces) {
    const key = wan.Interface;
    const series = selectHistory.all(key, since);
    const latest = series[series.length - 1] || null;
    out[key] = {
      name: wan.Name,
      interface: wan.Interface,
      capacityMbps: wan.CapacityMbps,
      latestRxMbps: latest ? latest.rx : null,
      latestTxMbps: latest ? latest.tx : null,
      series,
    };
  }
  res.json({ generatedAt: Date.now(), lastPollAt, lastPollError, wan: out });
});

// --- LibreNMS proxy routes -------------------------------------------------

async function proxyGet(librenmsPath, res) {
  if (!LIBRENMS_URL || !LIBRENMS_TOKEN) {
    return res.status(503).json({
      error: 'LibreNMS is not configured. Set LIBRENMS_URL and LIBRENMS_TOKEN in env/.env.',
    });
  }
  try {
    const upstream = await fetch(`${LIBRENMS_URL}/api/v0${librenmsPath}`, {
      headers: { 'X-Auth-Token': LIBRENMS_TOKEN },
    });
    const body = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `LibreNMS returned ${upstream.status}`, details: body });
    }
    res.json(body);
  } catch (err) {
    console.error(`[proxy] ${librenmsPath} failed:`, err.message);
    res.status(502).json({ error: 'Could not reach LibreNMS', details: err.message });
  }
}

app.get('/api/devices', (req, res) => proxyGet('/devices', res));
app.get('/api/devices/:id', (req, res) => proxyGet(`/devices/${encodeURIComponent(req.params.id)}`, res));
app.get('/api/devices/:id/ports', (req, res) => proxyGet(`/devices/${encodeURIComponent(req.params.id)}/ports`, res));
app.get('/api/alerts', (req, res) => proxyGet('/alerts', res));

app.get('/api/health-summary', async (req, res) => {
  if (!LIBRENMS_URL || !LIBRENMS_TOKEN) {
    return res.status(503).json({ error: 'LibreNMS is not configured. Set LIBRENMS_URL and LIBRENMS_TOKEN in env/.env.' });
  }
  try {
    const headers = { 'X-Auth-Token': LIBRENMS_TOKEN };
    const [devicesRes, alertsRes] = await Promise.all([
      fetch(`${LIBRENMS_URL}/api/v0/devices`, { headers }),
      fetch(`${LIBRENMS_URL}/api/v0/alerts?state=1`, { headers }),
    ]);
    const devices = await devicesRes.json().catch(() => ({ devices: [] }));
    const alerts = await alertsRes.json().catch(() => ({ alerts: [] }));
    const deviceList = devices.devices || [];
    const up = deviceList.filter((d) => Number(d.status) === 1).length;
    const down = deviceList.filter((d) => Number(d.status) === 0).length;
    res.json({ totalDevices: deviceList.length, up, down, activeAlerts: (alerts.alerts || []).length });
  } catch (err) {
    console.error('[health-summary] failed:', err.message);
    res.status(502).json({ error: 'Could not reach LibreNMS', details: err.message });
  }
});

// --- FortiGate proxy routes ------------------------------------------------

async function proxyFortiGet(fortiPath, res, extraParams = {}) {
  if (!FORTIGATE_URL || !FORTIGATE_TOKEN) {
    return res.status(503).json({ error: 'FortiGate is not configured. Set FORTIGATE_URL and FORTIGATE_TOKEN in env/.env.' });
  }
  try {
    const upstream = await fetch(`${FORTIGATE_URL}${fortiPath}`, {
      headers: { Authorization: `Bearer ${FORTIGATE_TOKEN}` },
    });
    const body = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `FortiGate returned ${upstream.status}`, details: body });
    }
    res.json(body);
  } catch (err) {
    console.error(`[fortigate-proxy] ${fortiPath} failed:`, err.message);
    res.status(502).json({ error: 'Could not reach FortiGate', details: err.message });
  }
}

app.get('/api/fortigate/status', (req, res) => proxyFortiGet('/api/v2/monitor/system/status', res));
app.get('/api/fortigate/resource', (req, res) => proxyFortiGet('/api/v2/monitor/system/resource/usage', res));
app.get('/api/fortigate/interfaces', (req, res) => proxyFortiGet('/api/v2/monitor/system/interface', res));

app.listen(PORT, () => {
  console.log(`Dashboard listening on port ${PORT} — LibreNMS + FortiGate + WAN throughput graph`);
});
