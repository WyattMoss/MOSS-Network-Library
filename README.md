# NetWatch — LibreNMS + FortiGate Dashboard

A self-hosted dashboard combining:
- **LibreNMS** device/alert monitoring (device table, status, active alerts)
- A **WAN throughput graph** (input/output over time for your FortiGate's
  WAN interfaces), backed by a small rolling SQLite history, and jsdelivr's API for the graph.

Everything runs in one container on one port. The browser never sees your
API tokens — the Node backend holds them and proxies all API calls.

## What's inside

```
network-dashboard/
├── env/
│   ├── .env.example    ← copy to env/.env, fill in tokens
│   └── config.json     ← which WAN interfaces to graph (edit anytime)
├── data/                ← SQLite history file lives here (auto-created)
├── public/               ← dashboard UI (HTML/CSS/JS + Chart.js)
├── server.js              ← Express backend: LibreNMS + FortiGate proxy + WAN poller
├── Dockerfile
└── docker-compose.yml
```

## Setup

1. **Get your tokens**
   - LibreNMS: *Settings → API → Manage API Tokens*
   - FortiGate: *System → Admin Profiles* → create a REST API Admin → generate a token

2. **Configure secrets**
   ```bash
   cp env/.env.example env/.env
   ```
   Edit `env/.env`:
   ```env
   LIBRENMS_URL=https://librenms.example.com
   LIBRENMS_TOKEN=your-librenms-token

   FORTIGATE_URL=https://192.168.1.1:443
   FORTIGATE_TOKEN=your-fortigate-token
   FORTIGATE_VDOM=root
   FORTIGATE_INSECURE_TLS=false   # true only if using a self-signed cert on a trusted network

   WAN_POLL_INTERVAL_MS=30000
   WAN_HISTORY_RETENTION_HOURS=3
   HOST_PORT=8080
   ```

3. **Pick which interfaces to graph** — `env/config.json`:
   ```json
   {
     "WanInterfaces": [
       { "Name": "Metronet", "Interface": "wan1", "CapacityMbps": 500 },
       { "Name": "ATT",      "Interface": "wan2", "CapacityMbps": 500 }
     ]
   }
   ```
   `Interface` must match the exact interface name on your FortiGate
   (Network → Interfaces). `Name` is just a friendly label for the chart.
   This file is mounted into the container, so editing it and saving takes
   effect on the **next poll** — no rebuild needed.

4. **Run it**
   ```bash
   docker compose up -d --build
   ```

5. **Open it**
   `http://localhost:8080` (or whatever `HOST_PORT` you set)

## How the WAN graph works

- Every `WAN_POLL_INTERVAL_MS`, the backend calls FortiGate's
  `/api/v2/monitor/system/interface`, reads each configured interface's
  cumulative `rx_bytes`/`tx_bytes` counters, and converts the delta since
  the last poll into Mbps in/out.
- Each sample is written to a SQLite file at `./data/wan-history.sqlite`
  (mounted from the host, so it survives container restarts and you can
  inspect it directly).
- On every poll, rows older than `WAN_HISTORY_RETENTION_HOURS` are deleted
  — so the file stays small and only ever holds a few hours of history.
- The frontend polls `/api/wan/history` and redraws the in/out line charts using jsdelivr's API client.

If you ever want to reset the history, just stop the container and delete
`data/wan-history.sqlite*`.

## What the dashboard shows

- **WAN Throughput** (top) — one chart per configured interface, in/out
  Mbps over the retention window, plus live current values all through Fortigate's API Client
- **Summary cards** — total devices, up/down, active alerts (LibreNMS)
- **Device table** — status, hostname, sysName, OS, hardware, uptime, with
  a live filter box
- **Active alerts** — from LibreNMS's `/alerts?state=1`

## Commands

| Task | Command |
|---|---|
| Start | `docker compose up -d --build  --remove-orphans` |
| View logs | `docker compose logs -f` |
| Stop | `docker compose down` |
| Restart after editing `env/.env` | `docker compose restart` |
| Pick up code changes | `docker compose up -d --build` |
| Push changes on git - all files (easy for MOSS guys lol) | `git add . git commit -m "MESSAGE HERE" git push` |
| Create a clone of a repo - your own just local changes without pull requests| `git clone URL_HERE` |
| Pull changes from a repo | `git pull` |

`env/config.json` changes don't need a restart — it's re-read every poll.

## Troubleshooting

- **Yellow banners in the UI** — the corresponding `env/.env` values are
  missing. Fill them in and `docker compose restart`.
- **WAN chart stays empty** — check `docker compose logs -f` for
  `[poll] Interface "wanX" not found in FortiGate response.` — the
  `Interface` name in `config.json` doesn't match your FortiGate's actual
  interface name.
- **"Could not reach FortiGate"** — check `FORTIGATE_URL` is reachable
  from inside the container, and `FORTIGATE_INSECURE_TLS=true` if it uses
  a self-signed cert.
- **401/403 from FortiGate or LibreNMS** — token is invalid, revoked, or
  lacks permissions.


## For MOSS Specifically
- **Updating the client** — Push changes to main on this repo, pull changes on the RasPi, shutdown the old docker container living on the RasPi, and rebuild using the commands above
- **Thanks for a great summer!** — LMK if anything needs to be added as I can help with the program and what's going on.
- **Creating your own clone** — Currently the RasPi uses my repo, if you decide to make your own changes please run the following commands to make the transition as easy as possible
  1. **End Previous Running Containers** 
    '''bash
      docker compose down
    '''
  2. **Clone your repo** — Set your repo to public and download
    '''bash
      cd ~
      cd YOUR_GIT_PROJECT_NAME
      git clone YOUR_GIT_URL_HERE
    '''
  3. **Run the project** — Run using docker commands shown earlier
    '''bash
      docker compose build
      docker compose up
    '''
  