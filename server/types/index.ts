import { Request } from 'express';

export interface User {
  id: number;
  email: string;
  name: string;
  phone: string;
  password_hash: string;
  device_id: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AccessLevel {
  id: number;
  name: string;
  description: string;
  priority: number;
  is_active: boolean;
}

export interface Area {
  id: number;
  name: string;
  description: string;
  requires_scan: boolean;
  is_active: boolean;
}

export interface AccessAssignment {
  id: number;
  user_id: number;
  access_level_id: number;
  area_id: number;
  valid_from: Date;
  valid_until: Date;
  is_active: boolean;
}

export interface ScanLog {
  id: number;
  user_id: number;
  area_id: number;
  scanner_user_id: number;
  access_granted: boolean;
  failure_reason: string | null;
  scanned_at: Date;
  device_info: string;
}

export interface JWTPayload {
  id: number;
  email: string;
  role: string;
  iat: number;
  exp: number;
}

export interface QRCodePayload {
  uid: string; // encrypted user id
  alh: string; // access level hash
  ts: number;  // timestamp
  dfp: string; // device fingerprint
  vt: string;  // validation token
}

export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends APIResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AuthRequest extends Request {
  user?: {
    id: number;
    email: string;
    role: string;
  };
}

export interface CreateUserRequest {
  email: string;
  name: string;
  phone: string;
  password: string;
  access_level_id: number;
  area_ids: number[];
}

export interface UpdateUserRequest {
  name?: string;
  phone?: string;
  is_active?: boolean;
  access_level_id?: number;
  area_ids?: number[];
}

export interface ScanRequest {
  qr_code: string;
  area_id: number;
  device_info: string;
}

export interface QRGenerateRequest {
  user_id: number;
  device_fingerprint: string;
}

export enum UserRole {
  ADMIN = 'admin',
  SCANNER = 'scanner',
  USER = 'user'
}

export enum AccessLevelType {
  GENERAL = 'general',
  VIP = 'vip',
  STAFF = 'staff',
  SECURITY = 'security',
  MANAGEMENT = 'management'
}

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
}

export interface AppConfig {
  port: number;
  nodeEnv: string;
  jwtSecret: string;
  jwtRefreshSecret: string;
  jwtExpireTime: string;
  jwtRefreshExpireTime: string;
  encryptionKey: string;
  pepperSecret: string;
  qrCodeExpireMinutes: number;
  qrCodeRefreshInterval: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  database: DatabaseConfig;
  redis: RedisConfig;
}
