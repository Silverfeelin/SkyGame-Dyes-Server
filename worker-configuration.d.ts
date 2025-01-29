export interface Env {
	DURABLE_SKY_DYE: DurableObjectNamespace<import("./src/index").SkyGameDyeServer>;
	DB: D1Database;
}
