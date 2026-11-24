/**
 * How a recreation is served to the sandboxed frame. Pure so the exact policy is unit tested.
 *
 * The recreation is AI-generated code: it may run scripts and inline styles, and nothing else.
 * No network, no fonts or images from anywhere, no forms, no frames, no navigation.
 */

export const RECREATION_SCHEME = 'gil-recreation'

export const RECREATION_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ')

/**
 * The preview bridge, added to the served document (never saved). The library reaches the
 * sandboxed frame only by message:
 * - `'gil:replay'` calls `window.replay()`;
 * - `{ type: 'gil:css', css }` applies the editor's unsaved edits as a stylesheet placed
 *   after everything else (outside <body>, so element positions in selectors do not shift);
 * - `{ type: 'gil:pick', on }` turns click-to-select on or off. A click then reports the
 *   element's structural selector and current styles as `{ type: 'gil:picked', ... }`.
 * Anything the frame sends back is untrusted and validated by the library.
 */
export function previewBridge(properties: readonly string[]): string {
  const props = JSON.stringify(properties)
  return `<script>(function(){
var picking=false,live=null,box=null,PROPS=${props};
function selectorOf(el){var parts=[];while(el&&el!==document.body&&el.parentElement){var i=1,s=el;while((s=s.previousElementSibling))i++;parts.unshift(el.tagName.toLowerCase()+':nth-child('+i+')');el=el.parentElement}return el===document.body?['body'].concat(parts).join(' > '):null}
function outline(el){if(!box){box=document.createElement('div');box.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;outline:2px solid #0a6cff;outline-offset:1px;background:rgba(10,108,255,.08)';document.documentElement.appendChild(box)}if(!el){box.style.display='none';return}var r=el.getBoundingClientRect();box.style.display='block';box.style.left=r.left+'px';box.style.top=r.top+'px';box.style.width=r.width+'px';box.style.height=r.height+'px'}
document.addEventListener('mousemove',function(e){if(picking)outline(e.target)},true);
document.addEventListener('click',function(e){if(!picking)return;e.preventDefault();e.stopImmediatePropagation();var sel=selectorOf(e.target);if(!sel)return;var cs=getComputedStyle(e.target),styles={};PROPS.forEach(function(p){styles[p]=cs.getPropertyValue(p)});picking=false;document.documentElement.style.cursor='';outline(e.target);parent.postMessage({type:'gil:picked',selector:sel,tag:e.target.tagName.toLowerCase(),styles:styles},'*')},true);
window.addEventListener('message',function(e){var d=e.data;if(e.source!==parent)return;if(d==='gil:replay'){if(typeof window.replay==='function')window.replay();return}if(!d||typeof d!=='object')return;if(d.type==='gil:css'&&typeof d.css==='string'){if(!live){live=document.createElement('style');document.documentElement.appendChild(live)}live.textContent=d.css}if(d.type==='gil:pick'){picking=!!d.on;document.documentElement.style.cursor=picking?'crosshair':'';if(!picking)outline(null)}});
})()</script>`
}

/**
 * The document served for a recreation: the policy as a meta tag (in addition to the response
 * header) and the preview bridge, ahead of the recreation's HTML.
 */
export function wrapRecreation(html: string, properties: readonly string[]): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${RECREATION_CSP}">`
  return `<!doctype html>${meta}${previewBridge(properties)}\n${html.replace(/^\s*<!doctype html>/i, '')}`
}

/**
 * A virtual clock for rendering a recreation frame by frame (the verify step). Injected before
 * the recreation's own scripts, it replaces timers, requestAnimationFrame, performance.now and
 * Date.now, and pauses every CSS animation and transition as it starts. `__gilSeek(ms)`
 * then runs the page's timers and frame callbacks up to that moment and sets every animation to
 * where it would be, so frames can be captured at exact timestamps however slowly capture runs.
 */
const VIRTUAL_CLOCK = `<script>(function(){
var now=0,ids=1,timers=[],rafs=[],started=new Map(),base=Date.now(),realRaf=window.requestAnimationFrame.bind(window);
performance.now=function(){return now};Date.now=function(){return base+now};
function add(fn,ms,args,every){var id=ids++;timers.push({id:id,at:now+Math.max(0,+ms||0),fn:fn,args:args,every:every?Math.max(1,+ms||0):0});return id}
window.setTimeout=function(fn,ms){return add(fn,ms,[].slice.call(arguments,2),false)};
window.setInterval=function(fn,ms){return add(fn,ms,[].slice.call(arguments,2),true)};
window.clearTimeout=window.clearInterval=function(id){timers=timers.filter(function(t){return t.id!==id})};
window.requestAnimationFrame=function(fn){var id=ids++;rafs.push({id:id,fn:fn});return id};
window.cancelAnimationFrame=function(id){rafs=rafs.filter(function(r){return r.id!==id})};
function track(){document.getAnimations().forEach(function(a){if(!started.has(a)){started.set(a,now);try{a.pause()}catch(e){}}})}
function call(fn,args){try{typeof fn==='function'?fn.apply(window,args):(0,eval)(String(fn))}catch(e){}}
function runTimers(upTo){for(;;){timers.sort(function(a,b){return a.at-b.at||a.id-b.id});var t=timers[0];if(!t||t.at>upTo)return;now=t.at;if(t.every)t.at+=t.every;else timers.shift();call(t.fn,t.args);track()}}
function step(to){while(now<to){var next=Math.min(to,now+1000/60);runTimers(next);now=next;var due=rafs;rafs=[];due.forEach(function(r){call(r.fn,[now])});track()}runTimers(to);now=to}
function paint(){return new Promise(function(r){realRaf(function(){realRaf(function(){r()})})})}
window.__gilStart=function(){track();if(typeof window.replay==='function')call(window.replay,[]);track();return paint()};
window.__gilSeek=function(ms){var target=Math.max(now,+ms||0);step(target);track();started.forEach(function(s,a){try{a.currentTime=Math.max(0,target-s)}catch(e){}});return paint()};
})()</script>`

/** The document rendered in the hidden verify window: the policy, then the virtual clock. */
export function verifyDocument(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${RECREATION_CSP}">`
  return `<!doctype html>${meta}${VIRTUAL_CLOCK}\n${html.replace(/^\s*<!doctype html>/i, '')}`
}
