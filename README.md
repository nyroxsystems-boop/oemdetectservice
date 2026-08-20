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
| `OEM_DATABASE_URL` | — | Optionale persistente OEM-PostgreSQL-Datenbank |
| `OEM_DATABASE_SSL_MODE` | `verify-full` | Zertifikatsprüfung; `disable` nur für interne Hosts |
| `OEM_DATABASE_SSL_CA` | — | Optionale CA für verifiziertes TLS |
| `OEM_DATABASE_REQUIRED` | `false` | Start ohne konfigurierte OEM-Datenbank verbieten |
| `OEM_DATABASE_ALLOW_DEGRADED` | `false` | Nur Entwicklung: expliziter SQLite-Fallback bei DB-Fehler |

## Hinweise

- **Headless=false** setzen zum Debuggen (Browser wird sichtbar)
- Erste Anfrage dauert länger (Login + Session-Aufbau)
- Folgende Anfragen nutzen Session-Cookies
- Cache speichert alle erfolgreichen Lookups in SQLite
- Eine konfigurierte OEM-Datenbank ist fail-closed: in Produktion beendet jeder
  Verbindungs-, TLS-, Migrations- oder Schemafehler den Start. In Entwicklung ist
  ein Fallback nur mit `OEM_DATABASE_ALLOW_DEGRADED=true` möglich.
- OEM-Migrationen laufen transaktional unter einem Advisory Lock. Bereits
  vorhandene Legacy-Migrationseinträge werden erst nach Schema-Prüfung mit einer
  SHA-256-Checksumme übernommen.
