import type { Metadata } from 'next';
import { IBM_Plex_Mono, Outfit, Source_Serif_4 } from 'next/font/google';
import './globals.css';

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  variable: '--font-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'MailBox One',
  description: 'Approval queue for LLM-generated email drafts',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${ibmPlexMono.variable} ${sourceSerif.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
