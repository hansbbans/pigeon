import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
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
