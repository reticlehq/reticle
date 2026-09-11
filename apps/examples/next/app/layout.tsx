import { ReticleDev } from './reticle-dev';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {process.env.NODE_ENV === 'development' ? <ReticleDev /> : null}
        {children}
      </body>
    </html>
  );
}
