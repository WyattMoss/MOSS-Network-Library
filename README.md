# NetWatch — LibreNMS Dashboard

A small, self-hosted dashboard for a [LibreNMS](https://www.librenms.org/) instance.
The container talks to the LibreNMS API on the server side, so your API token
never touches the browser. Everything runs from a single `docker compose up`.

## What's inside

```
librenms-dashboard/
├── env/
│   └── .env.example    ← copy to env/.env and fill in
├── public/              ← static dashboard (HTML/CSS/JS)
├── server.js             ← Express backend / API proxy
├── Dockerfile
└── docker-compose.yml
```

The browser only ever calls `/api/*` on this app. The backend is the only
thing that holds `LIBRENMS_URL` and `LIBRENMS_TOKEN`, and it attaches the
`X-Auth-Token` header when it calls LibreNMS.

## Setup (Docker — recommended)

1. **Get a LibreNMS API token**
   In LibreNMS: *Settings → API → Manage API Tokens* → create a token for a
   read-only (or full) user.

2. **Configure**
   ```bash
   cp env/.env.example env/.env
   ```
   Edit `env/.env`:
   ```env
   LIBRENMS_URL=https://librenms.example.com
   LIBRENMS_TOKEN=your-token-here
   REFRESH_INTERVAL_MS=30000
   HOST_PORT=8080
   ```

3. **Run it**
   ```bash
   docker compose up -d --build
   ```

4. **Open it**
   Visit `http://localhost:8080` (or whatever `HOST_PORT` you set).

That's the whole setup. `env/.env` is gitignored, so your token stays local
and is never baked into the image.

To stop it:
```bash
docker compose down
```

To pick up a change to `env/.env`:
```bash
docker compose restart
```

## Setup (without Docker)

```bash
npm install
cp env/.env.example env/.env   # then edit it
export $(grep -v '^#' env/.env | xargs)   # or use a tool like dotenv-cli
npm start
```

The app listens on `PORT` (default `3000`).

## What it shows

- **Summary cards** — total devices, devices up/down, active alerts
- **Device table** — status, hostname, sysName, OS, hardware type, uptime,
  with a live filter box
- **Active alerts** — pulled from LibreNMS's `/alerts?state=1`

It polls on the interval set by `REFRESH_INTERVAL_MS` (default 30s).

## API endpoints this app exposes

These are served by the Node backend, not LibreNMS directly:

| Route | Purpose |
|---|---|
| `GET /api/config` | Poll interval + whether env vars are set |
| `GET /api/health-summary` | Aggregated counts for the top cards |
| `GET /api/devices` | Proxies LibreNMS `/devices` |
| `GET /api/devices/:id` | Proxies LibreNMS `/devices/:id` |
| `GET /api/devices/:id/ports` | Proxies LibreNMS `/devices/:id/ports` |
| `GET /api/alerts` | Proxies LibreNMS `/alerts` |

## Troubleshooting

- **Yellow "Not configured" banner** — `env/.env` is missing or the two
  LibreNMS variables are blank. Fill them in and `docker compose restart`.
- **"Could not reach LibreNMS"** — check `LIBRENMS_URL` is reachable from
  inside the container (not just your host) and has no trailing slash.
- **401/403 from LibreNMS** — the token is invalid, revoked, or belongs to a
  user without API permissions.
