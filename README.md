# Line / Value

A local-first production-line price and profitability calculator for Seed.
It imports changing recipe JSON, follows upstream production routes, accounts
for manual and autonomous time, applies skill requirements, and compares NPC
payouts in seedcoin per production-hour.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

The development server opens on `http://localhost:3000` by default.

## Validation

```bash
npm test
```

## Docker deployment

The shortest self-hosted deployment is:

```bash
docker compose up -d --build
```

The application is then available on port 3000. See
[DEPLOYMENT.md](./DEPLOYMENT.md) for updates, logs, port changes, and an HTTPS
reverse-proxy example.

## Data storage

The bundled recipe dataset ships inside the application image. Imported data,
NPC payouts, skill levels, disabled lines, and display preferences are stored
locally in each visitor's browser. No database or persistent Docker volume is
required.
