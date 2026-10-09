/** Express application (no listening, no jobs: see server.js). */

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./utils/logger');
const { prisma } = require('./database/prisma');
const { describeDatabaseUrl, describeDbError } = require('./database/diagnostics');
const requestContext = require('./middleware/requestContext');
const { globalLimiter } = require('./middleware/rateLimiters');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const v1 = require('./routes');
const authRoutes = require('./modules/auth/auth.routes');

const createApp = () => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url.startsWith('/health') },
      // Never log bodies or auth headers; method/url/status/latency only.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url.split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      // Mobile apps / server-to-server calls send no Origin and are unaffected.
      // CORS_ORIGINS=* allows any browser origin (auth is still enforced by the Bearer token).
      origin: (origin, callback) => {
        const allowed =
          !origin || config.corsOrigins.includes('*') || config.corsOrigins.includes(origin.replace(/\/+$/, '').toLowerCase());
        if (!allowed) logger.warn({ origin, allowedOrigins: config.corsOrigins }, 'CORS origin rejected');
        callback(null, allowed);
      },
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(
    express.json({
      limit: '200kb',
      // Exact bytes are kept for webhook signature verification.
      verify: (req, res, buffer) => {
        req.rawBody = buffer;
      },
    }),
  );

  app.get('/health', (req, res) => res.json({ success: true, data: { status: 'ok', uptimeSeconds: Math.round(process.uptime()) } }));
  app.get('/health/ready', async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ success: true, data: { status: 'ready', database: 'up' } });
    } catch (err) {
      const dbError = describeDbError(err);
      (req.log || logger).error({ dbError, database: describeDatabaseUrl(), requestId: req.id }, 'readiness check failed');
      res.status(503).json({
        success: false,
        error: { code: 'NOT_READY', message: 'Database unavailable', details: { name: dbError.name, code: dbError.code } },
        requestId: req.id,
      });
    }
  });

  // Razorpay test checkout page, served from the API's own origin so the browser makes
  // same-origin calls (the AppSail gateway answers CORS preflights without CORS headers).
  const paymentPage = path.join(__dirname, '..', 'payment.html');
  if (fs.existsSync(paymentPage)) {
    app.get(
      ['/payment', '/payment.html'],
      helmet.contentSecurityPolicy({
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'", 'https://*.razorpay.com'],
          frameSrc: ['https://*.razorpay.com'],
          imgSrc: ["'self'", 'data:', 'https://*.razorpay.com'],
        },
      }),
      (req, res) => res.sendFile(paymentPage),
    );
  }

  // Land verification test form; fields are built from GET /land-verification/states.
  const landPage = path.join(__dirname, '..', 'land.html');
  if (fs.existsSync(landPage)) {
    app.get(
      ['/land', '/land.html'],
      helmet.contentSecurityPolicy({
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
        },
      }),
      (req, res) => res.sendFile(landPage),
    );
  }

  if (config.apiDocsEnabled) {
    const specPath = path.join(__dirname, '..', 'docs', 'openapi.yaml');
    if (fs.existsSync(specPath)) {
      const swaggerUi = require('swagger-ui-express');
      const YAML = require('yaml');
      const spec = YAML.parse(fs.readFileSync(specPath, 'utf8'));
      app.get('/api/docs/openapi.json', (req, res) => res.json(spec));
      // Swagger UI needs inline scripts/styles; relax CSP for the docs path only.
      app.use('/api/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'BhoomiScan API' }));
    }
  }

  // Same paths as the reference backend: /api/auth/mobile-verify, /api/auth/me
  app.use('/api/auth', globalLimiter, authRoutes);
  app.use('/api/v1', globalLimiter, v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

module.exports = { createApp };
