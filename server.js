// server.js
// Express backend for the LibreNMS dashboard.
// Holds LIBRENMS_URL and LIBRENMS_TOKEN server-side only — the browser
// never sees them. All frontend requests go through this proxy.

const express = require('express');
const path = require('path');

const app = express();
const LIBRE_PORT = process.env.LIBRE_PORT || 3000;

const LIBRENMS_URL = (process.env.LIBRENMS_URL || '').replace(/\/+$/, '');
const LIBRENMS_TOKEN = process.env.LIBRENMS_TOKEN || '';
const REFRESH_INTERVAL = process.env.REFRESH_INTERVAL_MS || '30000';

if (!LIBRENMS_URL || !LIBRENMS_TOKEN) {
  console.warn(
    '[startup] LIBRENMS_URL and/or LIBRENMS_TOKEN are not set. ' +
    'Copy env/.env.example to env/.env and fill them in, then restart the container.'
  );
}

app.use(express.static(path.join(__dirname, 'public')));

// Give the frontend its polling interval without exposing secrets.
app.get('/api/config', (req, res) => {
  res.json({
    refreshIntervalMs: Number(REFRESH_INTERVAL),
    configured: Boolean(LIBRENMS_URL && LIBRENMS_TOKEN),
  });
});

// Generic proxy helper: calls the LibreNMS API server-side with the token,
// so the browser only ever talks to this backend.
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
      return res.status(upstream.status).json({
        error: `LibreNMS returned ${upstream.status}`,
        details: body,
      });
    }

    res.json(body);
  } catch (err) {
    console.error(`[proxy] ${librenmsPath} failed:`, err.message);
    res.status(502).json({ error: 'Could not reach LibreNMS', details: err.message });
  }
}

app.get('/api/devices', (req, res) => proxyGet('/devices', res));
app.get('/api/devices/:id', (req, res) => proxyGet(`/devices/${encodeURIComponent(req.params.id)}`, res));
app.get('/api/devices/:id/LIBRE_PORTs', (req, res) => proxyGet(`/devices/${encodeURIComponent(req.params.id)}/LIBRE_PORTs`, res));
app.get('/api/alerts', (req, res) => proxyGet('/alerts', res));
app.get('/api/health-summary', async (req, res) => {
  // Lightweight combined view for the dashboard's top summary cards.
  if (!LIBRENMS_URL || !LIBRENMS_TOKEN) {
    return res.status(503).json({
      error: 'LibreNMS is not configured. Set LIBRENMS_URL and LIBRENMS_TOKEN in env/.env.',
    });
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

    res.json({
      totalDevices: deviceList.length,
      up,
      down,
      activeAlerts: (alerts.alerts || []).length,
    });
  } catch (err) {
    console.error('[health-summary] failed:', err.message);
    res.status(502).json({ error: 'Could not reach LibreNMS', details: err.message });
  }
});

app.listen(LIBRE_PORT, () => {
  console.log(`LibreNMS dashboard listening on LIBRE_PORT ${LIBRE_PORT}`);
});
