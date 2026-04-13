import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { config } from './config.js';
import { healthRouter } from './routes/health.js';
import { attachWebSocket } from './ws.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use('/api', healthRouter);

app.use(express.static(path.resolve(process.cwd(), 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'public', 'index.html'));
});

const server = createServer(app);
attachWebSocket(server);

server.listen(config.DASHBOARD_PORT, () => {
  console.log(`[dashboard] listening on :${config.DASHBOARD_PORT}`);
});

function shutdown() {
  console.log('[dashboard] shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
