# VeriGate Access Control - Backend

This is the backend API server for the VeriGate Access Control system.

## 🚀 Features

- **Central Data Management**: Manages all users, access levels, and areas.
- **Synchronization**: Provides endpoints for mobile clients to sync their local databases.
- **QR Code Management**: Generates and validates secure QR codes.
- **Audit Logging**: Records all access attempts and system events.
- **RESTful API**: Exposes a comprehensive API for all client applications.

## 🛠️ Tech Stack

- **Node.js**: JavaScript runtime environment
- **TypeScript**: Typed superset of JavaScript
- **Express**: Web framework for Node.js
- **PostgreSQL**: Primary relational database
- **Redis**: In-memory data store for caching and session management

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

# QR Configuration
QR_CODE_EXPIRE_MINUTES=60
QR_CODE_REFRESH_INTERVAL=30

# Rate Limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

## 📦 Scripts

- `pnpm run dev`: Start the development server with hot-reloading.
- `pnpm run build`: Compile TypeScript to JavaScript for production.
- `pnpm run start`: Run the compiled JavaScript.
- `pnpm run setup:db`: Create the database tables and indexes.
- `pnpm run seed:db`: Populate the database with test data.
- `pnpm run type-check`: Validate TypeScript types.
