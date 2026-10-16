export interface Env {
	DB: D1Database;
	/** Optional in local/unit-test environments; required by the deployed main Worker. */
	RECOMMENDATIONS?: DurableObjectNamespace;
	BASE_URL: string;
	ITEMS_PER_FEED: string;
	LIGHT_ITEMS_PER_FEED?: string;
	API_PASSWORD: string;
	YOUTUBE_API_KEY?: string;
	TRUSTED_FORWARDER?: string;
	/** Optional Web Push configuration; keep the private EC JWK in a Worker secret. */
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_JWK?: string;
	VAPID_SUBJECT?: string;
}
