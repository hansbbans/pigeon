import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext, Script } from 'node:vm';
import { createServer } from 'node:http';
import { renderBrowserReadingScript } from '../src/browser-reading-preferences';

// A deliberately inert DOM adapter exercises sanitizer decisions in Node.
// Native HTML parsing/no-network behavior is verified separately in a browser.
class Text { parentNode: Element | null = null; constructor(public value: string) {} }
class Element {
 parentNode: Element | null = null; childNodes: (Element | Text)[] = []; attrs = new Map<string,string>();
 constructor(public localName: string) {}
 get attributes() { return [...this.attrs].map(([name,value])=>({name,value})); }
 getAttribute(name: string) { return this.attrs.get(name) ?? null; }
 setAttribute(name: string,value: string) { this.attrs.set(name,String(value)); }
 removeAttribute(name: string) { this.attrs.delete(name); }
 remove() { if(this.parentNode) this.parentNode.childNodes=this.parentNode.childNodes.filter(node=>node!==this); this.parentNode=null; }
 replaceWith(...children: (Element | Text)[]) { const parent=this.parentNode!; const at=parent.childNodes.indexOf(this); parent.childNodes.splice(at,1,...children); children.forEach(child=>{child.parentNode=parent;}); this.parentNode=null; }
 contains(node: Element) { let current: Element | null=node; while(current){if(current===this)return true;current=current.parentNode;} return false; }
 querySelectorAll(_query: string): Element[] { return this.childNodes.flatMap(node=>node instanceof Element ? [node,...node.querySelectorAll('*')] : []); }
}
const voidTags=new Set(['img','input','meta','link','base','source','track','br','hr','embed']);
const escape=(value: string)=>value.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
function serialize(root: Element): string { return root.childNodes.map(node=>node instanceof Text ? node.value : '<'+node.localName+[...node.attrs].map(([name,value])=>' '+name+'="'+escape(value)+'"').join('')+'>'+(!voidTags.has(node.localName)?serialize(node)+'</'+node.localName+'>':'')).join(''); }
function parse(html: string) {
 const root=new Element('fragment'); const stack=[root];
 for(const token of html.match(/<[^>]+>|[^<]+/g) ?? []) {
  if(token.startsWith('</')){stack.pop();continue;}
  if(token.startsWith('<')) {
   const match=token.match(/^<([\w:-]+)\s*([\s\S]*?)\/?\s*>$/);if(!match)continue;
   const element=new Element(match[1].toLowerCase());
   for(const attr of match[2].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) element.attrs.set(attr[1].toLowerCase(),attr[2] ?? attr[3] ?? attr[4] ?? '');
   element.parentNode=stack.at(-1)!; element.parentNode.childNodes.push(element); if(!voidTags.has(element.localName) && !token.endsWith('/>'))stack.push(element);
  } else {const text=new Text(token);text.parentNode=stack.at(-1)!;text.parentNode.childNodes.push(text);}
 }
 return root;
}
function fixture() {
 const values=new Map<string,string>(); const created: string[]=[]; const revoked: string[]=[]; let inertParses=0;
 class Template { content=new Element('fragment'); set innerHTML(html: string){inertParses++;this.content=parse(html);} get innerHTML(){return serialize(this.content);} }
 const url=class extends URL { static createObjectURL(_blob: Blob){const value='blob:https://pigeon.example/'+created.length;created.push(value);return value;} static revokeObjectURL(value: string){revoked.push(value);} };
 const window: any={location:{href:'https://pigeon.example/app'}};
 const storage={getItem:(key: string)=>values.get(key) ?? null,setItem:(key: string,value: string)=>{values.set(key,value);}};
 runInNewContext(renderBrowserReadingScript(),{window,localStorage:storage,URL:url,TextEncoder,AbortController,document:{createElement:(tag: string)=>{assert.equal(tag,'template');return new Template();}}});
 return {api:window.PigeonReading,values,storage,created,revoked,parses:()=>inertParses};
}
const plain=(value: any)=>JSON.parse(JSON.stringify(value));

