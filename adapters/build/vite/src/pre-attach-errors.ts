import { RETICLE_EARLY_CAPTURE, RETICLE_PRE_ATTACH_ERRORS } from '@reticlehq/core';

/** How many errors the pre-attach buffer keeps. The first ones name the cause; later ones are counted. */
export const PRE_ATTACH_ERRORS_LIMIT = 50;

/**
 * The pre-attach error buffer, as source for an inline <head> script (#1540).
 *
 * The SDK installs its console observer in `connect()`, and the connect module runs after the app's
 * entry module. So an entry module that 404s, is served as HTML or throws, a rejection, or a
 * `console.error` during start-up all happened while nothing was listening: the agent saw an empty
 * page and an empty console, and could not tell a blank page from an app that crashed on load.
 *
 * This runs during parse, before any module. It keeps the raw `error` events (capture phase, because
 * a failed `<script>` dispatches on the element and does not bubble), the unhandled rejections and
 * the `console.error` arguments. When the SDK's console observer installs, it calls
 * `drain(onError, onRejection, onConsole, dropped)` once. The buffer stops keeping and removes its
 * listeners, then hands each entry to the SDK's own handler. Before each one it calls `dropped`:
 * with the count of the entries it did not keep before the first, and with 0 after that. The SDK
 * marks what it gets during this call as pre-attach itself. The handling code lives here and not
 * in the SDK, so a page pays nothing for it in the SDK bundle.
 * The `console.error` wrapper stays in the chain after that and only calls through.
 *
 * It does not install on a page Reticle drives: that page already has the pool's early capture
 * (RETICLE_EARLY_CAPTURE), which hands the same errors to the SDK.
 *
 * The same rules as the render pre-hook: dependency-free ES5 in a try/catch.
 */
export const PRE_ATTACH_ERRORS_SOURCE = `(function(){try{
var P='${RETICLE_PRE_ATTACH_ERRORS}',D='${RETICLE_EARLY_CAPTURE}',g=globalThis;
if(g[P]!==undefined||g[D]!==undefined||typeof g.addEventListener!=='function')return;
var B={open:true},q=[],n=0;
g[P]=B;
var keep=function(item){if(!B.open)return;if(q.length<${String(PRE_ATTACH_ERRORS_LIMIT)}){q.push(item);}else{n++;}};
var onEvent=function(e){keep({event:e});};
g.addEventListener('error',onEvent,true);
g.addEventListener('unhandledrejection',onEvent,true);
var c=g.console,ne=c&&c.error;
if(typeof ne==='function'){c.error=function(){keep({args:Array.prototype.slice.call(arguments)});return ne.apply(this,arguments);};}
B.drain=function(onError,onRejection,onConsole,dropped){
if(!B.open)return;
var kept=q,i,it;B.open=false;q=[];
g.removeEventListener('error',onEvent,true);g.removeEventListener('unhandledrejection',onEvent,true);
for(i=0;i<kept.length;i++){it=kept[i];try{dropped(i===0?n:0);
if(it.args){onConsole('error',it.args);}else if(it.event.type==='unhandledrejection'){onRejection(it.event);}else{onError(it.event);}}catch(e){}}};
}catch(e){}})();`;
