export interface Env {
	DB: D1Database;
	BASE_URL: string;
	ITEMS_PER_FEED: string;
	LIGHT_ITEMS_PER_FEED?: string;
	API_PASSWORD: string;
	YOUTUBE_API_KEY?: string;
	TRUSTED_FORWARDER?: string;
}