test('reading preferences persist typed bounded settings and unique keyboard shortcuts',()=>{
 const state=fixture(); const prefs=state.api.savePreferences({theme:'sepia',font:'serif',fontSize:100,lineHeight:0,width:12345,margins:99,density:'compact',imagePolicy:'ask',shortcuts:{next:'N',previous:'P',read:'R',star:'T'}});
 assert.deepEqual(plain(state.api.readPreferences()),plain(prefs)); assert.equal(prefs.fontSize,28);assert.equal(prefs.lineHeight,1.2);assert.equal(prefs.width,960);assert.equal(prefs.margins,64);assert.equal(prefs.shortcuts.next,'n');
 assert.throws(()=>state.api.savePreferences({shortcuts:{next:'j',previous:'j',read:'m',star:'s'}}),/different single printable/);
 assert.throws(()=>state.api.savePreferences({shortcuts:{next:' ',previous:'k',read:'m',star:'s'}}),/single printable/);
 assert.equal(state.api.normalizePreferences({fontSize:null}).fontSize,18);
 assert.equal(new Set(Object.values(state.api.normalizePreferences({shortcuts:{next:'s',previous:'s'}}).shortcuts)).size,4);
});

test('frame CSS uses only safe enum fonts/colors and bounded numbers; system theme follows media preference',()=>{
 const state=fixture();const css=state.api.frameCSS({theme:'system',font:'url(https://evil.test/font)',fontSize:'18;@import x',width:'NaN',margins:-10});
 assert.match(css,/@media\(prefers-color-scheme:dark\)/);assert.match(css,/font-size:18px/);assert.match(css,/max-width:720px/);assert.match(css,/padding:0px/);
 assert.doesNotMatch(css,/@import|https:\/\/|javascript:|url\(/);
 const failing={getItem:()=>{throw new Error('denied');},setItem:()=>{throw new Error('denied');}};
 assert.equal(state.api.readPreferences(failing).theme,'light');assert.throws(()=>state.api.savePreferences({},failing),/could not be saved/);
});

test('ask policy strips all network resource channels while retaining inert image metadata and safe text links',async()=>{
 const state=fixture();let calls=0;
 const html='<div style="background:url(https://tracker.test/bg)" background="https://tracker.test/table" onclick="evil()"><p>Readable story</p><img src="https://images.test/photo" srcset="https://tracker.test/set 2x" onerror="evil()" alt="Photo"><picture><source srcset="https://tracker.test/picture"><img data-src="https://images.test/lazy"></picture><video src="https://tracker.test/video" poster="https://tracker.test/poster"></video><svg><image href="https://tracker.test/svg"></image></svg><style>@import "https://tracker.test/css";</style><link rel="preload" href="https://tracker.test/font"><meta http-equiv="refresh" content="0;url=https://tracker.test"><iframe src="https://tracker.test/frame"></iframe><script src="https://tracker.test/js"></script><a href="https://site.test/story" ping="https://tracker.test/ping">Read original</a></div>';
 const result=await state.api.applyImagePolicy(html,{policy:'ask',authenticatedFetch:async()=>{calls++;throw new Error('must not fetch');},isCurrent:()=>true});
 assert.equal(calls,0);assert.equal(state.parses(),1);assert.equal(result.blockedCount,2);assert.equal(result.images[0].originalURL,'https://images.test/photo');assert.equal(result.images[1].originalURL,'https://images.test/lazy');
 assert.doesNotMatch(result.html,/<(picture|source|video|svg|style|link|meta|iframe|script)\b|\s(src|srcset|style|background|ping|onclick|onerror)=/i);
 assert.match(result.html,/data-pigeon-original-src="https:\/\/images.test\/photo"/);assert.match(result.html,/Readable story/);assert.match(result.html,/rel="noopener noreferrer"/);
});

test('explicit one-time ask consent and load policy restore only safe image src, never srcset or remote styles',async()=>{
 const state=fixture();const html='<img src="/photo.jpg" srcset="https://tracker.test/set 2x"><img src="javascript:evil()"><img src="data:image/svg+xml;base64,AAAA"><img src="data:image/png;base64,AQID">';
 const result=await state.api.applyImagePolicy(html,{policy:'ask',loadOnce:true,baseURL:'https://newsletter.test/story',isCurrent:()=>true});
 assert.equal(result.images[0].originalURL,'https://newsletter.test/photo.jpg');assert.equal(result.images[0].loaded,true);assert.equal(result.images[1].loaded,false);assert.equal(result.images[2].loaded,false);assert.equal(result.images[3].loaded,true);
 assert.doesNotMatch(result.html,/srcset|javascript:|data:image\/svg/);assert.match(result.html,/src="https:\/\/newsletter.test\/photo.jpg"/);
 assert.equal((await state.api.applyImagePolicy('<img src="https://images.test/x">',{policy:'load'})).blockedCount,0);
});

test('proxy routes images through authenticated endpoint and only renders validated registered blob URLs',async()=>{
 const state=fixture();const calls:string[]=[];const registered:string[]=[];
 const result=await state.api.applyImagePolicy('<img src="https://images.test/photo"><img src="https://images.test/unsafe">',{policy:'proxy',isCurrent:()=>true,registerObjectURL:(url:string)=>registered.push(url),authenticatedFetch:async(path:string,init:any)=>{calls.push(path);assert.ok(init.signal);return path.includes('unsafe')?new Response('<svg></svg>',{headers:{'Content-Type':'image/svg+xml'}}):new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});}});
 assert.equal(calls.length,2);assert.match(calls[0],/^\/api\/v1\/image-proxy\?url=https%3A%2F%2Fimages.test/);assert.equal(registered.length,1);assert.equal(result.blockedCount,1);
 assert.match(result.html,/src="blob:https:\/\/pigeon.example\/0"/);assert.doesNotMatch(result.html,/\ssrc="https:/);assert.equal(result.images[1].reason,'failed');
});

