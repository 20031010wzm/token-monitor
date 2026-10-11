'use strict';

const { extractUsageFromTokscale, mergePeriods, emptyPeriod, normalizeClientName, applyProjectRollups, UNATTRIBUTED_USAGE_CLIENT } = require('../usage');
const { isDeepStrictEqual } = require('node:util');
const SESSION_METADATA_FIELDS = ['title', 'projectId', 'projectLabel', 'sessionKind', 'parentSessionId', 'startedAt', 'lastUsedAt',
  'contextTokens', 'contextWindow', 'turnEnded', 'waitingForInput', 'promptCache', 'liveActivity'];

function copySessionMetadata(row, prior) {
  if (!prior) return;
  for (const field of SESSION_METADATA_FIELDS) {
    if (prior[field] !== undefined) row[field] = prior[field];
  }
}

function matchingBuckets(snapshot, today, timeZone) {
  return snapshot?.bucketTimezone === timeZone && snapshot.dayKey === today;
}

function retainedBucketMetadata(snapshot, timeZone) {
  if (snapshot?.bucketTimezone !== timeZone) return false;
  // A prior scan's calendar remains valid after midnight. A current scan that
  // declares a different day from its own capture clock is inconsistent.
  const capturedAt = new Date(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(capturedAt).map(part => [part.type, part.value]));
  return snapshot.dayKey === `${parts.year}-${parts.month}-${parts.day}`;
}

function accountingMatches(current, previous) {
  return current && previous && ['totalTokens', 'costUsd', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'models', 'modelCosts']
    .every(field => isDeepStrictEqual(current[field], previous[field]));
}

function carryMatchingPerformance(period, native) {
  const keys = Object.keys(period.sessions);
  if (!accountingMatches(period, native) || !isDeepStrictEqual(keys.sort(), Object.keys(native?.sessions || {}).sort())
    || keys.some(key => !accountingMatches(period.sessions[key], native.sessions[key]))) {
    if (period.totalTokens > 0) { period.capabilities.throughput = false; delete period.modelThroughput; }
    return;
  }
  // Keep timing only when the native period describes this same accounting
  // snapshot. A correction must never pair new output with an old duration.
  for (const key of keys) {
    period.sessions[key].timedDurationMs = native.sessions[key].timedDurationMs;
    period.sessions[key].timedOutputTokens = native.sessions[key].timedOutputTokens;
  }
  for (const field of ['timedTokens', 'timedOutputTokens', 'timedDurationMs', 'modelThroughput']) {
    if (native[field] !== undefined) period[field] = native[field];
  }
  period.capabilities.throughput = native.capabilities.throughput;
}

function snapshotPeriod(snapshot, periodName, today, since, pastOnly = false) {
  const entries = (snapshot.days || [])
    .filter(day => day.date <= today && (!pastOnly || day.date < today) && (periodName === 'today' ? day.date === today
      : periodName === 'month' ? day.date.slice(0, 7) === today.slice(0, 7) : !since || day.date >= since))
    .flatMap(day => (day.clients || []).map(row => ({
      client: snapshot.client, sessionId: snapshot.sessionId, model: row.modelId, provider: row.providerId,
      input: row.tokens?.input, output: row.tokens?.output,
      cacheRead: row.tokens?.cacheRead, cacheWrite: row.tokens?.cacheWrite,
      reasoning: row.tokens?.reasoning, cost: row.cost, messages: row.messages
    })));
  return extractUsageFromTokscale({ entries });
}

