const pulseDot = document.getElementById('pulseDot');
const connText = document.getElementById('connText');
const connToggle = document.getElementById('connToggle');
const connDropdown = document.getElementById('connDropdown');
const connDotLibrenms = document.getElementById('connDotLibrenms');
const connStateLibrenms = document.getElementById('connStateLibrenms');
const connDotFortigate = document.getElementById('connDotFortigate');
const connStateFortigate = document.getElementById('connStateFortigate');
const configBanner = document.getElementById('configBanner');
const fortiConfigBanner = document.getElementById('fortiConfigBanner');
const deviceRows = document.getElementById('deviceRows');
const alertList = document.getElementById('alertList');
const deviceFilter = document.getElementById('deviceFilter');
const lastUpdated = document.getElementById('lastUpdated');
const pollIntervalEl = document.getElementById('pollInterval');
const wanGrid = document.getElementById('wanGrid');
const wanHistoryLabel = document.getElementById('wanHistoryLabel');

let allDevices = [];
let pollTimer = null;
const wanCharts = {}; // interfaceKey -> Chart instance

function setConnState(state) {
  pulseDot.classList.remove('ok', 'warn', 'bad');
  if (state === 'ok') {
    pulseDot.classList.add('ok');
    connText.textContent = 'all systems operational';
  } else if (state === 'warn') {
    pulseDot.classList.add('warn');
    connText.textContent = 'partial connectivity';
  } else if (state === 'bad') {
    pulseDot.classList.add('bad');
    connText.textContent = 'all connections down';
  } else {
    connText.textContent = 'connecting…';
  }
}

function setApiRowState(dotEl, stateEl, ok) {
  dotEl.classList.remove('ok', 'bad');
  dotEl.classList.add(ok ? 'ok' : 'bad');
  stateEl.textContent = ok ? 'connected' : 'disconnected';
}

function updateOverallConnState(librenmsOk, fortigateOk) {
  setApiRowState(connDotLibrenms, connStateLibrenms, librenmsOk);
  setApiRowState(connDotFortigate, connStateFortigate, fortigateOk);

  const upCount = (librenmsOk ? 1 : 0) + (fortigateOk ? 1 : 0);
  if (upCount === 2) setConnState('ok');
  else if (upCount === 1) setConnState('warn');
  else setConnState('bad');
}

connToggle.addEventListener('click', () => {
  const isOpen = !connDropdown.classList.contains('hidden');
  connDropdown.classList.toggle('hidden', isOpen);
  connToggle.setAttribute('aria-expanded', String(!isOpen));
});

document.addEventListener('click', (e) => {
  if (!document.getElementById('connStatus').contains(e.target)) {
    connDropdown.classList.add('hidden');
    connToggle.setAttribute('aria-expanded', 'false');
  }
});

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

// ---------------- Devices / Alerts (LibreNMS) ----------------

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
      if(d.status === 0){
      return `
        <tr>
          <td><span class="status-dot down"></span></td>
          <td>${escapeHtml(d.hostname || '—')}</td>
          <td>${escapeHtml(d.sysName || '—')}</td>
          <td>${escapeHtml(d.os || '—')}</td>
          <td>${escapeHtml(d.type || d.hardware || '—')}</td>
        </tr>`;
  }})
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

async function refreshLibreNMS() {
  const [summary, devicesResp, alertsResp] = await Promise.all([
    fetchJson('/api/health-summary'),
    fetchJson('/api/devices'),
    fetchJson('/api/alerts'),
  ]);

  configBanner.classList.add('hidden');

  document.getElementById('statTotal').textContent = summary.totalDevices ?? '—';
  document.getElementById('statUp').textContent = summary.up ?? '—';
  document.getElementById('statDown').textContent = summary.down ?? '—';
  document.getElementById('statAlerts').textContent = summary.activeAlerts ?? '—';

  allDevices = devicesResp.devices || [];
  renderDevices(allDevices);
  renderAlerts(alertsResp.alerts || []);
}

deviceFilter.addEventListener('input', () => renderDevices(allDevices));

// ---------------- WAN throughput (FortiGate, charted, SQLite-backed) ----------------

function fmtMbps(v) {
  if (v === null || v === undefined) return '—';
  return `${v.toFixed(1)} Mbps`;
}

