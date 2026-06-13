import type { ReactNode } from 'react';
import { IrisDev } from './iris-dev';

export const metadata = { title: 'Iris Next.js Smoke Test' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          background: '#0b0d12',
          color: '#e6e9f0',
          margin: 0,
        }}
      >
        {process.env.NODE_ENV === 'development' ? <IrisDev /> : null}
        {children}
      </body>
    </html>
  );
}
