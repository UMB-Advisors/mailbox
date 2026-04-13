import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const clients = new Set<WebSocket>();

export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/api/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  });
  return wss;
}

export function broadcast(event: string, payload: unknown): void {
  const msg = JSON.stringify({ type: event, payload, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