test('session change after proxy await discards results and revokes every object URL created for that render',async()=>{
 const state=fixture();let current=true;let calls=0;
 await assert.rejects(state.api.applyImagePolicy('<img src="https://images.test/one"><img src="https://images.test/two">',{policy:'proxy',isCurrent:()=>current,registerObjectURL:()=>{},authenticatedFetch:async()=>{calls++;if(calls===2)current=false;return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});}}),/session changed/);
 assert.equal(state.created.length,1);assert.deepEqual(state.revoked,state.created);
});

test('proxy limits and invalid payloads leave images blocked explicitly; failed URL registration cleans up',async()=>{
 const state=fixture();let calls=0;
 const html=Array.from({length:52},(_,index)=>'<img src="https://images.test/'+index+'">').join('');
 const result=await state.api.applyImagePolicy(html,{policy:'proxy',isCurrent:()=>true,registerObjectURL:()=>{},authenticatedFetch:async()=>{calls++;return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});}});
 assert.equal(calls,50);assert.equal(result.blockedCount,2);assert.equal(result.images[51].reason,'limit');
 const failed=fixture();const blocked=await failed.api.applyImagePolicy('<img src="https://images.test/x">',{policy:'proxy',isCurrent:()=>true,registerObjectURL:()=>{throw new Error('registry unavailable');},authenticatedFetch:async()=>new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}})});
 assert.equal(blocked.blockedCount,1);assert.deepEqual(failed.revoked,failed.created);
 await assert.rejects(state.api.applyImagePolicy('<img src="https://images.test/x">',{policy:'proxy'}),/requires the current/);
});

test('stale session during response blob read revokes prior render URLs and prevents later image requests',async()=>{
 const state=fixture();let current=true;let calls=0;
 await assert.rejects(state.api.applyImagePolicy('<img src="https://images.test/one"><img src="https://images.test/two"><img src="https://images.test/three">',{policy:'proxy',isCurrent:()=>current,registerObjectURL:()=>{},authenticatedFetch:async()=>{calls++;const response=new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});if(calls===2)response.blob=async()=>{await Promise.resolve();current=false;return new Blob([new Uint8Array([1])],{type:'image/png'});};return response;}}),/session changed/);
 assert.equal(calls,2);assert.deepEqual(state.revoked,state.created);
});

test('mismatched SVG blob, failed proxy response and credential URLs cannot become rendered image sources',async()=>{
 const state=fixture();let calls=0;
 const result=await state.api.applyImagePolicy('<img src="https://user:password@images.test/private"><img src="https://images.test/mismatch"><img src="https://images.test/error">',{policy:'proxy',isCurrent:()=>true,registerObjectURL:()=>{},authenticatedFetch:async(path:string)=>{calls++;if(path.includes('error'))return new Response('failure',{status:500,headers:{'Content-Type':'image/png'}});const response=new Response('bad',{headers:{'Content-Type':'image/png'}});response.blob=async()=>new Blob(['<svg></svg>'],{type:'image/svg+xml'});return response;}});
 assert.equal(calls,2);assert.equal(result.blockedCount,3);assert.equal(state.created.length,0);assert.doesNotMatch(result.html,/\ssrc=|password/);
});

