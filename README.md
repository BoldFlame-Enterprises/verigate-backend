# Backend API Server

The backend API server for the QR Code-based Accreditation System.

## 🏗️ Architecture

- **Framework**: Node.js with Express and TypeScript
- **Database**: PostgreSQL with connection pooling
- **Caching**: Redis integration (optional)
- **Security**: Argon2id password hashing, JWT authentication, rate limiting

## 🚀 Quick Start

```bash
# Install dependencies
pnpm install

# Setup environment
cp .env.example .env
# Edit .env with your database credentials

# Setup database
pnpm run setup:db

# Seed test data
pnpm run seed:db

# Start development server
pnpm run dev
```

## 📚 API Endpoints

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - User login
- `POST /api/auth/refresh` - Refresh access token
- `GET /api/users/me` - Get current user profile
- `GET /api/qr/generate` - Generate QR code for user
- `POST /api/scan/verify` - Verify scanned QR code
- `GET /api/admin/*` - Admin endpoints (admin only)

## 🔐 Test Users

- `admin@test.com / password123` (Admin)
- `scanner@test.com / password123` (Scanner volunteer)
- `vip@test.com / password123` (VIP user)
- `staff@test.com / password123` (Staff member)
- `general@test.com / password123` (General user)

## 🛠️ Development

```bash
pnpm run dev          # Start development server
pnpm run build        # Build for production
pnpm run type-check   # TypeScript type checking
pnpm run test         # Run tests
