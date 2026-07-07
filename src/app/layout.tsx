import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Script from 'next/script';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { Toaster } from '@/components/ui/toaster';
import { QueryProvider } from '@/components/providers/query-provider';
import { LocaleProvider } from '@/providers/LocaleProvider';
import './globals.css';

const themeScript = `(function(){try{var t=localStorage.getItem('theme')||'system',r=t==='system'?(window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):t;document.documentElement.classList.toggle('dark',r==='dark')}catch(e){}})()`;

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'AccountExpress - Accounting CRM',
  description: 'Professional bookkeeping for US businesses',
  icons: {
    icon: '/favicon.ico',
    shortcut: '/favicon.ico',
  },
  keywords: [
    'AccountExpress',
    'accounting',
    'CRM',
    'bookkeeping',
    'US GAAP',
    'financial management',
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} subpixel-antialiased`}>
        <Script id="theme-init" strategy="beforeInteractive">
          {themeScript}
        </Script>
        <ThemeProvider>
          <QueryProvider>
            <LocaleProvider>
              {children}
              <Toaster />
            </LocaleProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
