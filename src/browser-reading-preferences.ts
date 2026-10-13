/**
 * Reader preferences and inert image-policy preparation, independent of the main app.
 * applyImagePolicy returns {html,images:[{originalURL,alt,loaded,reason?}],blockedCount}.
 * Proxy adapter requires current authenticatedFetch, registerObjectURL, isCurrent;
 * optional baseURL resolves relative newsletter links. No raw credentials are persisted.
 * The main app owns iframe sandbox/CSP, zoom, one-time image consent and URL cleanup.
 */
export function renderBrowserReadingScript(): string {
 return String.raw`(function () {
 'use strict';
 var STORAGE_KEY = 'pigeon.browser.reading.v1';
 var DEFAULTS = {theme:'light',font:'system',fontSize:18,lineHeight:1.65,width:720,margins:24,density:'comfortable',imagePolicy:'load',shortcuts:{next:'j',previous:'k',read:'m',star:'s'}};
 var IMAGE_TYPES = ['image/avif','image/gif','image/heic','image/heif','image/jpeg','image/png','image/webp'];
 function choice(value, values, fallback) { return values.includes(value) ? value : fallback; }
 function bounded(value, minimum, maximum, fallback) { var number=typeof value==='number' || typeof value==='string' && value.trim() ? Number(value) : NaN; return Number.isFinite(number) ? Math.round(Math.min(maximum,Math.max(minimum,number))*100)/100 : fallback; }
 function validKey(value) { return typeof value==='string' && value.length===1 && value.charCodeAt(0)>=33 && value.charCodeAt(0)<=126; }
 function normalizePreferences(input) {
  var raw=input && typeof input==='object' ? input : {}; var shortcuts={}; var used=new Set();
  ['next','previous','read','star'].forEach(function(action) { var key=raw.shortcuts && raw.shortcuts[action]; key=validKey(key) ? key.toLowerCase() : DEFAULTS.shortcuts[action]; if(used.has(key)) key=[DEFAULTS.shortcuts[action],'j','k','m','s','n','p','r','t'].find(function(candidate){return !used.has(candidate);}); used.add(key); shortcuts[action]=key; });
  return {theme:choice(raw.theme,['light','dark','sepia','system'],DEFAULTS.theme),font:choice(raw.font,['system','serif','sans'],DEFAULTS.font),fontSize:bounded(raw.fontSize,14,28,DEFAULTS.fontSize),lineHeight:bounded(raw.lineHeight,1.2,2.2,DEFAULTS.lineHeight),width:bounded(raw.width,480,960,DEFAULTS.width),margins:bounded(raw.margins,0,64,DEFAULTS.margins),density:choice(raw.density,['comfortable','compact'],DEFAULTS.density),imagePolicy:choice(raw.imagePolicy,['load','ask','proxy'],DEFAULTS.imagePolicy),shortcuts:shortcuts};
 }
 function readPreferences(storage) { try { var value=(storage || localStorage).getItem(STORAGE_KEY); return normalizePreferences(value ? JSON.parse(value) : null); } catch (_) { return normalizePreferences(null); } }
 function savePreferences(input,storage) {
  if(input && input.shortcuts) { var keys=['next','previous','read','star'].map(function(action){return input.shortcuts[action];}); if(keys.some(function(key){return !validKey(key);}) || new Set(keys.map(function(key){return key.toLowerCase();})).size!==4) throw new Error('Choose a different single printable key for each reader shortcut.'); }
  var preferences=normalizePreferences(input); try {(storage || localStorage).setItem(STORAGE_KEY,JSON.stringify(preferences));} catch (_) {throw new Error('Reading preferences could not be saved. Allow browser storage and retry.');} return preferences;
 }
 function frameCSS(input) {
  var p=normalizePreferences(input); var font=p.font==='serif' ? 'Georgia, Charter, serif' : p.font==='sans' ? 'Arial, Helvetica, sans-serif' : '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  var dark=':root{color-scheme:dark;color:#e8e8e8;background:#17191c}a{color:#8ab4f8}blockquote{border-color:#59606a}pre,code{background:#24282f}';
  var colors=p.theme==='dark' ? dark : p.theme==='sepia' ? ':root{color-scheme:light;color:#40362c;background:#f4ecd8}a{color:#765b2d}' : ':root{color-scheme:light;color:#202124;background:#fff}a{color:#255bc3}';
  if(p.theme==='system') colors+='@media(prefers-color-scheme:dark){'+dark+'}';
  return colors+'*{box-sizing:border-box}html{overflow-wrap:anywhere}body{font-family:'+font+';font-size:'+p.fontSize+'px;line-height:'+p.lineHeight+';max-width:'+p.width+'px;margin:0 auto;padding:'+p.margins+'px}p,figure,ul,ol{margin:0 0 '+(p.density==='compact'?'0.65':'1')+'em}h1,h2,h3,h4,h5,h6{line-height:1.25}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse}td,th{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:.75em}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #b6bbc1}.pigeon-image-hidden{display:block;padding:.75em;border:1px dashed #a5a9af;color:inherit}';
 }
 function safeURL(raw,base,links) {
  if(typeof raw!=='string' || !raw.trim() || raw.length>8192 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try { var url=new URL(raw,base); if(url.username || url.password) return null; if(!['http:','https:'].includes(url.protocol) && !(links && ['mailto:','tel:'].includes(url.protocol))) return null; return url.href; } catch (_) {return null;}
 }
 function inlineImage(raw) { return typeof raw==='string' && raw.length<=2*1024*1024 && /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i.test(raw); }
 async function applyImagePolicy(html,options) {
  var opts=options || {}; var policy=choice(opts.policy,['load','ask','proxy'],'ask'); var created=[]; var imageRecords=[]; var proxyRequests=0; var proxyBytes=0; var controller=new AbortController();
  function guard() { if(typeof opts.isCurrent==='function' && !opts.isCurrent()) {controller.abort(); throw new Error('Reader session changed.');} }
  function revokeAll() {created.forEach(function(url){try{URL.revokeObjectURL(url);}catch(_){}}); created=[];}
  try {
   guard(); if(typeof html!=='string' || new TextEncoder().encode(html).length>10*1024*1024) throw new Error('Article HTML exceeds the reader preparation limit.');
   if(policy==='proxy' && (typeof opts.authenticatedFetch!=='function' || typeof opts.registerObjectURL!=='function' || typeof opts.isCurrent!=='function')) throw new Error('Private image loading requires the current authenticated reader adapter.');
   var template=document.createElement('template'); template.innerHTML=html;
   var base=opts.baseURL || window.location && window.location.href || 'https://pigeon.invalid/';
   var allowed=new Set(['p','div','span','article','section','main','header','footer','h1','h2','h3','h4','h5','h6','b','strong','i','em','u','s','del','ins','small','mark','sub','sup','br','hr','a','blockquote','pre','code','kbd','samp','ul','ol','li','dl','dt','dd','table','thead','tbody','tfoot','tr','th','td','caption','figure','figcaption','img','details','summary','time']);
   var drop=new Set(['script','style','iframe','frame','frameset','object','embed','applet','link','meta','base','svg','math','template','noscript','audio','video','source','track','form','input','select','textarea','button','canvas']);
   var elements=Array.from(template.content.querySelectorAll('*'));
   for(var element of elements) {
    guard(); if(!template.content.contains(element)) continue;
    var tag=element.localName.toLowerCase();
    if(drop.has(tag)) {element.remove();continue;}
    if(!allowed.has(tag)) {element.replaceWith.apply(element,Array.from(element.childNodes));continue;}
    var attributes={}; Array.from(element.attributes).forEach(function(attr){attributes[attr.name.toLowerCase()]=attr.value;element.removeAttribute(attr.name);});
    ['title','lang'].forEach(function(name){if(attributes[name])element.setAttribute(name,attributes[name].slice(0,300));});
    if(['ltr','rtl','auto'].includes(attributes.dir))element.setAttribute('dir',attributes.dir);
    ['colspan','rowspan'].forEach(function(name){if(['td','th'].includes(tag) && /^[1-9][0-9]{0,2}$/.test(attributes[name] || ''))element.setAttribute(name,String(Math.min(100,Number(attributes[name]))));});
    if(tag==='a') {var href=safeURL(attributes.href,base,true);if(href){element.setAttribute('href',href);element.setAttribute('target','_blank');element.setAttribute('rel','noopener noreferrer');element.setAttribute('referrerpolicy','no-referrer');}}
    if(tag!=='img') continue;
    var raw=attributes.src || attributes['data-src'] || (attributes.srcset || '').split(',')[0].trim().split(/\s+/)[0];
    var original=inlineImage(raw) ? raw : safeURL(raw,base,false); var alt=String(attributes.alt || '').slice(0,500);
    var image={originalURL:original,alt:alt,loaded:false};imageRecords.push(image);
    element.setAttribute('alt',alt);element.setAttribute('referrerpolicy','no-referrer');element.setAttribute('loading','lazy');
    if(!original) {image.reason='unsupported';element.setAttribute('class','pigeon-image-hidden');continue;}
    if(!inlineImage(original))element.setAttribute('data-pigeon-original-src',original);
    if(inlineImage(original) || policy==='load' || policy==='ask' && opts.loadOnce===true) {element.setAttribute('src',original);image.loaded=true;continue;}
    if(policy==='ask') {image.reason='consent';element.setAttribute('class','pigeon-image-hidden');continue;}
    if(proxyRequests>=50 || proxyBytes>=32*1024*1024) {image.reason='limit';element.setAttribute('class','pigeon-image-hidden');continue;}
    var currentObjectURL=null;
    try {
     guard();proxyRequests++;var response=await opts.authenticatedFetch('/api/v1/image-proxy?url='+encodeURIComponent(original),{signal:controller.signal});guard();
     var type=(response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();var length=Number(response.headers.get('Content-Length'));
     if(!response.ok || !IMAGE_TYPES.includes(type) || Number.isFinite(length) && length>8*1024*1024) throw new Error('Unsupported image response.');
     guard();var blob=await response.blob();guard();
     if(!IMAGE_TYPES.includes(blob.type.toLowerCase()) || blob.size>8*1024*1024 || !blob.size) throw new Error('Unsupported image payload.');
     if(proxyBytes+blob.size>32*1024*1024){image.reason='limit';element.setAttribute('class','pigeon-image-hidden');continue;}
     proxyBytes+=blob.size;guard();var objectURL=URL.createObjectURL(blob);currentObjectURL=objectURL;created.push(objectURL);guard();opts.registerObjectURL(objectURL);guard();
     element.setAttribute('src',objectURL);image.loaded=true;
    } catch(error) {guard();if(currentObjectURL){URL.revokeObjectURL(currentObjectURL);created=created.filter(function(url){return url!==currentObjectURL;});}image.reason=image.reason || 'failed';element.setAttribute('class','pigeon-image-hidden');}
   }
   guard();return {html:template.innerHTML,images:imageRecords,blockedCount:imageRecords.filter(function(image){return !image.loaded;}).length};
  } catch(error) {revokeAll();throw error;}
 }
 window.PigeonReading={normalizePreferences:normalizePreferences,readPreferences:readPreferences,savePreferences:savePreferences,frameCSS:frameCSS,applyImagePolicy:applyImagePolicy};
})();`;
}
