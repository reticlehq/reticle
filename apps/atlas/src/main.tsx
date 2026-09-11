import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerCapabilities, registerStore } from '@reticlehq/browser';
import { install } from '@reticlehq/react';
import { ShipmentsTable } from './ShipmentsTable.js';
import { EmbeddedPanels } from './EmbeddedPanels.js';
import { WriteStorm } from './WriteStorm.js';
import { useAtlas } from './store.js';

install();
registerStore('atlas', useAtlas);
registerCapabilities({
  testids: [
    'title',
    'summary',
    'search',
    'viewport',
    'prev',
    'next',
    'loading',
    'panels-title',
    'write-storm',
    'write-storm-count',
  ],
  signals: ['shipments:loaded', 'dispatch:reconciled'],
  stores: ['atlas'],
});

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <ShipmentsTable />
      <EmbeddedPanels />
      <WriteStorm />
    </StrictMode>,
  );
}
