/**
 * One realtime hub per user (a Durable Object with hibernating WebSockets).
 * Every open tab of that user holds a socket here; the API pushes small
 * events ("new message in conversation X", "typing", "read") that carry ids
 * and ciphertext only. Clients then decrypt locally.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';

export class UserHub extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    // Bounded: a user rarely has more than a handful of tabs/devices open.
    const open = this.ctx.getWebSockets();
    if (open.length >= 16) open[0]!.close(4000, 'too many connections');
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Called by the API. */
  async push(event: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(event);
      } catch {
        /* closed socket; the runtime cleans it up */
      }
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Clients only send keep-alive pings; everything else goes through the HTTP API.
    if (message === 'ping') ws.send('pong');
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
  }
}
