import { DurableObject } from "cloudflare:workers";
import { Env } from '../worker-configuration';

const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const name = 'main';
    const id: DurableObjectId = env.DURABLE_SKY_DYE.idFromName(name);
    const stub = env.DURABLE_SKY_DYE.get(id);
    return await stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

interface ISession {
  userId?: string;
  username?: string;
}

interface IMarker {
  epoch: number;
  pos: [number, number];
}

export class SkyGameDyeServer extends DurableObject<Env> {
  sessions: Map<WebSocket, ISession>;
  markers: Array<IMarker>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.sessions = new Map();
    this.markers = [];
  }

  async fetch(request: Request): Promise<Response> {
		// Check request for websocket upgrade.
    const url = new URL(request.url);
    if (url.pathname !== '/ws') { return new Response('Not found', { status: 404 }); }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') { return new Response('Not a websocket request', { status: 400 }); }

		// Check Authorization.
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) { return new Response('Missing Authorization header', { status: 401 }); }
    const [userId, username] = await this.getUserIdAsync(authHeader);

		// Create websocket connection.
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[0]);

    const session: ISession = {
			userId, username
		};
    this.sessions.set(pair[0], session);

    return new Response(null, {
      status: 101,
      webSocket: pair[1]
    });
  }

  /**
   * Fetches the user ID using the provided Discord Authorization header.
   * This call happens server-side to prevent client-side control over which user ID is used.
   */
  async getUserIdAsync(accessToken: string): Promise<[string, string]> {
    const userResponse = await fetch(DISCORD_USER_URL, {
      headers: { Authorization: `${accessToken}` },
    });

    if (!userResponse.ok) {
      console.error(`getUserIdAsync - Discord reported: ${userResponse.status} ${userResponse.statusText}`);
      console.error(await userResponse.text());
      throw new Error('Failed to fetch user data.');
    }

    const userData = await userResponse.json() as any;
    const id = (userData?.id) || '';
    const username = (userData?.username) || '';
    return id && username ? [id, username] : [undefined, undefined];
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws);
    if (!session) { return; }

    const obj = JSON.parse(message.toString());

		throw new Error('TODO');
		//this.env.DB.prepare()

    await this.broadcast(`Someone said: ${obj}`);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    console.error(error);
    this.sessions.delete(ws);
  }

  async broadcast(message: string): Promise<void> {
    this.sessions.forEach((session, ws) => {
      try {
        ws.send(message);
      } catch (e) {
        console.error(e);
        this.sessions.delete(ws);
      }
    });
  }

  async sendHistory(ws: WebSocket): Promise<void> {
    this.clearOldMarkers();

    for (const marker of this.markers) {
      ws.send(JSON.stringify(marker));
    }
  }

  /** Clears any markers that are no longer relevant. */
  clearOldMarkers(): void {
    const date = new Date();
    date.setUTCMinutes(0, 0, 0);
    const epoch = date.getTime();

    this.markers = this.markers.filter(marker => marker.epoch >= epoch);
  }
}
