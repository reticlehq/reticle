import { IrisDev } from './iris-dev';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {process.env.NODE_ENV === 'development' ? <IrisDev /> : null}
        {children}
      </body>
    </html>
  );
}
