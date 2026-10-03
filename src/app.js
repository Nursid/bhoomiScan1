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
const requestContext = require('./middleware/requestContext');
const { globalLimiter } = require('./middleware/rateLimiters');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const v1 = require('./routes');

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
      origin: (origin, callback) => callback(null, !origin || config.corsOrigins.includes(origin)),
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
    } catch {
      res.status(503).json({ success: false, error: { code: 'NOT_READY', message: 'Database unavailable' }, requestId: req.id });
    }
  });

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

  app.use('/api/v1', globalLimiter, v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

module.exports = { createApp };
