import express from 'express';
import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';

// Vercel owns the listener. Treat this entrypoint as externally reachable even
// when HOST was accidentally copied from the loopback-only development example.
// Configuration is captured once per instance; request headers never set the
// receiving address, payment network, or canonical payment resource URL.
const config = await loadConfig({ ...process.env, HOST: '0.0.0.0' });
const app = express();
app.disable('x-powered-by');
app.use(createApp(config));

export default app;
