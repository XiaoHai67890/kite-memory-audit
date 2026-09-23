import { loadConfig } from './config.js';
import { createApp } from './app.js';

try {
  const config = await loadConfig();
  const server = createApp(config).listen(config.port, config.host, () => {
    console.log(JSON.stringify({ event: 'listening', host: config.host, port: config.port, mode: config.mode, network: config.network }));
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => server.closeAllConnections(), 5_000).unref(); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Configuration error');
  process.exitCode = 1;
}
