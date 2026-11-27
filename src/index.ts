import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import config from './config/config';
import logger from './utils/logger';
import database from './database/database';
import { isProxyConfigured } from './proxy/proxyConfig';
import perfumeRoutes from './api/routes/perfume';
import proxyRoutes from './api/routes/proxy';
import queryRoutes from './api/routes/queries';
import perfumeDataRoutes, { collectionRouter, tagsRouter, cleanupRouter } from './api/routes/perfumeData';
import authRoutes from './api/routes/auth';
import parfumoCollectionRoutes from './api/routes/parfumoCollection';
import parfumoRatingRoutes from './api/routes/parfumoRating';
import parfumoReviewRoutes from './api/routes/parfumoReview';
import syncRoutes from './api/routes/sync';
import rankingsRoutes from './api/routes/rankings';
import cacheRoutes from './api/routes/cache';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler';
import { displayStartupBanner } from './utils/banner';
import { TIMEOUT_CONFIG } from './constants/scraping';
import { apiKeyAuth } from './api/middleware/apiKeyAuth';
import { requireParfumoAuthEnabled } from './api/middleware/parfumoAuthGuard';
import browserClient from './proxy/browserClient';
import swaggerUi from 'swagger-ui-express';
import simpleRoutes, { imagesRouter } from './api/routes/simple';
import { initCatalog } from './catalog/catalog';
import { seed as seedCatalog } from './catalog/service';
import { openapiSpec } from './apiDocs/openapi';

const app = express();

// Behind a reverse proxy (Caddy/Traefik), use the forwarded client IP for rate limiting
app.set('trust proxy', config.api.trustProxy);

// Middleware
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API documentation (public; requests made from it still need an API key)
app.get('/openapi.json', (_req, res) => res.json(openapiSpec));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
  customSiteTitle: 'Fragrance API',
  customCss: '.swagger-ui .topbar { display: none }',
  swaggerOptions: { persistAuthorization: true, tryItOutEnabled: true },
}));
app.get('/', (_req, res) => res.redirect('/docs'));
app.use('/images', imagesRouter);

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: 'Too many requests from this IP, please try again later.',
});

app.use('/api', limiter);
app.use('/api', apiKeyAuth);

app.get('/health', (_req, res) => {
  try {
    const dbOk = database.healthCheck();
    const memUsage = process.memoryUsage();
    const uptimeSeconds = process.uptime();
    const uptimeHours = Math.floor(uptimeSeconds / 3600);
    const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);

    res.json({
      status: dbOk ? 'healthy' : 'degraded',
      timestamp: new Date(),
      environment: config.api.nodeEnv,
      uptime: {
        seconds: Math.floor(uptimeSeconds),
        readable: `${uptimeHours}h ${uptimeMinutes}m`,
      },
      database: { status: dbOk ? 'ok' : 'error' },
      parfumoAuth: { enabled: config.parfumo.authEnabled },
      apiKeyRequired: config.api.apiKeys.length > 0,
      proxy: { configured: isProxyConfigured() },
      memory: {
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        rssMB: Math.round(memUsage.rss / 1024 / 1024),
      },
    });
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(503).json({
      status: 'error',
      timestamp: new Date(),
      error: 'Health check failed',
    });
  }
});

// Simple API (autocomplete, match, perfume details, brands, rankings)
app.use('/api', simpleRoutes);

// Original endpoints, kept for compatibility unless LEGACY_API=false
if (config.api.legacyApi) {
  app.use('/api', perfumeRoutes);
  app.use('/api/proxy', proxyRoutes);
  app.use('/api/queries', queryRoutes);
  app.use('/api/perfumes', perfumeDataRoutes);
  app.use('/api/collection', collectionRouter);
  app.use('/api/tags', tagsRouter);
  app.use('/api/cleanup', cleanupRouter);
  // Parfumo account features need a visible browser; refuse them cleanly on headless servers
  app.use('/api/auth/login', requireParfumoAuthEnabled);
  app.use('/api/auth/status', requireParfumoAuthEnabled);
  app.use('/api/parfumo', requireParfumoAuthEnabled);
  app.use('/api/sync/push', requireParfumoAuthEnabled);
  app.use('/api/sync/pull', requireParfumoAuthEnabled);
  app.use('/api/auth', authRoutes);
  app.use('/api/parfumo/collection', parfumoCollectionRoutes);
  app.use('/api/parfumo/rating', parfumoRatingRoutes);
  app.use('/api/parfumo/reviews', parfumoReviewRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api', rankingsRoutes);
  app.use('/api/cache', cacheRoutes);
}

// Error handlers
app.use(notFoundHandler);
app.use(errorHandler);

// Global server variable
let server: any;

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Stop accepting new requests
  server?.close(async () => {
    try {
      await browserClient.close().catch((err) => logger.warn('Error closing browser:', err));
      database.close();

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  });

  // Force shutdown after timeout
  setTimeout(() => {
    logger.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, TIMEOUT_CONFIG.GRACEFUL_SHUTDOWN);
};

// Start server
const startServer = async () => {
  try {
    if (config.api.requireApiKey && config.api.apiKeys.length === 0) {
      throw new Error('REQUIRE_API_KEY=true but API_KEYS is empty; refusing to start an open API');
    }
    if (config.api.apiKeys.length === 0) {
      logger.warn('API_KEYS is not set - /api endpoints are open to anyone who can reach this server');
    }

    await database.initialize();
    initCatalog();
    void seedCatalog();

    if (!isProxyConfigured()) {
      logger.warn('DECODO_PROXY_URL is not set - scraping will use direct connections (no proxy)');
    }

    // Start server
    const port = config.api.port;
    server = app.listen(port, () => {
      logger.info(`🚀 Fragscrape API server running on port ${port}`);

      // Read version from package.json
      const packageJson = require('../package.json');
      displayStartupBanner({ version: packageJson.version, port });
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start the server
startServer();