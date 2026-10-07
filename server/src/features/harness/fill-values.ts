/**
 * What to type into a text field, from its label alone.
 *
 * Used by the crawl, which fills a field to see what the app does with it and never needs the value
 * to be clever. The Harness fills fields on the platform, where its engine decides them.
 */
export function heuristicFillValue(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('email')) return 'harness@reticle.dev';
  if (l.includes('password')) return 'password';
  if (l.includes('url') || l.includes('link')) return 'https://example.com';
  if (l.includes('phone') || l.includes('tel')) return '5550100';
  if (l.includes('date')) return '2026-01-01';
  if (l.includes('amount') || l.includes('price') || l.includes('qty') || l.includes('quantity'))
    return '2';
  if (l.includes('search') || l.includes('filter')) return 'a';
  if (l.includes('number') || l.includes('count')) return '42';
  return 'reticle harness';
}
