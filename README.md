# VeriGate Access Control - Backend

This is the backend API server for the VeriGate Access Control system.

## 🚀 Features

- **Multi-event tenancy**: `events` is first-class; access levels, areas, assignments, and scan logs are all scoped to an event. Membership is **multi-event** — a user can belong to more than one event over time (see `event_members`), separate from per-area `access_assignments`.
- **QR v2 verification, one path**: the backend signs event/device-bound P-256 credentials and `services/qrVerification.ts` applies signature, expiry, credential-version, event, device, and current DB-assignment checks for both verification routes.
- **Full CRUD**: users (+ bulk CSV import/export), events, areas, access levels, access assignments, incidents, and emergency overrides.
- **Redis caching (fail-open)**: hot reads (sync payloads, admin dashboard, analytics) are cached with short TTLs and explicit invalidation on writes; a missing/unreachable Redis degrades to Postgres, never a 500 — see "Caching" below.
- **Notifications**: Android push is real (Firebase Cloud Messaging via `firebase-admin`); iOS push is fully implemented over raw HTTP/2 + JWT provider tokens but gated behind `APNS_ENABLED` (default off, since it needs a paid Apple Developer account).
- **Sync hardening**: delta sync (`/api/sync/check-updates`), client-generated `device_scan_id` de-duplication for scan-log uploads, and a `device_sync_status` heartbeat for the dashboard's real-time monitor.

## 🛠️ Tech Stack

- **Node.js** + **TypeScript**, **Express**, **PostgreSQL**, **Redis** (`argon2` for password hashing, `jsonwebtoken` for JWT, `express-validator` for input validation — no ORM, raw `pg`)

## 🗄️ Schema (source of truth: `server/scripts/setup-database.ts`)

`events`, `event_members`, `users`, `access_levels`, `areas`, `access_assignments`, `scan_logs`, `device_credentials`, `device_tokens`, `device_sync_status`, `incidents`, `emergency_overrides`. After the event migration, run `npm run migrate:contracts` to add QR credential and idempotent queue fields to an existing database.

## 🧰 Caching (Redis, fail-open)

| Cache key | TTL | Invalidated by |
|---|---|---|
| `sync:users-database:<event_id>` | 30s | access-level/assignment writes |
| `sync:areas-database:<event_id>` | 300s | area writes |
| `event:<event_id>:dashboard` | 15s | TTL only (scans arrive continuously) |
| `analytics:<event_id>:scan-volume` | 60s | TTL only |
| `analytics:<event_id>:breakdown` | 60s | area/access-level/assignment writes |

If Redis is down, every one of these reads falls straight through to Postgres — `getCache`/`setCache` swallow errors and return `null`/no-op.

## ⚙️ Configuration

Create a `.env` file in the `backend` directory with the following variables:

```bash
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=verigate_access_control
DB_USER=postgres
DB_PASSWORD=your_secure_password

# Redis (Optional)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# JWT Security
JWT_SECRET=your_production_jwt_secret_256_bits_minimum
JWT_REFRESH_SECRET=your_production_refresh_secret
JWT_EXPIRE_TIME=1h
JWT_REFRESH_EXPIRE_TIME=7d

# Encryption
ENCRYPTION_KEY=your_32_character_encryption_key
PEPPER_SECRET=additional_password_security_pepper

# QR authority (base64 PKCS#8 DER P-256 private key; inject as a secret)
QR_AUTHORITY_PRIVATE_KEY_BASE64=

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# Push notifications - Android FCM (free tier)
FCM_PROJECT_ID=
FCM_CLIENT_EMAIL=
FCM_PRIVATE_KEY=

# Push notifications - iOS APNs (gated, default off - needs a paid Apple Developer account)
APNS_ENABLED=false
APNS_KEY_PATH=
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_BUNDLE_ID=
APNS_PRODUCTION=false
```

## 📦 Scripts

- `npm run dev`: Start the development server with hot-reloading.
- `npm run build`: Compile TypeScript to JavaScript for production.
- `npm start`: Run the compiled JavaScript.
- `npm run setup:db`: Create a fresh database (full current schema, including events).
- `npm run migrate:events`: Upgrade an existing pre-events database in place (idempotent).
- `npm run migrate:contracts`: Add QR credential and queue contract storage (idempotent).
- `npm run seed:db`: Populate the database with a demo event + test data.
- `npm run type-check`: Validate TypeScript types.
- `npm test`: Run the Jest test suite (route + service tests, mocked DB/Redis).
