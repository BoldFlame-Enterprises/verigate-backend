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

export interface Event {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface EventMember {
  id: number;
  event_id: number;
  user_id: number;
  role_in_event: string;
  is_active: boolean;
  joined_at: Date;
}

export interface DeviceToken {
  id: number;
  user_id: number;
  event_id: number;
  token: string;
  platform: 'android' | 'ios';
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface AccessLevel {
  id: number;
  event_id: number;
  name: string;
  description: string;
  priority: number;
  is_active: boolean;
}

export interface Area {
  id: number;
  event_id: number;
  name: string;
  description: string;
  requires_scan: boolean;
  is_active: boolean;
}

export interface AccessAssignment {
  id: number;
  event_id: number;
  user_id: number;
  access_level_id: number;
  area_id: number;
  valid_from: Date;
  valid_until: Date;
  is_active: boolean;
}

export interface CredentialAssignment {
  area_id: number;
  area_name: string;
  access_level_id: number;
  access_level_name: string;
  access_priority: number;
  valid_from: string;
  valid_until: string;
}

export interface EventUserProjection {
  id: number;
  event_id: number;
  email: string;
  name: string;
  phone: string;
  is_active: boolean;
  assignments: CredentialAssignment[];
}

export interface ScanLog {
  id: number;
  event_id: number;
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

export interface QueueRecordResult {
  client_record_id: string;
  status: 'accepted' | 'duplicate' | 'retryable_error' | 'rejected';
  server_id?: number;
  error?: string;
}

export const QUEUE_ACK_CONTRACT_VERSION = 'queue-ack-v2' as const;

export interface QueueRecordAcknowledgement<T = unknown> {
  contract_version: typeof QUEUE_ACK_CONTRACT_VERSION;
  client_record_id?: string;
  status: 'accepted' | 'duplicate' | 'retryable_error' | 'rejected';
  record?: T;
  validation_errors?: unknown[];
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
  event?: {
    id: number;
    role: string;
    isGlobalAdmin: boolean;
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
  event_id: number;
  device_info: string;
}

export interface QRGenerateRequest {
  user_id: number;
  device_fingerprint: string;
}

export interface CreateEventRequest {
  name: string;
  slug: string;
  description?: string;
  starts_at?: string;
  ends_at?: string;
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