// Full graph ticks own accounting for an entire managed client. Watch ticks
// keep their exact native delta; only absent IDs need retained daily rows.
function applySourceDailyUsage(summary, sourceUsage, options = {}) {
  if (sourceUsage?.version !== 1 || !Array.isArray(sourceUsage.sessions)) return;
  const today = String(options.todayKey || '').slice(0, 10);
  const since = String(options.allTimeSince || '').slice(0, 10);
  const selected = options.clients === undefined ? null : new Set(String(options.clients).split(',').map(normalizeClientName).filter(Boolean));
  const timeZone = options.timeZone || summary.periodWindows?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const snapshots = [
    ...sourceUsage.sessions.map(snapshot => ({ snapshot, unresolved: false })),
    ...(sourceUsage.unresolvedSessions || []).map(snapshot => ({ snapshot, unresolved: true }))
  ].filter(({ snapshot }) => snapshot?.bucketTimezone === timeZone
    && (!selected || selected.has(normalizeClientName(snapshot.client))));
  const managed = new Set();
  const sourceClients = new Set((sourceUsage.clients || []).filter(client => !selected || selected.has(normalizeClientName(client))));
  const blockedReplacements = new Set();
  const freshClients = new Set(options.sourceClients || []);
  for (const [rawClient, snapshot] of Object.entries(sourceUsage.sourceSnapshots || {})) {
    // Identified rows can retain absent IDs alongside an unresolved residual;
    // that permission never becomes authority to replace the native lane.
    if (snapshot.projectIdentified === true && (!selected || selected.has(normalizeClientName(rawClient)))) sourceClients.add(rawClient);
    if (!retainedBucketMetadata(snapshot, timeZone)
      || (snapshot.replacementAuthority !== true && snapshot.projectIdentified !== true)) sourceClients.delete(rawClient);
    if (!sourceClients.has(rawClient) || !matchingBuckets(snapshot, today, timeZone)
      || snapshot.replacementAuthority !== true || !freshClients.has(rawClient)) blockedReplacements.add(normalizeClientName(rawClient));
  }
  for (const rawClient of sourceUsage.unresolvedClients || []) {
    if (sourceUsage.sourceSnapshots?.[rawClient]?.projectIdentified !== true) sourceClients.delete(rawClient);
    blockedReplacements.add(normalizeClientName(rawClient));
  }
  if (!sourceClients.size) {
    if (summary.sessionArchiveSource) summary.sessionArchiveSource.managedKeys = [];
    return;
  }
  const replacingRawClients = new Set([...freshClients].filter(client => sourceClients.has(client)
    && sourceUsage.sourceSnapshots?.[client]?.replacementAuthority === true
    && matchingBuckets(sourceUsage.sourceSnapshots[client], today, timeZone)));
  const rawNativeAvailable = ['today', 'month', 'allTime'].every(name => options.nativeRawPartitions?.[name]);
  const replacingClients = new Set([...replacingRawClients].map(normalizeClientName)
    .filter(client => rawNativeAvailable || !blockedReplacements.has(client)));
  const replaceLive = options.replaceLive === true && replacingClients.size > 0
    && ['today', 'month', 'allTime'].every(name => options.nativePartitions?.[name]
      && !options.nativePartitions[name][UNATTRIBUTED_USAGE_CLIENT]?.totalTokens
      && !options.nativePartitions[name][UNATTRIBUTED_USAGE_CLIENT]?.costUsd);
  const metadata = new Map();
  for (const name of ['allTime', 'month', 'today']) {
    for (const [key, session] of Object.entries(summary[name]?.sessions || {})) metadata.set(key, session);
  }
  for (const name of ['today', 'month', 'allTime']) {
    if (!summary[name]) continue;
    const nativePeriod = options.nativePeriods?.[name] || summary[name];
    const live = new Set(Object.keys(nativePeriod.sessions || {}));
    const rawLive = options.nativeRawPresence?.[name] ? new Set(options.nativeRawPresence[name]) : null;
    const rawAnchor = options.nativeAnchor?.nativeRawPresence?.[name] ? new Set(options.nativeAnchor.nativeRawPresence[name]) : null;
    if (rawLive && rawAnchor) for (const key of rawAnchor) rawLive.add(key);
    // A watch correction can remove today's last row. Its full-scan baseline
    // still proves this identity was native, so replay must not undo that delta.
    for (const key of Object.keys(options.nativeAnchor?.[name]?.sessions || {})) live.add(key);
    // Legacy direct projections may supply presence without the native periods.
    if (!options.nativePeriods) for (const key of summary.sessionArchiveSource?.presentKeys || []) live.add(key);
    const retained = [];
    const observed = [];
    for (const { snapshot, unresolved } of snapshots) {
      const client = normalizeClientName(snapshot.client);
      const key = `${client}:${snapshot.sessionId}`;
      const rawKey = `${snapshot.client}:${snapshot.sessionId}`;
      if (!sourceClients.has(snapshot.client)) continue;
      // Null event groups remain a separate append-only lane. They can retain
      // an absent raw ID, but can never correct an observed native session.
      if (unresolved && sourceUsage.sourceSnapshots?.[snapshot.client]?.projectIdentified !== true) continue;
      managed.add(key);
      const replaceClient = !unresolved && replaceLive && replacingClients.has(client) && replacingRawClients.has(snapshot.client);
      const isLive = rawLive ? rawLive.has(rawKey) : live.has(key);
      const inAnchor = rawAnchor ? rawAnchor.has(rawKey) : options.nativeAnchor?.[name]?.sessions?.[key];
      const pastOnly = !replaceClient && name !== 'today' && isLive && options.nativeAnchor && !inAnchor;
      if (!replaceClient && isLive && !pastOnly) continue;
      const period = snapshotPeriod(snapshot, name, today, since, pastOnly);
      const row = period.sessions[key];
      if (row) {
        copySessionMetadata(row, metadata.get(key));
        if (!replaceClient || snapshot.sourceState !== 'present') {
          row.sourceState = snapshot.sourceState === 'missing' ? 'missing' : 'unknown';
          row.retained = true;
          for (const field of ['contextTokens', 'contextWindow', 'turnEnded', 'waitingForInput', 'promptCache']) delete row[field];
          delete row.liveActivity;
          if (row.sourceState === 'missing') row.archived = true;
        }
      }
      if (snapshot.sourceState === 'present' && replaceClient) observed.push({ rawClient: snapshot.client, period });
      else {
        if (period.totalTokens > 0) { period.capabilities.throughput = false; delete period.modelThroughput; }
        retained.push(period);
      }
    }
    if (replaceLive) {
      const untouched = Object.entries(options.nativePartitions[name]).filter(([client]) => !replacingClients.has(client)).map(([, period]) => period);
      const observedByClient = Object.fromEntries([...replacingClients].map(client => {
        if (rawNativeAvailable) {
          const untouchedRaw = Object.entries(options.nativeRawPartitions[name])
            .filter(([raw]) => normalizeClientName(raw) === client && !replacingRawClients.has(raw)).map(([, period]) => period);
          const observedRaw = [...replacingRawClients].filter(raw => normalizeClientName(raw) === client).map(raw => {
            const period = mergePeriods(...observed.filter(row => row.rawClient === raw).map(row => row.period));
            carryMatchingPerformance(period, options.nativeRawPartitions[name][raw]);
            options.nativeRawPartitions[name][raw] = period;
            return period;
          });
          return [client, mergePeriods(...untouchedRaw, ...observedRaw)];
        }
        const period = mergePeriods(...observed.filter(row => normalizeClientName(row.rawClient) === client).map(row => row.period));
        carryMatchingPerformance(period, options.nativePartitions[name][client]);
        return [client, period];
      }));
      const native = mergePeriods(...untouched, ...Object.values(observedByClient));
      for (const [key, row] of Object.entries(native.sessions)) {
        copySessionMetadata(row, summary[name].sessions?.[key] || metadata.get(key));
      }
      if (options.nativePeriods) options.nativePeriods[name] = native;
      if (rawNativeAvailable && options.nativeRawPresence) {
        options.nativeRawPresence[name] = Object.entries(options.nativeRawPartitions[name])
          .flatMap(([raw, period]) => Object.values(period.sessions || {}).map(row => `${raw}:${row.sessionId}`));
      }
      if (name === 'today') {
        for (const client of replacingClients) options.nativePartitions.today[client] = observedByClient[client];
      }
      summary[name] = mergePeriods(native, ...retained, options.supplementalPeriods?.[name] || emptyPeriod());
    } else {
      summary[name] = mergePeriods(summary[name], ...retained);
    }
  }
  if (replaceLive) applyProjectRollups(summary);
  if (summary.sessionArchiveSource) summary.sessionArchiveSource.managedKeys = [...managed];
}

module.exports = { applySourceDailyUsage };