// This opt-in fixture never launches or controls a browser. Root opens the
// printed local URL with CUA; normal npm test skips this real-DOM dependency.
// PIGEON_READING_CUA_SMOKE=1 npx tsx --test test/browser-reading-preferences.test.ts
test('CUA real DOM smoke verifies image consent, proxy blobs and stale-render cleanup without resource leaks', {skip:process.env.PIGEON_READING_CUA_SMOKE!=='1'}, async(t)=>{
 const probes:string[]=[];let fixtureHTML='';let resolveReport!:(value:any)=>void;let rejectReport!:(error:Error)=>void;
 const reportReady=new Promise<any>((resolve,reject)=>{resolveReport=resolve;rejectReport=reject;});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 const server=createServer((request,response)=>{
  response.setHeader('Cache-Control','no-store');
  if(request.url==='/report' && request.method==='POST'){
   let body='';request.on('data',chunk=>{body+=chunk.toString();if(body.length>100_000)request.destroy();});
   request.on('end',()=>{try{resolveReport(JSON.parse(body));response.end('reported');}catch{rejectReport(new Error('Invalid reading browser smoke report'));response.writeHead(400).end();}});return;
  }
  if(request.url==='/snapshot'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(probes));return;}
  if(request.url?.startsWith('/probe/')){probes.push(request.url);response.setHeader('Content-Type','image/png');response.end(png);return;}
  response.setHeader('Content-Type','text/html; charset=utf-8');response.end(request.url==='/'?fixtureHTML:'<p>Local smoke fixture</p>');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());}));
 const port=(server.address() as {port:number}).port;const base=`http://127.0.0.1:${port}`;
 const source=`<article style="background:url(${base}/probe/css-background)" background="${base}/probe/background"><h1>Image policy smoke</h1><p>A real browser renders this article.</p>
 <img src="${base}/probe/image-load" srcset="${base}/probe/srcset 2x" onerror="window.__SOURCE_EXECUTED__=true" alt="Allowed raster">
 <picture><source srcset="${base}/probe/picture"></picture><style>@import "${base}/probe/import";body{background:url(${base}/probe/style)}</style>
 <link rel="stylesheet" href="${base}/probe/stylesheet"><meta http-equiv="refresh" content="0;url=${base}/probe/meta">
 <iframe src="${base}/probe/iframe"></iframe><video autoplay src="${base}/probe/video" poster="${base}/probe/poster"><source src="${base}/probe/video-source"></video>
 <svg><image href="${base}/probe/svg"/></svg><script>window.__SOURCE_EXECUTED__=true</script><img src="javascript&#58;evil()"></article>`;
 const encoded=JSON.stringify(source).replace(/</g,'\\u003c');
 fixtureHTML='<!doctype html><html><head><meta charset="utf-8"><title>Pigeon reading image-policy smoke</title></head><body><h1>Reading image-policy browser smoke</h1><script>'+renderBrowserReadingScript()+'</script><script>'+String.raw`
 (async function(){
  const report={};const allURLs=[];const revoked=[];const nativeRevoke=URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL=function(url){revoked.push(url);nativeRevoke(url);};
  const snapshot=()=>fetch('/snapshot',{cache:'no-store'}).then(response=>response.json());
  const pause=()=>new Promise(resolve=>setTimeout(resolve,120));
  async function commit(html,label){
   const heading=document.createElement('h2');heading.textContent=label;document.body.append(heading);
   const frame=document.createElement('iframe');frame.title=label;frame.sandbox='allow-same-origin';frame.style.width='600px';frame.style.height='160px';
   const loaded=new Promise(resolve=>{frame.onload=resolve;});frame.srcdoc='<!doctype html><html><body>'+html+'</body></html>';document.body.append(frame);await loaded;
   const images=Array.from(frame.contentDocument.querySelectorAll('img'));
   await Promise.all(images.filter(image=>image.getAttribute('src')).map(async image=>{image.loading='eager';await Promise.race([image.decode(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Image decode timed out')),5000))]);}));
   await pause();return {frame,srcs:images.map(image=>image.getAttribute('src')),widths:images.map(image=>image.naturalWidth),unsafe:frame.contentDocument.querySelectorAll('script,style,iframe,source,video,svg,link,meta,[srcset],[onerror],[style],[background]').length};
  }
  function pngResponse(){return new Response(Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png'}});}
  try {
   const source=SOURCE_LITERAL;
   const ask=await PigeonReading.applyImagePolicy(source,{policy:'ask',isCurrent:()=>true});
   report.askBeforeCommit=await snapshot();const askFrame=await commit(ask.html,'Ask: blocked before consent');report.askProbes=await snapshot();report.askBlocked=ask.blockedCount;report.askUnsafe=askFrame.unsafe;
   askFrame.frame.remove();
   const consent=await PigeonReading.applyImagePolicy(source,{policy:'ask',loadOnce:true,isCurrent:()=>true});report.consentBeforeCommit=await snapshot();
   const consentFrame=await commit(consent.html,'Ask: explicit one-time consent');report.consentProbes=await snapshot();report.consentSrcs=consentFrame.srcs;report.consentWidths=consentFrame.widths;report.consentUnsafe=consentFrame.unsafe;consentFrame.frame.remove();
   let proxyCalls=0;const proxyHTML='<img src="'+location.origin+'/probe/proxy-original" srcset="'+location.origin+'/probe/proxy-srcset 2x">';
   const proxy=await PigeonReading.applyImagePolicy(proxyHTML,{policy:'proxy',isCurrent:()=>true,registerObjectURL:url=>allURLs.push(url),authenticatedFetch:async(path)=>{if(!path.startsWith('/api/v1/image-proxy?url='))throw new Error('Unexpected proxy route');proxyCalls++;return pngResponse();}});
   const proxyFrame=await commit(proxy.html,'Proxy: registered raster blob');report.proxyCalls=proxyCalls;report.proxySrcs=proxyFrame.srcs;report.proxyWidths=proxyFrame.widths;report.proxyBlocked=proxy.blockedCount;report.proxyProbes=await snapshot();proxyFrame.frame.remove();
   let current=true;let staleCalls=0;let staleCommitted=false;const staleURLs=[];
   try {
    const stale=await PigeonReading.applyImagePolicy('<img src="'+location.origin+'/probe/stale-first"><img src="'+location.origin+'/probe/stale-second">',{policy:'proxy',isCurrent:()=>current,registerObjectURL:url=>{allURLs.push(url);staleURLs.push(url);},authenticatedFetch:async()=>{staleCalls++;if(staleCalls===2)current=false;return pngResponse();}});
    await commit(stale.html,'Unexpected stale commit');staleCommitted=true;
   } catch(error){report.staleError=error.message;}
   report.staleCommitted=staleCommitted;report.staleCalls=staleCalls;report.staleURLs=staleURLs;report.revoked=revoked.slice();report.staleProbes=await snapshot();report.sourceExecuted=Boolean(window.__SOURCE_EXECUTED__);
  } catch(error){report.error=error.message;}
  finally{allURLs.forEach(nativeRevoke);URL.revokeObjectURL=nativeRevoke;}
  const result=document.createElement('pre');result.id='result';result.textContent=JSON.stringify(report,null,2);document.body.append(result);
  await fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
 })();`.replace('SOURCE_LITERAL',encoded)+'</script></body></html>';
 for(const script of fixtureHTML.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(script[1]);
 console.log(`Open this reading image-policy smoke fixture with CUA: ${base}/`);
 const deadline=setTimeout(()=>rejectReport(new Error('CUA did not open the reading image-policy fixture within 120 seconds')),120_000);
 const report=await reportReady.finally(()=>clearTimeout(deadline));
 assert.equal(report.error,undefined);assert.equal(report.sourceExecuted,false);
 assert.deepEqual(report.askBeforeCommit,[]);assert.deepEqual(report.askProbes,[]);assert.equal(report.askBlocked,2);assert.equal(report.askUnsafe,0);
 assert.deepEqual(report.consentBeforeCommit,[]);assert.deepEqual(report.consentProbes,['/probe/image-load']);assert.equal(report.consentUnsafe,0);assert.equal(report.consentSrcs[0],`${base}/probe/image-load`);assert.equal(report.consentWidths[0],1);assert.equal(report.consentSrcs[1],null);
 assert.equal(report.proxyCalls,1);assert.equal(report.proxyBlocked,0);assert.match(report.proxySrcs[0],/^blob:http:\/\/127\.0\.0\.1:/);assert.equal(report.proxyWidths[0],1);assert.deepEqual(report.proxyProbes,['/probe/image-load']);
 assert.equal(report.staleCommitted,false);assert.match(report.staleError,/session changed/);assert.equal(report.staleCalls,2);assert.equal(report.staleURLs.length,1);assert.ok(report.revoked.includes(report.staleURLs[0]));assert.deepEqual(report.staleProbes,['/probe/image-load']);
 assert.deepEqual(probes,['/probe/image-load'],'only the explicitly consented image may reach the fixture server');
});
