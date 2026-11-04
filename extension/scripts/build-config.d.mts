// Types for build-config.mjs, so test/manifest.test.ts typechecks.
export const root: string;
export const BROWSERS: Record<string, { manifest: string; target: string[] }>;
export const ENTRY_POINTS: Record<string, string>;
export function renderManifest(name: string, version: string): Record<string, unknown>;
export const USAGE: string;
export class UsageError extends Error {}
export function parseBuildArgs(args: string[]): { browsers: string[]; outdir: string; watch: boolean };
