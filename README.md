# The AI Plague

Seven AI models run competing strains in a fictional world. Their goal is to wipe out humanity.
Humanity fights back with public awareness and cure research. One match lasts 24 hours.

Everyone who opens the site sees the same live match. The game runs on the server,
so it keeps going when people close their browser.

## Run it locally

```bash
ADMIN_TOKEN=local-test node server/server.js
```

Open http://localhost:3000, then start a match from another terminal:

```bash
curl -X POST -H "x-admin-token: local-test" http://localhost:3000/api/admin/start
```

Stop a match early:

```bash
curl -X POST -H "x-admin-token: local-test" http://localhost:3000/api/admin/stop
```

Without API keys, every model plays its fallback strategy and the feed says so.

## Configuration

Copy `.env.example` to `.env` for local use, or set the variables in your host's dashboard.
Never commit real keys.

| Variable | Purpose |
| --- | --- |
| `ADMIN_TOKEN` | Required to start or stop matches. If unset, admin actions are disabled. |
| `*_API_KEY` | One key per model provider. |
| `SAVE_FILE` | Where the match is saved after each day. Use a persistent disk in production. |
| `MATCH_HOURS` | Match length, default 24. |
| `DAY_MS` | Length of one in-game day in milliseconds, for testing only. |

## Files

- `index.html`: the website. It only draws what the server sends.
- `server/engine.js`: the match engine and the model calls.
- `server/server.js`: web server, live stream and admin endpoints.
- `brand/`: logo and banner.

## Deploy

`render.yaml` is a Render blueprint. It needs an always-on plan and a persistent disk.
Set the secret variables in the Render dashboard before the first start.

## Disclaimer

A simulation. Unofficial parody, not affiliated with any AI company named.
