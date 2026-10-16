import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import worker from '../src/index';
import type { Env } from '../src/types';

test('public manifest describes exact app scope and standalone launch without auth or database access', async () => {
 const response=await worker.fetch(new Request('https://pigeon.example/app/manifest.webmanifest'),{} as Env);
 assert.equal(response.status,200);assert.match(response.headers.get('Content-Type')!,/^application\/manifest\+json/);assert.equal(response.headers.get('Cache-Control'),'public, max-age=3600');
 const manifest=await response.json() as any;
 assert.equal(manifest.name,'Pigeon');assert.equal(manifest.id,'/app');assert.equal(manifest.start_url,'/app');assert.equal(manifest.scope,'/app');assert.equal(manifest.display,'standalone');assert.equal(manifest.theme_color,'#f5f5f2');
 assert.deepEqual(manifest.icons,[{src:'/app/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'/app/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'}]);
 assert.ok(!JSON.stringify(manifest).includes('Authorization'));
});

test('small public PNG icon derivatives have truthful dimensions and preserve native source', async () => {
 const expected = {192: '7637ad58ffdafbb490719cdec65b9155ceddf66ab46533177afd49632e06ddc0', 512: '57be234cdd18c8456c553c090e531d8001d44818d3bd9078ca1753f8ad26f1cf'};
 for(const size of [192,512] as const) {
  const response=await worker.fetch(new Request('https://pigeon.example/app/icon-'+size+'.png'),{} as Env);
  assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  const bytes=Buffer.from(await response.arrayBuffer());assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(bytes.readUInt32BE(16),size);assert.equal(bytes.readUInt32BE(20),size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected[size]);assert.ok(bytes.byteLength<250_000);
 }
 const native=readFileSync(new URL('../ios/PigeonReader/PigeonReader/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png',import.meta.url));
 assert.equal(createHash('sha256').update(native).digest('hex'),'db3a5b8debddfc3fec526281374d45a8decc068293e5c9ff49e0c766cc77b3f9');
});

test('installation assets support HEAD and reject mutation methods', async () => {
 for(const path of ['/app/manifest.webmanifest','/app/icon.png','/app/icon-192.png','/app/icon-512.png']){
  const head=await worker.fetch(new Request('https://pigeon.example'+path,{method:'HEAD'}),{} as Env);assert.equal(head.status,200);assert.equal(await head.text(),'');
  const post=await worker.fetch(new Request('https://pigeon.example'+path,{method:'POST'}),{} as Env);assert.equal(post.status,405);assert.equal(post.headers.get('Allow'),'GET, HEAD');
 }
});
