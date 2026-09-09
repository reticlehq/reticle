/**
 * The lowercase JSX tags that are actually DOM elements.
 *
 * "Lowercase means host element" was the rule, and it is true only for React DOM. React is a
 * reconciler interface, not a renderer: react-three-fiber, react-pdf, ink and friends define their
 * own lowercase intrinsics, and those host instances are not nodes and do not take attributes.
 *
 * R3F is the case that bit. Its `applyProps` treats any prop containing a dash as a PIERCED
 * PROPERTY PATH, so `data-reticle-source` is walked as `data` -> `reticle` -> `source`; there is no
 * `data` object on a three.js instance, and it throws from inside the commit phase. Unhandled there,
 * the whole React tree unmounts to a white screen — and because it needs an element UPDATE rather
 * than a mount, it fires long after the app looked fine.
 *
 * So the check is an ALLOWLIST, not a heuristic. The set of custom-reconciler intrinsics is
 * unbounded and cannot be enumerated; the set of HTML and SVG tags can. Getting it wrong in the
 * conservative direction costs one source pointer on an exotic element. Getting it wrong the other
 * way costs the user their entire app.
 *
 * WHAT THIS DOES NOT COVER, stated rather than implied: a handful of three.js class names collide
 * with real DOM tags — `line` is both `<line>` in SVG and `THREE.Line`, and `audio` is both. A tag
 * name alone cannot separate them, and a lexical "is it under a <Canvas>" walk only sees the file
 * it is transforming, so a scene component in its own file would still slip through. The complete
 * answer for a three.js app is `reticle({ sourceMapping: false })`, which `reticle init` now writes
 * on its own when it finds react-three-fiber in the manifest.
 */

/** Every HTML element name, including the deprecated ones a real codebase still contains. */
const HTML_TAGS = [
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'big',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'font',
  'footer',
  'form',
  'frame',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'keygen',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'marquee',
  'menu',
  'menuitem',
  'meta',
  'meter',
  'nav',
  'nobr',
  'noframes',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'param',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strike',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
];

/**
 * SVG element names. Included because SVG is DOM — a `data-*` attribute on `<path>` is as valid as
 * one on `<div>`, and an app whose UI is a chart would otherwise lose every source pointer in it.
 *
 * The camelCase members (`clipPath`, `linearGradient`, …) are real JSX intrinsics in React DOM and
 * are matched exactly, so the lookup below cannot be case-folded.
 */
const SVG_TAGS = [
  'animate',
  'animateMotion',
  'animateTransform',
  'circle',
  'clipPath',
  'defs',
  'desc',
  'ellipse',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feDistantLight',
  'feDropShadow',
  'feFlood',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feGaussianBlur',
  'feImage',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'fePointLight',
  'feSpecularLighting',
  'feSpotLight',
  'feTile',
  'feTurbulence',
  'filter',
  'foreignObject',
  'g',
  'image',
  'line',
  'linearGradient',
  'marker',
  'mask',
  'metadata',
  'mpath',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialGradient',
  'rect',
  'set',
  'stop',
  'svg',
  'switch',
  'symbol',
  'text',
  'textPath',
  'tspan',
  'use',
  'view',
];

/**
 * MathML, for completeness: also DOM, also takes `data-*`. Small enough that omitting it would be a
 * deliberate blind spot rather than a saving.
 */
const MATHML_TAGS = [
  'annotation',
  'annotation-xml',
  'maction',
  'math',
  'merror',
  'mfrac',
  'mi',
  'mmultiscripts',
  'mn',
  'mo',
  'mover',
  'mpadded',
  'mphantom',
  'mprescripts',
  'mroot',
  'mrow',
  'ms',
  'mspace',
  'msqrt',
  'mstyle',
  'msub',
  'msubsup',
  'msup',
  'mtable',
  'mtd',
  'mtext',
  'mtr',
  'munder',
  'munderover',
  'semantics',
];

const DOM_TAGS: ReadonlySet<string> = new Set([...HTML_TAGS, ...SVG_TAGS, ...MATHML_TAGS]);

/**
 * Whether `tag` names a DOM element that will accept an arbitrary `data-*` attribute.
 *
 * Custom elements are deliberately included: a tag containing a dash is a valid custom element per
 * the HTML spec, it IS a DOM node, and `data-*` on it is ordinary. That rule cannot collide with a
 * custom reconciler's intrinsics, which are bare identifiers (`mesh`, `group`, `box`).
 */
export function isDomTag(tag: string): boolean {
  return DOM_TAGS.has(tag) || (tag.includes('-') && !tag.startsWith('-'));
}
