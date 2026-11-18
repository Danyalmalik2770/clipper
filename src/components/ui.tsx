"use client";
import React, { createContext, useCallback, useContext, useState } from 'react';
import { clsx } from 'clsx';

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx('rounded-xl border border-border bg-card text-foreground shadow-sm', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9 px-4 text-sm',
        variant === 'primary' && 'bg-violet-600 text-white hover:bg-violet-500',
        variant === 'secondary' && 'border border-border bg-muted/60 hover:bg-muted',
        variant === 'ghost' && 'hover:bg-muted',
        variant === 'danger' && 'bg-rose-600/90 text-white hover:bg-rose-500',
        className
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={clsx(
        'h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-violet-500',
        className
      )}
      {...props}
    />
  );
}

export function Badge({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'green' | 'amber' | 'violet' | 'rose';
}) {
  const tones = {
    default: 'bg-muted text-foreground/80',
    green: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    amber: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    violet: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    rose: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  };
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-lg bg-muted/70', className)} />;
}

interface ToastItem {
  id: number;
  message: string;
}

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = useCallback((message: string) => {
    const id = Date.now();
    setToasts((t) => [...t, { id, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm shadow-xl"
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
