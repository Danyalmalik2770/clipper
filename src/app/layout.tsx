import React from 'react';
import type { Metadata } from 'next';
import './globals.css';
import { AppShell } from '@/components/app-shell';
import { ToastProvider } from '@/components/ui';
import { getGoogleFontsStylesheetUrl } from '@/lib/fonts';

export const metadata: Metadata = {
  title: 'Clipper - Local Viral Clip Studio',
  description: '100% Free, Zero-Backend YouTube Live & VOD Viral Clip Studio',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="stylesheet" href={getGoogleFontsStylesheetUrl()} />
      </head>
      <body>
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
