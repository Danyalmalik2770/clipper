import React from 'react';
import { clsx } from 'clsx';

export function ClipperMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={clsx('shrink-0', className)}
      aria-hidden="true"
    >
      <circle cx="15" cy="19" r="6.5" stroke="currentColor" strokeWidth="4.8" />
      <circle cx="15" cy="45" r="6.5" stroke="currentColor" strokeWidth="4.8" />
      <path
        d="M20.5 23L40 43M20.5 41L40 21"
        stroke="currentColor"
        strokeWidth="4.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M44.5 25L55.5 32L44.5 39Z"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ClipperWordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 390 106"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={clsx('shrink-0', className)}
      role="img"
      aria-label="clipper"
    >
      <path
        d="M53.6 34.4A22 22 0 1 0 38 72L74 72L74 12"
        stroke="currentColor"
        strokeWidth="9.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M100 30L100 72"
        stroke="currentColor"
        strokeWidth="9.5"
        strokeLinecap="round"
      />
      <circle cx="100" cy="14" r="5" fill="currentColor" />
      <path
        d="M128 94L128 50A22 22 0 1 1 172 50A22 22 0 1 1 128 50"
        stroke="currentColor"
        strokeWidth="9.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M198 94L198 50A22 22 0 1 1 242 50A22 22 0 1 1 198 50"
        stroke="currentColor"
        strokeWidth="9.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M268 50L312 50A22 22 0 1 0 306.8 64.1"
        stroke="currentColor"
        strokeWidth="9.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M338 72L338 50A22 22 0 0 1 360 28L374 28"
        stroke="currentColor"
        strokeWidth="9.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ClipperLogo({
  size = 'md',
  showWordmark = true,
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  showWordmark?: boolean;
  className?: string;
}) {
  const sizes = {
    sm: { box: 'h-7 w-7 rounded-lg', icon: 'h-4 w-4', word: 'h-5' },
    md: { box: 'h-8 w-8 rounded-lg', icon: 'h-5 w-5', word: 'h-6' },
    lg: { box: 'h-11 w-11 rounded-xl', icon: 'h-6 w-6', word: 'h-8' },
  }[size];

  return (
    <div className={clsx('inline-flex items-center gap-2.5 text-foreground', className)}>
      <div
        className={clsx(
          'flex items-center justify-center bg-foreground text-background shadow-sm',
          sizes.box
        )}
      >
        <ClipperMark className={sizes.icon} />
      </div>
      {showWordmark && <ClipperWordmark className={sizes.word} />}
    </div>
  );
}
