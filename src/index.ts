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
  lat: number;
	lng: number;
	size: number;
}

interface IMessage {
	type: 'marker' | 'validation';
	marker?: IMarker;
	message?: string;
}

export class SkyGameDyeServer extends DurableObject<Env> {
  sessions: Map<WebSocket, ISession>;
  markers: Array<IMarker>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.sessions = new Map();
    this.markers = [];

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
		this.markers = data.results.map((row): IMarker => ({
			epoch: row.epoch as number,
			lat: row.lat as number,
			lng: row.lng as number,
			size: row.size as number
		}));
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

		let marker: IMarker;

		try {
			// Read marker
			const obj = JSON.parse(message.toString());
			marker = { epoch: 0, lat: obj.lat, lng: obj.lng, size: obj.size };
			console.log('Received marker:', marker);

			// Validate marker
			if (isNaN(marker.size) || marker.size < 1 || marker.size > 3) {
				return close('Invalid size.');
			}

			// Validate location
			if (isNaN(marker.lat) || isNaN(marker.lng)) {
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
			marker.epoch = date.getTime();

			const query = `
				INSERT INTO markers (userId, username, epoch, lat, lng, size)
				VALUES (?, ?, ?, ?, ?, ?);
			`;

			const result = await this.env.DB.prepare(query).bind(
				session.userId, session.username, marker.epoch, marker.lat, marker.lng, marker.size
			).run();
			console.log('Saved to DB:', result.meta?.rows_written);
		} catch (e) {
			console.error(e);
			ws.close(1008, 'Failed to parse message.');
			this.sessions.delete(ws);
			return;
		}

		this.markers.push(marker);
    await this.broadcast({ type: 'marker', marker });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.sessions.delete(ws);
  }

  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    console.error(error);
    this.sessions.delete(ws);
  }

	/** Sends the marker history to a socket. */
  async sendHistory(ws: WebSocket): Promise<void> {
    this.clearOldMarkers();

		console.log('Sending markers:', this.markers.length);
    for (const marker of this.markers) {
			this.sendMessage(ws, { type: 'marker', marker });
    }
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
    this.markers = this.markers.filter(marker => marker.epoch >= epoch);
		console.log('Cleared old markers:', length - this.markers.length);
  }
}
