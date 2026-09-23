import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { auditHistory } from './audit.js';
import { collectEvidence } from './rpc.js';
import { createPaymentMiddleware } from './payment.js';
import { parseAuditRequest } from './validation.js';
import { ServiceError } from './errors.js';
import type { AppConfig } from './config.js';
import type { AuditRequest, EvidenceSnapshot, RegistryConfig } from './types.js';

export interface AppDependencies {
  collect?: (request: AuditRequest, registry: RegistryConfig) => Promise<EvidenceSnapshot>;
  payment?: RequestHandler;
}

export function createApp(config: AppConfig, dependencies: AppDependencies = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.enable('case sensitive routing');
  app.enable('strict routing');
  app.set('query parser', false);
  let active = 0;
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', randomUUID());
    next();
  });
  app.get('/healthz', (_req, res) => res.json({
    ok: true, service: 'kite-memory-audit', version: '0.1.0', mode: config.mode,
    paymentNetwork: config.network, priceUsd: config.mode === 'paid' ? config.priceUsd : null,
    // Liveness only: no claim about RPC/facilitator availability.
  }));
  app.get('/v1/registries', (_req, res) => res.json({
    registries: config.registries.map(({ rpcUrl: _rpcUrl, ...publicConfig }) => publicConfig),
  }));
  const payment = config.mode === 'paid'
    ? dependencies.payment ?? createPaymentMiddleware({
      payTo: config.payTo!, network: config.network, priceUsd: config.priceUsd,
      facilitatorUrl: config.facilitatorUrl,
      resourceUrl: `${config.publicBaseUrl}/v1/memory/audit`,
    })
    : ((_req, res, next) => { res.setHeader('X-Audit-Payment-Mode', 'local-unpaid'); next(); }) satisfies RequestHandler;

  app.post('/v1/memory/audit', express.json({ limit: '8kb', strict: true }), (req, res, next) => {
    try {
      if (!req.is('application/json') || req.originalUrl.includes('?')) {
        throw new ServiceError('INVALID_REQUEST', 'Use application/json without URL query parameters.', 400);
      }
      const request = parseAuditRequest(req.body);
      const registry = config.registries.find(item => item.chainId === request.chainId && item.address.toLowerCase() === request.registry.toLowerCase());
      if (!registry) throw new ServiceError('UNSUPPORTED_REGISTRY', 'The requested chain and registry are not configured.', 400);
      res.locals.auditRequest = request;
      res.locals.registry = registry;
      next();
    } catch (error) { next(error); }
  }, payment, async (_req, res, next) => {
    if (active >= config.maxConcurrent) {
      res.setHeader('Retry-After', '5');
      next(new ServiceError('BUSY', 'Audit capacity is full. Retry later.', 503));
      return;
    }
    active++;
    try {
      const request = res.locals.auditRequest as AuditRequest;
      const snapshot = await (dependencies.collect ?? collectEvidence)(request, res.locals.registry as RegistryConfig);
      const report = auditHistory(snapshot, request.checkpoint);
      // Inconclusive reports are service failures and are not settled by x402.
      // A complete report finding a mismatch is still a successfully delivered audit.
      res.status(report.verdict === 'inconclusive' || report.checks.some(check => check.status === 'unknown') ? 503 : 200).json(report);
    } catch (error) { next(error); }
    finally { active--; }
  });
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } }));
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    if (error instanceof ServiceError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
    } else if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'Request body exceeds 8 KiB.' } });
    } else if (error?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body.' } });
    } else {
      res.status(503).json({ error: { code: 'AUDIT_UNAVAILABLE', message: 'Audit service could not complete the request.' } });
    }
  };
  app.use(errorHandler);
  return app;
}
