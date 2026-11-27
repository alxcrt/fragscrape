import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const configSchema = z.object({
  proxy: z.object({
    url: z.string().optional(),
  }),
  api: z.object({
    port: z.number(),
    nodeEnv: z.enum(['development', 'production', 'test']),
    trustProxy: z.union([z.boolean(), z.number(), z.string()]),
    apiKeys: z.array(z.string().min(16, 'API keys must be at least 16 characters')),
    requireApiKey: z.boolean(),
    publicUrl: z.string(),
    legacyApi: z.boolean(),
  }),
  database: z.object({
    path: z.string(),
  }),
  logging: z.object({
    level: z.enum(['error', 'warn', 'info', 'debug']),
    fileMaxSizeMB: z.number().default(5),
    fileMaxFiles: z.number().default(5),
  }),
  rateLimit: z.object({
    windowMs: z.number(),
    maxRequests: z.number(),
  }),
  browser: z.object({
    executablePath: z.string().optional(),
  }),
  scraper: z.object({
    baseUrl: z.string().url().default('https://www.parfumo.com'),
  }),
  cache: z.object({
    perfumeDurationSeconds: z.number().default(21600), // 6 hours (ratings can change throughout the day)
    searchDurationSeconds: z.number().default(3600),   // 1 hour
  }),
  parfumo: z.object({
    loginTimeoutMs: z.number().default(300000),
    actionTimeoutMs: z.number().default(30000),
    sessionVerifyIntervalMs: z.number().default(1800000),
    authEnabled: z.boolean(),
  }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Parse TRUST_PROXY for Express's 'trust proxy' setting.
 * Unset/'false' disables it; 'true' trusts all; a number trusts that many hops;
 * anything else is passed through (e.g. 'loopback', a subnet list).
 */
function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

const config: Config = {
  proxy: {
    url: process.env.DECODO_PROXY_URL,
  },
  api: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development',
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    apiKeys: (process.env.API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean),
    requireApiKey: process.env.REQUIRE_API_KEY === 'true',
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // The original endpoints (search, saved queries, tags, account sync); off for the simple API only
    legacyApi: process.env.LEGACY_API !== 'false',
  },
  database: {
    path: process.env.DATABASE_PATH || './data/fragscrape.db',
  },
  logging: {
    level: (process.env.LOG_LEVEL as 'error' | 'warn' | 'info' | 'debug') || 'info',
    fileMaxSizeMB: parseFloat(process.env.LOG_FILE_MAX_SIZE_MB || '5'),
    fileMaxFiles: parseInt(process.env.LOG_FILE_MAX_FILES || '5', 10),
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },
  browser: {
    executablePath: process.env.BROWSER_EXECUTABLE_PATH,
  },
  scraper: {
    baseUrl: process.env.SCRAPER_BASE_URL || 'https://www.parfumo.com',
  },
  cache: {
    perfumeDurationSeconds: parseInt(process.env.CACHE_PERFUME_DURATION_SECONDS || '21600', 10),
    searchDurationSeconds: parseInt(process.env.CACHE_SEARCH_DURATION_SECONDS || '3600', 10),
  },
  parfumo: {
    loginTimeoutMs: parseInt(process.env.PARFUMO_LOGIN_TIMEOUT_MS || '300000', 10),
    actionTimeoutMs: parseInt(process.env.PARFUMO_ACTION_TIMEOUT_MS || '30000', 10),
    sessionVerifyIntervalMs: parseInt(process.env.PARFUMO_SESSION_VERIFY_INTERVAL_MS || '1800000', 10),
    authEnabled: process.env.PARFUMO_AUTH_ENABLED !== 'false',
  },
};

// Validate configuration at startup
try {
  configSchema.parse(config);
} catch (error) {
  console.error('Invalid configuration:', error);
  process.exit(1);
}

export default config;