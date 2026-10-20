# ARVIO web app for your panel

Panel mode: viewers sign in with their line (same as the TV app). Profiles, Continue Watching,
addons, collections and live TV come from the panel. The image is built by
`.github/workflows/web-panel.yml` and published as `ghcr.io/elcampione89/arvio-web:latest`.

## Install on the VPS (behind wg-easy's Traefik)

```sh
mkdir -p /docker/arvio-web && cd /docker/arvio-web
# copy docker-compose.yml here, and .env.example as .env, then fill in .env
docker compose pull && docker compose up -d
```

## Update

```sh
cd /docker/arvio-web && docker compose pull && docker compose up -d
```

## Settings (.env)

| Setting | What it is |
| --- | --- |
| `WEB_DOMAIN` | The web address; its DNS A record points at the VPS |
| `PANEL_API_URL` | The panel's app API, e.g. `https://example.com/arvio-panel/api/arvio/` |
| `PANEL_WEB_KEY` | Panel > Settings > Web app; lets the panel see viewers' real IPs |
| `TMDB_API_KEY` | TMDB v3 key, for films and series |
| `PANEL_MEDIA_PROXY` | `true` relays plain-HTTP live TV for browsers (uses VPS bandwidth) |
