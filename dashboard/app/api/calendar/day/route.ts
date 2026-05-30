import { type NextRequest, NextResponse } from 'next/server';
import { getDayEvents } from '@/lib/calendar/calendar';

export const dynamic = 'force-dynamic';

// MBOX-398 — operator-facing day view for the right-rail Calendar panel.
// GET /api/calendar/day?date=YYYY-MM-DD (defaults to today in GENERIC_TIMEZONE).
// Caddy basic_auth gated (operator-facing). Never 500s on a calendar failure —
// returns the typed reason so the panel renders connect/retry states.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = req.nextUrl.searchParams.get('date');
  const tz = process.env.GENERIC_TIMEZONE ?? 'UTC';
  const date =
    raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? raw
      : new Date().toLocaleDateString('en-CA', { timeZone: tz });
  try {
    return NextResponse.json(await getDayEvents(date));
  } catch (error) {
    console.error('GET /api/calendar/day failed:', error);
    return NextResponse.json({ reason: 'fetch_failed', date, events: [] });
  }
}
