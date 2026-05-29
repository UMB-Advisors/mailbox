'use client';

import {
  Calendar,
  CalendarPlus,
  ExternalLink,
  FolderOpen,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { apiUrl } from '@/lib/api';
import {
  buildCalendarEmbedUrl,
  buildDriveEmbedUrl,
  calendarExternalUrl,
  driveExternalUrl,
} from '@/lib/embed';

// P4 (MBOX-162, sandbox UI port §4) — the queue's third pane. Tabbed
// Calendar / Drive embeds built from operator_settings (calendar_embed_src /
// drive_folder_id), ported from the sandbox's RightPane (logic only — no
// fixtures). Tokenized to the prod @theme palette (P1a) rather than the
// sandbox's raw zinc/indigo. The open/closed toggle + the surrounding
// PanelGroup panel live in QueueClient; this component owns only the pane body.
//
// Both Google Calendar and Drive's main apps refuse to iframe (X-Frame-Options:
// SAMEORIGIN); buildCalendarEmbedUrl / buildDriveEmbedUrl target the supported
// public embed endpoints. Empty values → a configure CTA linking to the
// workspace settings page.

type RightPaneTab = 'calendar' | 'drive';
const RIGHT_PANE_TAB_KEY = 'mailbox-queue-right-pane-tab-v1';
const WORKSPACE_SETTINGS_HREF = '/settings/workspace';

export function RightPane({
  calendarSrc,
  driveFolderId,
  onClose,
}: {
  calendarSrc: string;
  driveFolderId: string;
  onClose: () => void;
}) {
  // Which tab is active. Persisted to localStorage (same approach as the
  // QueueClient open/closed pref) so it survives reload; defaults to 'calendar'
  // and hydrates on mount to avoid an SSR/client markup mismatch.
  const [tab, setTab] = useState<RightPaneTab>('calendar');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RIGHT_PANE_TAB_KEY);
      if (saved === 'calendar' || saved === 'drive') setTab(saved);
    } catch {
      // localStorage unavailable — keep default.
    }
  }, []);

  const selectTab = (t: RightPaneTab) => {
    setTab(t);
    try {
      localStorage.setItem(RIGHT_PANE_TAB_KEY, t);
    } catch {
      // best-effort persistence
    }
  };

  const calendarEmbedUrl = buildCalendarEmbedUrl(calendarSrc);
  const driveEmbedUrl = buildDriveEmbedUrl(driveFolderId);
  const externalUrl = tab === 'calendar' ? calendarExternalUrl() : driveExternalUrl(driveFolderId);

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-bg-deep">
      {/* Header: tab strip + actions */}
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle bg-bg-panel px-2">
        <TabButton
          active={tab === 'calendar'}
          onClick={() => selectTab('calendar')}
          icon={<Calendar className="h-3.5 w-3.5" aria-hidden />}
          label="Calendar"
        />
        <TabButton
          active={tab === 'drive'}
          onClick={() => selectTab('drive')}
          icon={<FolderOpen className="h-3.5 w-3.5" aria-hidden />}
          label="Drive"
        />
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open Google ${tab === 'calendar' ? 'Calendar' : 'Drive'} in a new tab`}
          className="ml-auto rounded-sm p-1 text-ink-dim hover:bg-bg-deep hover:text-ink"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
        <a
          href={apiUrl(WORKSPACE_SETTINGS_HREF)}
          title="Workspace settings"
          aria-label="Workspace settings"
          className="rounded-sm p-1 text-ink-dim hover:bg-bg-deep hover:text-ink"
        >
          <SettingsIcon className="h-3.5 w-3.5" aria-hidden />
        </a>
        <button
          type="button"
          onClick={onClose}
          title="Hide right pane"
          aria-label="Hide right pane"
          className="rounded-sm p-1 text-ink-dim hover:bg-bg-deep hover:text-ink"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      {/* Body — render the matching sub-view */}
      {tab === 'calendar' ? (
        calendarEmbedUrl ? (
          <iframe
            title="Google Calendar"
            src={calendarEmbedUrl}
            className="min-h-0 flex-1 border-0"
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-same-origin"
          />
        ) : (
          <PaneEmptyState
            icon={<CalendarPlus className="h-8 w-8 text-ink-dim" aria-hidden />}
            title="No calendar configured"
            description="Add a Google Calendar email or calendar ID in Workspace settings to embed your agenda here. Private events show 'Busy' unless the source calendar's sharing is set to 'See all event details'."
          />
        )
      ) : driveEmbedUrl ? (
        <iframe
          title="Google Drive"
          src={driveEmbedUrl}
          className="min-h-0 flex-1 border-0"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        />
      ) : (
        <PaneEmptyState
          icon={<FolderOpen className="h-8 w-8 text-ink-dim" aria-hidden />}
          title="No Drive folder configured"
          description="Add a Google Drive folder ID in Workspace settings (the part after /drive/folders/ in any folder URL). The folder must be shared with viewers, or you must be signed into the same Google account in this browser."
        />
      )}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-7 items-center gap-1.5 rounded-sm px-2 font-mono text-[11px] transition-colors ${
        active ? 'bg-bg-deep text-ink' : 'text-ink-muted hover:bg-bg-deep hover:text-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function PaneEmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      {icon}
      <div className="text-sm font-medium text-ink">{title}</div>
      <p className="max-w-xs text-xs text-ink-muted">{description}</p>
      <a
        href={apiUrl(WORKSPACE_SETTINGS_HREF)}
        className="mt-1 inline-flex items-center gap-1.5 rounded-sm bg-accent-orange px-4 py-1.5 font-sans text-xs font-semibold text-bg-deep transition-colors hover:bg-accent-orange/90"
      >
        <SettingsIcon className="h-3.5 w-3.5" aria-hidden />
        Open Workspace settings
      </a>
    </div>
  );
}
