import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';

const wrangler = resolve('node_modules/.bin/wrangler');
const helperArgs = [
	'dev', '--config', 'wrangler.recommendations.toml', '--local', '--port', '8788', '--inspector-port', '9230',
];
const mainArgs = [
	'dev', '--config', 'wrangler.toml', '--local', '--port', '8787', '--inspector-port', '9231',
];
let stopping = false;
let exitCode = 0;
const children = [];

function startWorker(name, args) {
	const child = spawn(wrangler, args, { stdio: 'inherit' });
	children.push(child);
	child.on('error', (error) => {
		console.error(`[dev:${name}] failed to start`, error);
		stop(1);
	});
	child.on('exit', (code, signal) => {
		if (!stopping) {
			console.error(`[dev:${name}] exited (${signal || (code ?? 'unknown')})`);
			stop(typeof code === 'number' ? code : 1);
		}
	});
}

startWorker('recommendations', helperArgs);
waitForPort(8788).then(() => {
	if (!stopping) startWorker('main', mainArgs);
}).catch((error) => {
	console.error('[dev] recommendation helper did not start', error);
	stop(1);
});

function waitForPort(port, timeoutMs = 10000) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolvePromise, rejectPromise) => {
		const check = () => {
			if (stopping) {
				rejectPromise(new Error('development session stopped'));
				return;
			}
			const socket = createConnection({ host: '127.0.0.1', port });
			socket.once('connect', () => {
				socket.destroy();
				resolvePromise();
			});
			socket.once('error', () => {
				socket.destroy();
				if (Date.now() < deadline) {
					setTimeout(check, 100);
				} else {
					rejectPromise(new Error(`port ${port} did not open within ${timeoutMs} ms`));
				}
			});
		};
		check();
	});
}

function stop(code) {
	if (stopping) return;
	stopping = true;
	exitCode = code;
	process.exitCode = code;
	for (const child of children) {
		if (!child.killed) child.kill('SIGTERM');
	}
	setTimeout(() => process.exit(exitCode), 1000).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
