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
 * the `console.error` arguments. The SDK reads the queue once when it attaches, reports each entry
 * marked as pre-attach, and calls `close()`, so nothing is kept or reported twice. The
 * `console.error` wrapper stays in the chain after that and only calls through.
 *
 * It does not install on a page Reticle drives: that page already has the pool's early capture
 * (RETICLE_EARLY_CAPTURE), which hands the same errors to the SDK.
 *
 * The same rules as the render pre-hook: dependency-free ES5 in a try/catch.
 */
export const PRE_ATTACH_ERRORS_SOURCE = `(function(){try{
var P='${RETICLE_PRE_ATTACH_ERRORS}',D='${RETICLE_EARLY_CAPTURE}',g=globalThis;
if(g[P]!==undefined||g[D]!==undefined||typeof g.addEventListener!=='function')return;
var B={queue:[],dropped:0,open:true};
g[P]=B;
var keep=function(item){if(!B.open)return;if(B.queue.length<${String(PRE_ATTACH_ERRORS_LIMIT)}){B.queue.push(item);}else{B.dropped++;}};
var onEvent=function(e){keep({event:e});};
g.addEventListener('error',onEvent,true);
g.addEventListener('unhandledrejection',onEvent,true);
var c=g.console,ne=c&&c.error;
if(typeof ne==='function'){c.error=function(){keep({args:Array.prototype.slice.call(arguments)});return ne.apply(this,arguments);};}
B.close=function(){B.open=false;B.queue=[];g.removeEventListener('error',onEvent,true);g.removeEventListener('unhandledrejection',onEvent,true);};
}catch(e){}})();`;
