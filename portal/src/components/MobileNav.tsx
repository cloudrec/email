'use client';

import { useState, useEffect, useCallback } from 'react';
import { LanguageSwitcher } from './LanguageSwitcher';
import { type Locale } from '../i18n';

interface Props {
  locale: Locale;
  nav: {
    home: string;
    features: string;
    howItWorks: string;
    instructions: string;
    safety: string;
    faq: string;
    login: string;
    openDashboard: string;
  };
  loginLabel: string;
  dashboardLabel: string;
  isLoggedIn?: boolean;
}

export function MobileNav({ locale, nav, loginLabel, dashboardLabel, isLoggedIn }: Props) {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  // Close on ESC
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, close]);

  // Lock body scroll when open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const links = [
    { href: '/', label: nav.home },
    { href: '/features', label: nav.features },
    { href: '/how-it-works', label: nav.howItWorks },
    { href: '/instructions', label: nav.instructions },
    { href: '/safety', label: nav.safety },
    { href: '/faq', label: nav.faq },
  ];

  return (
    <>
      {/* Hamburger button — only visible on mobile via CSS */}
      <button
        className="mob-hamburger"
        aria-label="Open navigation menu"
        aria-expanded={open}
        aria-controls="mob-drawer"
        onClick={() => setOpen(true)}
      >
        <span /><span /><span />
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="mob-backdrop"
          aria-hidden="true"
          onClick={close}
        />
      )}

      {/* Drawer */}
      <div
        id="mob-drawer"
        className={`mob-drawer${open ? ' mob-drawer--open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <div className="mob-drawer-head">
          <span className="mob-drawer-brand">
            <span className="mark" aria-hidden="true" /> Email Platform
          </span>
          <button
            className="mob-drawer-close"
            aria-label="Close navigation menu"
            onClick={close}
          >
            ✕
          </button>
        </div>

        <nav className="mob-drawer-links">
          {links.map((l) => (
            <a key={l.href} href={l.href} className="mob-drawer-link" onClick={close}>
              {l.label}
            </a>
          ))}
          <div className="mob-drawer-divider" />
          {isLoggedIn ? (
            <a href="/dashboard" className="mob-drawer-link mob-drawer-link--cta" onClick={close}>
              {dashboardLabel}
            </a>
          ) : (
            <a href="/login" className="mob-drawer-link mob-drawer-link--cta" onClick={close}>
              {loginLabel}
            </a>
          )}
        </nav>

        <div className="mob-drawer-footer">
          <LanguageSwitcher current={locale} />
        </div>
      </div>
    </>
  );
}
