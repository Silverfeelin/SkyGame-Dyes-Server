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
	id: number;
  epoch: number;
  lat: number;
	lng: number;
	size: number;
}

type Marker = [number, number, number, number, number]; // [id, epoch, lat, lng, size]

interface IMessage {
	type: 'marker' | 'markers' | 'validation';
	marker?: Marker;
	markers?: Array<Marker>;
	message?: string;
}

export class SkyGameDyeServer extends DurableObject<Env> {
  sessions: Map<WebSocket, ISession>;
  markers: Array<Marker>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.sessions = new Map();
    this.markers = [];

    // Ping
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    // Load sessions.
    this.ctx.getWebSockets().forEach(ws => {
      const session: ISession = ws.deserializeAttachment();
      this.sessions.set(ws, session);
    });

    // Load data from storage.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.load();
    });
  }

  async load(): Promise<void> {
		const date = new Date();
		date.setUTCMinutes(0, 0, 0);
		const epoch = date.getTime();

    const data = await this.env.DB.prepare(`SELECT * FROM markers WHERE epoch = ?;`).bind(epoch).all();
		this.markers = data.results.map((row): Marker => [
			row.id as number,
			row.epoch as number,
			row.lat as number,
			row.lng as number,
			row.size as number
		]);
  }

  async fetch(request: Request): Promise<Response> {
		// Check request for websocket upgrade.
    const url = new URL(request.url);
    if (url.pathname !== '/api/ws') { return new Response('Not found', { status: 404 }); }

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') { return new Response('Not a websocket request', { status: 400 }); }

		// Check Authorization.
		const cookies = request.headers.get('Cookie');
    let authHeader = cookies?.split(';').find(cookie => cookie.startsWith('Authorization='))?.split('=')[1];
		if (authHeader) { authHeader = decodeURIComponent(authHeader); }
    if (!authHeader) { return new Response('Missing Authorization header', { status: 401 }); }

    const [userId, username] = await this.getUserIdAsync(authHeader);
    if (!userId || !username) { return new Response('Failed to fetch user data', { status: 401 }); }

    const session: ISession = {
			userId, username
		};

		// Create websocket connection.
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[0]);

    // Save the user ID and username in the session.
    pair[0].serializeAttachment(session);
    this.sessions.set(pair[0], session);

		// Send marker history.
		this.sendHistory(pair[0]);

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
		const close = (reason: string) => {
			ws.close(1008, reason);
			this.sessions.delete(ws);
		};

		// Find session
    const session = this.sessions.get(ws);
    if (!session) {
			return close('Session not found.');
		}

		let id = 0, epoch = 0;
		let obj: any = {};

		try {
			// Read marker
			obj = JSON.parse(message.toString());
			console.log('Received marker:', obj);

			// Validate marker
			if (isNaN(obj.size) || obj.size < 1 || obj.size > 3) {
				return close('Invalid size.');
			}

			// Validate location
			if (isNaN(obj.lat) || isNaN(obj.lng)) {
				return close('Invalid location.');
			}

			// Validate time
			const date = new Date();
			if (date.getUTCMinutes() >= 55) {
				this.sendMessage(ws, { type: 'validation', message: 'Please wait until the next hour to place a marker.' });
				return;
			}

			// Set epoch
			date.setUTCMinutes(0, 0, 0);
			epoch = date.getTime();

			const query = `
				INSERT INTO markers (userId, username, epoch, lat, lng, size)
				VALUES (?, ?, ?, ?, ?, ?);
			`;

			const result = await this.env.DB.prepare(query).bind(
				session.userId, session.username, epoch, obj.lat, obj.lng, obj.size
			).run();
			console.log('Saved to DB:', result.meta?.rows_written);
			id = result.meta.last_row_id;
		} catch (e) {
			console.error(e);
			ws.close(1008, 'Failed to parse message.');
			this.sessions.delete(ws);
			return;
		}

		const marker: Marker = [id, epoch, obj.lat, obj.lng, obj.size];
		this.markers.push(marker);
    await this.broadcast({ type: 'marker', marker });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.sessions.delete(ws);
		ws.close(code, `Durable Object is closing. ${reason}`);
  }

  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    console.error(error);
    this.sessions.delete(ws);
  }

	/** Sends the marker history to a socket. */
  async sendHistory(ws: WebSocket): Promise<void> {
    this.clearOldMarkers();

		console.log('Sending markers:', this.markers.length);
		this.sendMessage(ws, { type: 'markers', markers: this.markers });
  }

	/** Broadcasts a message to all sockets. */
  async broadcast(message: IMessage): Promise<void> {
    this.sessions.forEach((session, ws) => {
      try {
        this.sendMessage(ws, message);
      } catch (e) {
        console.error(e);
        this.sessions.delete(ws);
      }
    });
  }

	/** Sends a message to a socket. */
	async sendMessage(ws: WebSocket, message: IMessage): Promise<void> {
		ws.send(JSON.stringify(message));
	}

  /** Clears any markers that are no longer relevant. */
  clearOldMarkers(): void {
    const date = new Date();
    date.setUTCMinutes(0, 0, 0);
    const epoch = date.getTime();
		const length = this.markers.length;
    this.markers = this.markers.filter(marker => marker[1] >= epoch);
		console.log('Cleared old markers:', length - this.markers.length);
  }
}
