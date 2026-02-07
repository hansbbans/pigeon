import type { Env } from './types';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			return new Response('ok');
		}

		return new Response('Not found', { status: 404 });
	},

	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		const rawEmail = await new Response(message.raw).arrayBuffer();
		const size = rawEmail.byteLength;

		console.log(
			`Email received | from=${message.from} to=${message.to} size=${size} bytes`,
		);
	},
} satisfies ExportedHandler<Env>;
