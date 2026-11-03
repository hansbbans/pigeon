import type { KeyValueStore } from '../../src/core/session';

export class MemoryStore implements KeyValueStore {
	readonly data = new Map<string, unknown>();

	async get(keys: string | string[]): Promise<Record<string, unknown>> {
		const out: Record<string, unknown> = {};
		for (const key of Array.isArray(keys) ? keys : [keys]) {
			if (this.data.has(key)) out[key] = structuredClone(this.data.get(key));
		}
		return out;
	}

	async set(items: Record<string, unknown>): Promise<void> {
		for (const [key, value] of Object.entries(items)) this.data.set(key, structuredClone(value));
	}

	async remove(keys: string | string[]): Promise<void> {
		for (const key of Array.isArray(keys) ? keys : [keys]) this.data.delete(key);
	}
}

export interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

export type Handler = (request: RecordedRequest) => Response | Promise<Response> | 'network-error';

/** A fetch that records every request and answers from a handler (or a queue of them). */
export function mockFetch(handler: Handler | Handler[]) {
	const requests: RecordedRequest[] = [];
	const handlers = Array.isArray(handler) ? [...handler] : null;
	const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value;
		});
		const request: RecordedRequest = { url: String(input), method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : '' };
		requests.push(request);
		const next = handlers ? handlers.shift() : (handler as Handler);
		if (!next) throw new Error(`Unexpected request ${request.method} ${request.url}`);
		const response = await next(request);
		if (response === 'network-error') throw new TypeError('Failed to fetch');
		return response;
	};
	return { fetch: fetchImpl as typeof fetch, requests };
}

export const ORIGIN = 'https://pigeon.hanscho.com';
export const AUTH = 'pigeon/0123abcd';

export function savedReply(state: 'pending' | 'done', extra: Record<string, unknown> = {}, status = 201): Response {
	return Response.json({ id: 'abde2a43-22dc-8734-9049-5cd424e03007', readerId: 'tag:google.com,2005:reader/item/0000000000000005', url: 'https://example.com/a', state, created: status === 201, ...extra }, { status });
}

export async function signedInStore(): Promise<MemoryStore> {
	const store = new MemoryStore();
	await store.set({ pigeonOrigin: ORIGIN, pigeonAuth: AUTH });
	return store;
}