function ensureWanCard(key, name) {
  if (document.getElementById(`wan-card-${key}`)) return;

  document.getElementById('wanLoading')?.remove();

  const card = document.createElement('div');
  card.className = 'wan-card';
  card.id = `wan-card-${key}`;
  card.innerHTML = `
    <div class="wan-card-head">
      <div><span class="wan-card-title">${escapeHtml(name || key)}</span><span class="wan-card-iface">${escapeHtml(key)}</span></div>
      <div class="wan-live-values">
        <span class="rx">↓ <span id="wan-rx-${key}">—</span></span>
        <span class="tx">↑ <span id="wan-tx-${key}">—</span></span>
      </div>
    </div>
    <div class="wan-chart-wrap"><canvas id="wan-canvas-${key}"></canvas></div>
  `;
  wanGrid.appendChild(card);

  const ctx = document.getElementById(`wan-canvas-${key}`);
  wanCharts[key] = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'In (Mbps)',
          data: [],
          borderColor: '#4fd1e8',
          backgroundColor: 'rgba(79, 209, 232, 0.1)',
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 1.5,
        },
        {
          label: 'Out (Mbps)',
          data: [],
          borderColor: '#f5a623',
          backgroundColor: 'rgba(245, 166, 35, 0.08)',
          fill: true,
          tension: 0.25,
          pointRadius: 0,
          borderWidth: 1.5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          type: 'time',
          time: { unit: 'minute' },
          ticks: { color: '#7c8a94', font: { family: 'IBM Plex Mono', size: 10 } },
          grid: { color: '#232b31' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#7c8a94', font: { family: 'IBM Plex Mono', size: 10 } },
          grid: { color: '#232b31' },
        },
      },
      plugins: {
        legend: { labels: { color: '#d7dee4', font: { family: 'Inter', size: 11 }, boxWidth: 12 } },
      },
    },
  });
}

async function refreshWan() {
  const data = await fetchJson('/api/wan/history');
  fortiConfigBanner.classList.add('hidden');

  const interfaces = Object.entries(data.wan || {});
  if (interfaces.length === 0) {
    wanGrid.innerHTML = `<p class="empty-row">No WAN interfaces configured in env/config.json.</p>`;
    return;
  }

  for (const [key, info] of interfaces) {
    ensureWanCard(key, info.name);

    document.getElementById(`wan-rx-${key}`).textContent = fmtMbps(info.latestRxMbps);
    document.getElementById(`wan-tx-${key}`).textContent = fmtMbps(info.latestTxMbps);

    const chart = wanCharts[key];
    if (chart && info.series && Array.isArray(info.series)) {
      chart.data.datasets[0].data = info.series.map((p) => ({ x: new Date(p.t), y: p.rx }));
      chart.data.datasets[1].data = info.series.map((p) => ({ x: new Date(p.t), y: p.tx }));
      chart.update();
    }
  }
}

async function checkFortigate() {
  const data = await fetchJson('/api/wan/history');
  fortiConfigBanner.classList.add('hidden');
  
  // If the server reports a polling error, FortiGate is not connected
  if (data.lastPollError) {
    const err = new Error(data.lastPollError);
    err.body = { error: data.lastPollError };
    throw err;
  }
}

// ---------------- Poll loop ----------------

async function refresh() {
  const results = await Promise.allSettled([refreshLibreNMS(), checkFortigate()]);
  const [libreResult, wanResult] = results;
  const librenmsOk = libreResult.status === 'fulfilled';
  const fortigateOk = wanResult.status === 'fulfilled';

  updateOverallConnState(librenmsOk, fortigateOk);

  const failed = results.filter((r) => r.status === 'rejected');

  if (failed.length === 0) {
    lastUpdated.textContent = `last updated ${new Date().toLocaleTimeString()}`;
    return;
  }

  for (const r of failed) {
    const err = r.reason;
    if (err?.body && /LibreNMS is not configured/i.test(err.body.error || '')) {
      configBanner.classList.remove('hidden');
    }
    if (err?.body && /FortiGate is not configured/i.test(err.body.error || '')) {
      fortiConfigBanner.classList.remove('hidden');
    }
  }
  lastUpdated.textContent = failed.length === results.length
    ? `update failed: ${failed[0].reason.message}`
    : `last updated ${new Date().toLocaleTimeString()} (partial)`;
}

async function init() {
  setConnState('connecting');
  let intervalMs = 30000;
  try {
    const config = await fetchJson('/api/config');
    intervalMs = config.refreshIntervalMs || 30000;
    if (!config.configured) configBanner.classList.remove('hidden');
    if (!config.fortigateConfigured) fortiConfigBanner.classList.remove('hidden');
    wanHistoryLabel.textContent = `${config.wanHistoryRetentionHours}h history`;
  } catch (e) {
    // fall back to defaults
  }
  pollIntervalEl.textContent = `${Math.round(intervalMs / 1000)}s`;

  await refresh();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, intervalMs);
}

init();
