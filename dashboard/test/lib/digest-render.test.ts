import { describe, expect, it } from 'vitest';
import { renderDigest } from '@/lib/digest/render';
import type { DigestPayload } from '@/lib/queries-digest';

// MBOX-132 — pure unit tests for the digest HTML renderer (no DB). Covers the
// subject line, section presence/suppression, deep-link behavior, and HTML
// escaping of attacker-influenced inbound fields.

const NOW = new Date('2026-05-22T09:00:00Z');

function emptyPayload(): DigestPayload {
  return { counts_by_category: [], urgent_untouched: [], oldest_pending: [] };
}

describe('renderDigest', () => {
  it('builds a subject with urgent + pending counts and the date', () => {
    const payload: DigestPayload = {
      counts_by_category: [
        { category: 'inquiry', count: 3 },
        { category: 'reorder', count: 2 },
      ],
      urgent_untouched: [
        {
          draft_id: 1,
          from_addr: 'ceo@acme.com',
          subject: 'Need this today',
          snippet: 'please',
          category: 'escalate',
          age_hours: 2,
          signals: ['escalate'],
        },
      ],
      oldest_pending: [],
    };
    const { subject, html } = renderDigest(payload, { now: NOW });
    expect(subject).toContain('1 urgent');
    expect(subject).toContain('5 pending'); // 3 + 2
    expect(subject).toContain('May 22, 2026');
    expect(html).toContain('Urgent — needs your eyes');
    expect(html).toContain('Pending by category');
  });

  it('suppresses the urgent section when there are no urgent rows', () => {
    const payload = emptyPayload();
    payload.counts_by_category = [{ category: 'inquiry', count: 1 }];
    const { html } = renderDigest(payload, { now: NOW });
    expect(html).not.toContain('Urgent — needs your eyes');
    expect(html).toContain('Pending by category');
  });

  it('renders an "Open in queue" deep-link only when queueUrl is provided', () => {
    const payload: DigestPayload = {
      counts_by_category: [],
      urgent_untouched: [
        {
          draft_id: 42,
          from_addr: 'a@b.com',
          subject: 's',
          snippet: 'x',
          category: 'escalate',
          age_hours: 1,
          signals: ['escalate'],
        },
      ],
      oldest_pending: [],
    };
    const withUrl = renderDigest(payload, {
      now: NOW,
      queueUrl: 'https://m.staqs.io/dashboard/queue',
    });
    expect(withUrl.html).toContain('https://m.staqs.io/dashboard/queue?focus=42');

    const noUrl = renderDigest(payload, { now: NOW, queueUrl: null });
    expect(noUrl.html).not.toContain('Open in queue');
  });

  it('drops a non-http(s) queueUrl scheme — no javascript: deep-link in href', () => {
    const payload: DigestPayload = {
      counts_by_category: [],
      urgent_untouched: [
        {
          draft_id: 42,
          from_addr: 'a@b.com',
          subject: 's',
          snippet: 'x',
          category: 'escalate',
          age_hours: 1,
          signals: ['escalate'],
        },
      ],
      oldest_pending: [],
    };
    const evil = renderDigest(payload, { now: NOW, queueUrl: 'javascript:alert(1)' });
    expect(evil.html).not.toContain('javascript:');
    expect(evil.html).not.toContain('Open in queue');
  });

  it('HTML-escapes attacker-influenced inbound fields (subject/snippet)', () => {
    const payload: DigestPayload = {
      counts_by_category: [],
      urgent_untouched: [
        {
          draft_id: 7,
          from_addr: 'x@y.com',
          subject: '<script>alert(1)</script>',
          snippet: 'a & b < c > d "q"',
          category: 'escalate',
          age_hours: 1,
          signals: ['escalate'],
        },
      ],
      oldest_pending: [],
    };
    const { html } = renderDigest(payload, { now: NOW });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a &amp; b &lt; c &gt; d &quot;q&quot;');
  });

  it('handles a fully empty payload without throwing', () => {
    const { html, subject } = renderDigest(emptyPayload(), { now: NOW });
    expect(subject).toContain('0 urgent');
    expect(subject).toContain('0 pending');
    expect(html).toContain('MailBox One — Daily digest');
  });
});
