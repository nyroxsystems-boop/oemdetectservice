# 🤖 Catalog Scraper — PartsLink24 Automation

Standalone Playwright-basierter Service der automatisch OEM-Teilenummern auf PartsLink24 nachschlägt.

## Setup

```bash
# 1. Dependencies installieren
npm install

# 2. Playwright Browser installieren
npm run install:browsers

# 3. .env konfigurieren
cp .env.example .env
# → PL24_USERNAME und PL24_PASSWORD eintragen

# 4. Starten
npm run dev
```

## API

### POST /api/lookup
```json
{
  "vin": "WBAAT51010FW14413",
  "part": "Ölfilter"
}
```

Response:
```json
{
  "success": true,
  "vin": "WBAAT51010FW14413",
  "part": "Ölfilter",
  "results": [
    { "oem": "11 42 7 508 966", "description": "Ölfilter mit Kunststoffdeckel" },
    { "oem": "11 42 7 508 968", "description": "Ölfilterdeckel" }
  ],
  "fromCache": false,
  "elapsedMs": 7500
}
```

### GET /api/health
### GET /api/cache/stats

## Architektur

```
Request → Cache Check → Hit? → Return cached result
                    ↓ Miss
           Playwright Browser
                    ↓
           Login → VIN → Search → Extract
                    ↓
           Cache result + Return
```

## Konfiguration (.env)

| Variable | Default | Beschreibung |
|---|---|---|
| `PL24_USERNAME` | — | PartsLink24 Benutzername |
| `PL24_PASSWORD` | — | PartsLink24 Passwort |
| `PORT` | 4100 | API Server Port |
| `HEADLESS` | true | Browser unsichtbar |
| `REQUEST_DELAY_MS` | 3000 | Pause zwischen Requests |
| `CACHE_TTL_SECONDS` | 2592000 | Cache-Gültigkeit (30 Tage) |

## Hinweise

- **Headless=false** setzen zum Debuggen (Browser wird sichtbar)
- Erste Anfrage dauert länger (Login + Session-Aufbau)
- Folgende Anfragen nutzen Session-Cookies
- Cache speichert alle erfolgreichen Lookups in SQLite
