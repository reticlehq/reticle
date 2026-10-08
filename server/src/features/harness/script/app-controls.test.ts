import { describe, expect, it } from 'vitest';
import { appControlsOf } from './app-controls.js';

const snapshot = (route: string, tree: string) => ({
  id: route,
  name: 'reticle_snapshot',
  args: {},
  result: { tree, status: { route } },
  isError: false,
});

/** The merchant dashboard's plans never listed its Refund buttons, so no journey refunded. */
describe('the app map a drive leaves', () => {
  it('holds the controls of every page a lane looked at, once each', () => {
    const map = appControlsOf(
      [
        snapshot(
          '/?__reticle_session=lease-1#/transactions',
          [
            '- button "Refund" (ref=e12)',
            '- button "Refund" (ref=e19)',
            '- textbox "Search transactions" (ref=e3) [value="a"]',
          ].join('\n'),
        ),
      ],
      {
        id: 'crawl',
        name: 'reticle_crawl',
        args: {},
        result: { visited: ['- link "Home"'] },
        isError: false,
      },
    );
    expect(map.appControls).toEqual([
      '/#/transactions: button "Refund"',
      '/#/transactions: textbox "Search transactions"',
      '- link "Home"',
    ]);
  });

  it('is absent when nothing was seen', () => {
    expect(appControlsOf([], undefined)).toEqual({});
  });
});
