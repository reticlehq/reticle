/**
 * Repaint a HUD region from fresh markup WITHOUT throwing its controls away.
 *
 * The Harness rows and the account control were repainted with `innerHTML` on every push from the
 * daemon, and a run pushes on every step: the Run/Stop button and the switch beside it were removed
 * and recreated each time, so a hovered or focused control blinked, an open account menu snapped
 * shut, and a screen reader re-announced the row. Here, a node whose tag is unchanged at the same
 * position is KEPT and only its attributes and text are brought up to date; only a node that changed
 * kind is replaced.
 *
 * ponytail: positional, not keyed. A region that reorders siblings would replace them; none does.
 */
export function morphHtml(target: Element, html: string): void {
  const next = document.createElement('template');
  next.innerHTML = html;
  morphChildren(target, next.content);
}

function morphChildren(from: Node, to: Node): void {
  const have = [...from.childNodes];
  const want = [...to.childNodes];
  want.forEach((node, i) => {
    const old = have[i];
    if (old === undefined) from.appendChild(node);
    else if (old.nodeType === node.nodeType && old.nodeName === node.nodeName) morphNode(old, node);
    else from.replaceChild(node, old);
  });
  for (const extra of have.slice(want.length)) from.removeChild(extra);
}

function morphNode(old: Node, node: Node): void {
  if (!(old instanceof Element) || !(node instanceof Element)) {
    if (old.nodeValue !== node.nodeValue) old.nodeValue = node.nodeValue;
    return;
  }
  for (const { name } of [...old.attributes])
    if (!node.hasAttribute(name)) old.removeAttribute(name);
  for (const { name, value } of [...node.attributes])
    if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  morphChildren(old, node);
}
