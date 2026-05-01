// STAQPRO-128 — operator-facing pipeline alerts.
//
// Pure logic: each evaluator takes a query-result-shaped input and returns
// either a single Alert or null. The route assembles inputs from
// queries-system.ts and folds the evaluator outputs into the response.
//
// Alert codes are stable wire identifiers; thresholds are defined here so
// they can be changed in one place and asserted in tests.

export type AlertSeverity = 'warn' | 'alarm';

export type AlertCode = 'DRAFT_BACKLOG_AGED' | 'N8N_EXEC_FAILURES' | 'CLOUD_COST_SPIKE';

export interface Alert {
  severity: AlertSeverity;
  code: AlertCode;
  message: string;
  value: number;
  threshold: number;
}

export const DRAFT_BACKLOG_THRESHOLD_HOURS = 4;
export const DRAFT_BACKLOG_WARN_COUNT = 0;
export const DRAFT_BACKLOG_ALARM_COUNT = 5;

export const N8N_FAILURE_RATE_WARN = 0.05;
export const N8N_FAILURE_RATE_ALARM = 0.2;

export const COST_SPIKE_MIN_TRIGGER_USD = 0.5;
export const COST_SPIKE_RATIO_WARN = 3;
export const COST_SPIKE_RATIO_ALARM = 10;

export interface DraftBacklogInput {
  aged_count: number;
  threshold_hours: number;
}

export function evaluateDraftBacklog(input: DraftBacklogInput): Alert | null {
  if (input.aged_count > DRAFT_BACKLOG_ALARM_COUNT) {
    return {
      severity: 'alarm',
      code: 'DRAFT_BACKLOG_AGED',
      message: `${input.aged_count} drafts pending > ${input.threshold_hours}h — operator approval queue stalled`,
      value: input.aged_count,
      threshold: DRAFT_BACKLOG_ALARM_COUNT,
    };
  }
  if (input.aged_count > DRAFT_BACKLOG_WARN_COUNT) {
    return {
      severity: 'warn',
      code: 'DRAFT_BACKLOG_AGED',
      message: `${input.aged_count} drafts pending > ${input.threshold_hours}h — operator approval queue lagging`,
      value: input.aged_count,
      threshold: DRAFT_BACKLOG_WARN_COUNT,
    };
  }
  return null;
}

export interface N8nFailuresInput {
  failed_count: number;
  total_count: number;
}

export function evaluateN8nFailures(input: N8nFailuresInput): Alert | null {
  if (input.total_count === 0) return null;
  const rate = input.failed_count / input.total_count;
  const pct = (rate * 100).toFixed(1);
  if (rate > N8N_FAILURE_RATE_ALARM) {
    return {
      severity: 'alarm',
      code: 'N8N_EXEC_FAILURES',
      message: `n8n execution failure rate ${pct}% (${input.failed_count}/${input.total_count}) over last 24h`,
      value: rate,
      threshold: N8N_FAILURE_RATE_ALARM,
    };
  }
  if (rate > N8N_FAILURE_RATE_WARN) {
    return {
      severity: 'warn',
      code: 'N8N_EXEC_FAILURES',
      message: `n8n execution failure rate ${pct}% (${input.failed_count}/${input.total_count}) over last 24h`,
      value: rate,
      threshold: N8N_FAILURE_RATE_WARN,
    };
  }
  return null;
}

export interface CloudCostSpikeInput {
  last_hour_usd: number;
  trailing_24h_usd: number;
  min_trigger_usd: number;
}

export function evaluateCloudCostSpike(input: CloudCostSpikeInput): Alert | null {
  if (input.last_hour_usd < input.min_trigger_usd) return null;
  const hourlyAvg = input.trailing_24h_usd / 24;
  if (hourlyAvg <= 0) return null;
  const ratio = input.last_hour_usd / hourlyAvg;
  const fmt = `$${input.last_hour_usd.toFixed(4)} in last hour — ${ratio.toFixed(1)}x trailing 24h avg ($${hourlyAvg.toFixed(4)}/hr)`;
  if (ratio > COST_SPIKE_RATIO_ALARM) {
    return {
      severity: 'alarm',
      code: 'CLOUD_COST_SPIKE',
      message: `Cloud spend ${fmt}`,
      value: ratio,
      threshold: COST_SPIKE_RATIO_ALARM,
    };
  }
  if (ratio > COST_SPIKE_RATIO_WARN) {
    return {
      severity: 'warn',
      code: 'CLOUD_COST_SPIKE',
      message: `Cloud spend ${fmt}`,
      value: ratio,
      threshold: COST_SPIKE_RATIO_WARN,
    };
  }
  return null;
}

export interface AlertInputs {
  draftBacklog: DraftBacklogInput | null;
  n8nFailures: N8nFailuresInput | null;
  cloudCostSpike: CloudCostSpikeInput | null;
}

export function evaluateAlerts(inputs: AlertInputs): Alert[] {
  const alerts: Alert[] = [];
  if (inputs.draftBacklog) {
    const a = evaluateDraftBacklog(inputs.draftBacklog);
    if (a) alerts.push(a);
  }
  if (inputs.n8nFailures) {
    const a = evaluateN8nFailures(inputs.n8nFailures);
    if (a) alerts.push(a);
  }
  if (inputs.cloudCostSpike) {
    const a = evaluateCloudCostSpike(inputs.cloudCostSpike);
    if (a) alerts.push(a);
  }
  return alerts;
}
