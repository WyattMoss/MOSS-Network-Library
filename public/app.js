const pulseDot = document.getElementById('pulseDot');
const connText = document.getElementById('connText');
const configBanner = document.getElementById('configBanner');
const deviceRows = document.getElementById('deviceRows');
const alertList = document.getElementById('alertList');
const deviceFilter = document.getElementById('deviceFilter');
const lastUpdated = document.getElementById('lastUpdated');
const pollIntervalEl = document.getElementById('pollInterval');

let allDevices = [];
let pollTimer = null;

function setConnState(state) {
  pulseDot.classList.remove('ok', 'bad');
  if (state === 'ok') {
    pulseDot.classList.add('ok');
    connText.textContent = 'connected';
  } else if (state === 'bad') {
    pulseDot.classList.add('bad');
    connText.textContent = 'connection lost';
  } else {
    connText.textContent = 'connecting…';
  }
}

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function renderDevices(devices) {
  const filterVal = deviceFilter.value.trim().toLowerCase();
  const filtered = filterVal
    ? devices.filter((d) =>
        (d.hostname || '').toLowerCase().includes(filterVal) ||
        (d.sysName || '').toLowerCase().includes(filterVal) ||
        (d.os || '').toLowerCase().includes(filterVal)
      )
    : devices;

  if (filtered.length === 0) {
    deviceRows.innerHTML = `<tr class="empty-row"><td colspan="6">No devices match.</td></tr>`;
    return;
  }

  deviceRows.innerHTML = filtered
    .map((d) => {
      const up = Number(d.status) === 1;
      return `
        <tr>
          <td><span class="status-dot ${up ? 'up' : 'down'}"></span></td>
          <td>${escapeHtml(d.hostname || '—')}</td>
          <td>${escapeHtml(d.sysName || '—')}</td>
          <td>${escapeHtml(d.os || '—')}</td>
          <td>${escapeHtml(d.type || d.hardware || '—')}</td>
          <td>${formatUptime(d.uptime)}</td>
        </tr>`;
    })
    .join('');
}

function renderAlerts(alerts) {
  if (!alerts || alerts.length === 0) {
    alertList.innerHTML = `<li class="empty-row">No active alerts.</li>`;
    return;
  }
  alertList.innerHTML = alerts
    .map((a) => {
      const rule = a.rule || a.name || 'Alert';
      const device = a.hostname || a.device_id || '';
      const when = a.timestamp || '';
      return `
        <li>
          <div class="alert-title">${escapeHtml(rule)}</div>
          <div class="alert-meta">${escapeHtml(device)} ${when ? '· ' + escapeHtml(when) : ''}</div>
        </li>`;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed: ${res.status}`);
    err.body = body;
    throw err;
  }
  return body;
}

async function refresh() {
  try {
    const [summary, devicesResp, alertsResp] = await Promise.all([
      fetchJson('/api/health-summary'),
      fetchJson('/api/devices'),
      fetchJson('/api/alerts'),
    ]);

    configBanner.classList.add('hidden');
    setConnState('ok');

    document.getElementById('statTotal').textContent = summary.totalDevices ?? '—';
    document.getElementById('statUp').textContent = summary.up ?? '—';
    document.getElementById('statDown').textContent = summary.down ?? '—';
    document.getElementById('statAlerts').textContent = summary.activeAlerts ?? '—';

    allDevices = devicesResp.devices || [];
    renderDevices(allDevices);
    renderAlerts(alertsResp.alerts || []);

    lastUpdated.textContent = `last updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    setConnState('bad');
    if (err.body && /not configured/i.test(err.body.error || '')) {
      configBanner.classList.remove('hidden');
    }
    lastUpdated.textContent = `update failed: ${err.message}`;
  }
}

deviceFilter.addEventListener('input', () => renderDevices(allDevices));

async function init() {
  setConnState('connecting');
  let intervalMs = 30000;
  try {
    const config = await fetchJson('/api/config');
    intervalMs = config.refreshIntervalMs || 30000;
    if (!config.configured) configBanner.classList.remove('hidden');
  } catch (e) {
    // fall back to default interval
  }
  pollIntervalEl.textContent = `${Math.round(intervalMs / 1000)}s`;

  await refresh();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, intervalMs);
}

init();
