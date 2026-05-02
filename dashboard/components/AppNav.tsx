// Top-level surface switcher across /queue, /classifications, /status. Used by
// every page header so the operator can flip between the three operator
// surfaces without back-buttoning. basePath-aware via apiUrl so links work
// in dev (no basePath) and in prod (basePath=/dashboard).

import { apiUrl } from '@/lib/api';

type Slug = 'queue' | 'classifications' | 'knowledge-base' | 'status' | 'settings';

const NAV: { slug: Slug; href: string; label: string }[] = [
  { slug: 'queue', href: '/queue', label: 'Queue' },
  { slug: 'classifications', href: '/classifications', label: 'Classifications' },
  { slug: 'knowledge-base', href: '/knowledge-base', label: 'Knowledge Base' },
  { slug: 'status', href: '/status', label: 'Status' },
  { slug: 'settings', href: '/settings/persona', label: 'Settings' },
];

export function AppNav({ active }: { active: Slug }) {
  return (
    <nav className="flex items-center gap-1 font-mono text-[11px]">
      {NAV.map(({ slug, href, label }) => {
        const isActive = slug === active;
        return (
          <a
            key={slug}
            href={apiUrl(href)}
            aria-current={isActive ? 'page' : undefined}
            className={`rounded px-2 py-1 transition-colors ${
              isActive ? 'bg-bg-deep text-ink' : 'text-ink-muted hover:bg-bg-deep hover:text-ink'
            }`}
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}
