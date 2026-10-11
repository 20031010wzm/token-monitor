'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { sharedDataDir, writeJsonAtomic } = require('./config');
const {
  normalizeTokscaleClientName, normalizeTokscaleModelNameForClient,
  normalizeTokscaleModelComponentSummary, num, sumOutputTokens, sumTokens
} = require('./history');
const {
  CLIENT_IDENTITY_GENERATION, CLIENT_IDENTITY_SPLITS, isPreSplitEntry
} = require('./clientIdentitySplits');

const ARCHIVE_VERSION = 1;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const { classifySessionSourcePath, ownedSessionSourcePath } = require('./usage/sessionSourceState');

function sourceProjectionClient(value) {
  const client = normalizeTokscaleClientName(value);
  return client?.startsWith('cc-mirror/') ? 'claude' : client === '9router' ? 'gjc' : client;
}

function observationKey(value) {
  return JSON.stringify([
    sourceProjectionClient(value?.client) || 'unknown',
    normalizeTokscaleModelNameForClient(value?.modelId || value?.model || value?.model_id || 'unknown', value?.client)
  ]);
}

function sourceObservationKey(value) {
  return JSON.stringify([value.client, value.modelId]);
}

function providerSet(...values) {
  return [...new Set(values.flatMap(value => String(value || '').split(',').map(id => id.trim()).filter(Boolean)))].sort().join(', ');
}

function normalizeObservation(value, sourceIdentity = false) {
  if (!value || typeof value !== 'object') return null;
  const client = (sourceIdentity ? sourceClient(value.client) : sourceProjectionClient(value.client)) || 'unknown';
  const modelId = normalizeTokscaleModelNameForClient(value.modelId || value.model || value.model_id || 'unknown', normalizeTokscaleClientName(client));
  const tokens = Math.max(0, Math.round(num(value.tokens)));
  const cost = Math.max(0, num(value.cost));
  const messages = Math.max(0, Math.round(num(value.messages)));
  const reasoningTokens = Math.max(0, Math.round(num(value.reasoningTokens ?? value.reasoning_tokens)));
  const rawCacheReadTokens = Math.max(0, Math.round(num(value.cacheReadTokens ?? value.cache_read_tokens)));
  const rawCacheWriteTokens = Math.max(0, Math.round(num(value.cacheWriteTokens ?? value.cache_write_tokens)));
  const rawOutputTokens = Math.max(0, Math.round(num(value.outputTokens ?? value.output_tokens)));
  const rawComponentTokens = rawCacheReadTokens + rawCacheWriteTokens + rawOutputTokens;
  const componentsFit = rawComponentTokens <= tokens;
  const cacheReadTokens = componentsFit ? rawCacheReadTokens : 0;
  const cacheWriteTokens = componentsFit ? rawCacheWriteTokens : 0;
  const outputTokens = componentsFit ? rawOutputTokens : 0;
  const componentTokens = cacheReadTokens + cacheWriteTokens + outputTokens;
  const hasExplicitUnclassified = Object.prototype.hasOwnProperty.call(value, 'unclassifiedTokens')
    || Object.prototype.hasOwnProperty.call(value, 'unclassified_tokens');
  const unclassifiedTokens = Math.min(Math.max(0, tokens - componentTokens), Math.max(0, Math.round(
    hasExplicitUnclassified
      ? num(value.unclassifiedTokens ?? value.unclassified_tokens)
      : (value.tokenComponentsAvailable === true && componentsFit ? 0 : tokens)
  )));
  // A zero-token synthetic observation has an exact zero component breakdown
  // even when it predates the provenance field. Do not let bookkeeping-only
  // rows make an otherwise exact fixed-range breakdown unavailable.
  const tokenComponentsAvailable = componentsFit
    && componentTokens + unclassifiedTokens <= tokens
    && unclassifiedTokens === 0
    && (tokens === 0 || value.tokenComponentsAvailable === true);
  if (tokens === 0 && cost === 0 && messages === 0) return null;
  return {
    client,
    modelId,
    ...(providerSet(value.providerId || value.provider_id)
      ? { providerId: providerSet(value.providerId || value.provider_id) }
      : {}),
    tokens,
    cost,
    messages,
    ...(typeof value.pricingRevision === 'string' ? { pricingRevision: value.pricingRevision } : {}),
    ...(unclassifiedTokens > 0 ? { unclassifiedTokens } : {}),
    ...(tokenComponentsAvailable ? {
      tokenComponentsAvailable: true,
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {})
    } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {})
  };
}

function addObservation(previous, candidate) {
  if (!previous) return candidate;
  return normalizeObservation({
    ...candidate,
    providerId: providerSet(candidate.providerId, previous.providerId),
    tokens: previous.tokens + candidate.tokens,
    cost: previous.cost + candidate.cost,
    messages: previous.messages + candidate.messages,
    reasoningTokens: num(previous.reasoningTokens) + num(candidate.reasoningTokens),
    tokenComponentsAvailable: previous.tokenComponentsAvailable === true
      && candidate.tokenComponentsAvailable === true,
    cacheReadTokens: num(previous.cacheReadTokens) + num(candidate.cacheReadTokens),
    cacheWriteTokens: num(previous.cacheWriteTokens) + num(candidate.cacheWriteTokens),
    outputTokens: num(previous.outputTokens) + num(candidate.outputTokens),
    unclassifiedTokens: num(previous.unclassifiedTokens) + num(candidate.unclassifiedTokens)
  }, true);
}

function normalizeComponentValues(value, totalTokens, exact) {
  const cacheReadTokens = Math.max(0, Math.round(num(value?.cacheReadTokens)));
  const cacheWriteTokens = Math.max(0, Math.round(num(value?.cacheWriteTokens)));
  const outputTokens = Math.max(0, Math.round(num(value?.outputTokens)));
  if (cacheReadTokens + cacheWriteTokens + outputTokens > totalTokens) return null;
  const unclassifiedTokens = Math.min(
    totalTokens - cacheReadTokens - cacheWriteTokens - outputTokens,
    Math.max(0, Math.round(num(value?.unclassifiedTokens
      ?? (exact ? 0 : totalTokens - cacheReadTokens - cacheWriteTokens - outputTokens))))
  );
  return {
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(unclassifiedTokens > 0 ? { unclassifiedTokens } : {})
  };
}

function observationTokenMaps(observations) {
  const perClient = {};
  const perModel = {};
  let totalTokens = 0;
  for (const observation of Object.values(observations || {})) {
    const tokens = Math.max(0, Math.round(num(observation?.tokens)));
    totalTokens += tokens;
    perClient[observation.client] = num(perClient[observation.client]) + tokens;
    perModel[observation.modelId] = num(perModel[observation.modelId]) + tokens;
  }
  return { totalTokens, perClient, perModel };
}

function normalizeComponentSummary(value, observations) {
  if (!value || typeof value !== 'object') return null;
  const exact = value.tokenComponentsAvailable === true;
  const tokenMaps = observationTokenMaps(observations);
  const totals = normalizeComponentValues(value, tokenMaps.totalTokens, exact);
  if (!totals) return null;

  const normalizeMap = (source, tokensByKey) => {
    const result = {};
    for (const [key, tokens] of Object.entries(tokensByKey)) {
      const normalized = normalizeComponentValues(source?.[key], tokens, exact);
      if (!normalized) return null;
      if (Object.keys(normalized).length > 0) result[key] = normalized;
    }
    return result;
  };
  const foldComponentMapByClient = (map) => {
    if (!map || typeof map !== 'object') return map;
    const folded = {};
    for (const [rawClient, comp] of Object.entries(map)) {
      const client = normalizeTokscaleClientName(rawClient) || rawClient;
      if (!folded[client]) {
        folded[client] = { ...comp };
      } else {
        folded[client] = {
          cacheReadTokens: num(folded[client].cacheReadTokens) + num(comp?.cacheReadTokens),
          cacheWriteTokens: num(folded[client].cacheWriteTokens) + num(comp?.cacheWriteTokens),
          outputTokens: num(folded[client].outputTokens) + num(comp?.outputTokens),
          unclassifiedTokens: num(folded[client].unclassifiedTokens) + num(comp?.unclassifiedTokens)
        };
      }
    }
    return folded;
  };
  const perClient = normalizeMap(foldComponentMapByClient(value.perClient), tokenMaps.perClient);
  const perModel = normalizeMap(value.perModel, tokenMaps.perModel);
  if (!perClient || !perModel) return null;
  return {
    tokenComponentsAvailable: exact
      && num(totals.unclassifiedTokens) === 0
      && Object.values(perClient).every((entry) => num(entry.unclassifiedTokens) === 0)
      && Object.values(perModel).every((entry) => num(entry.unclassifiedTokens) === 0),
    ...totals,
    perClient,
    perModel
  };
}

function normalizeDay(value, fallbackDate = '', sourceIdentity = false) {
  const date = String(value?.date || fallbackDate).slice(0, 10);
  if (!DAY_KEY_RE.test(date)) return null;
  const observations = {};
  const source = Array.isArray(value?.observations)
    ? value.observations
    : Object.values(value?.observations || {});
  for (const raw of source) {
    const observation = normalizeObservation(raw, sourceIdentity);
    if (!observation) continue;
    const key = sourceIdentity ? sourceObservationKey(observation) : observationKey(observation);
    observations[key] = addObservation(observations[key], observation);
  }
  if (Object.keys(observations).length === 0 && num(value?.activeTimeMs) <= 0) return null;
  const componentSummary = normalizeComponentSummary(
    normalizeTokscaleModelComponentSummary(value?.componentSummary, source), observations
  );
  return {
    date,
    activeTimeMs: Math.max(0, Math.round(num(value?.activeTimeMs))),
    // Provenance travels with the day. An archive written before the split has
    // no marker, which is what makes it recognizable as merged-era; a day this
    // version writes carries the current generation and is taken at face value.
    ...(value?.clientIdentityGeneration !== undefined
      ? { clientIdentityGeneration: num(value.clientIdentityGeneration) }
      : {}),
    observations,
    ...(componentSummary ? { componentSummary } : {})
  };
}

function normalizeDailyHistoryArchive(value) {
  const normalized = { version: ARCHIVE_VERSION, days: {} };
  if (typeof value?.pricingRevision === 'string') normalized.pricingRevision = value.pricingRevision;
  if (value?.timeMetrics && typeof value.timeMetrics === 'object') normalized.timeMetrics = graphTimeMetrics([value], 0);
  const source = value?.days && typeof value.days === 'object' ? value.days : {};
  for (const [date, rawDay] of Object.entries(source)) {
    const day = normalizeDay(rawDay, date);
    if (day) normalized.days[day.date] = day;
  }
  const liveSource = value?.liveDays && typeof value.liveDays === 'object' ? value.liveDays : {};
  const liveDays = {};
  for (const [date, rawDay] of Object.entries(liveSource)) {
    const day = normalizeDay(rawDay, date);
    if (day) liveDays[day.date] = day;
  }
  if (Object.keys(liveDays).length > 0) normalized.liveDays = liveDays;
  if (value?.unresolvedDays && typeof value.unresolvedDays === 'object') {
    normalized.unresolvedDays = {};
    for (const [date, rawDay] of Object.entries(value.unresolvedDays)) {
      const day = normalizeDay(rawDay, date, true);
      if (day) normalized.unresolvedDays[date] = day;
    }
  }
  for (const [rawClient, entry] of Object.entries(value?.sourceSnapshots || {})) {
    const client = sourceClient(rawClient);
    const metadata = sourceMetadata(entry);
    if (!client || !metadata) continue;
    normalized.sourceSnapshots ||= {};
    normalized.sourceSnapshots[client] = {
      ...metadata, replacementAuthority: entry.replacementAuthority === true,
      ...(entry.reason ? { reason: String(entry.reason) } : {}),
      ...(validCapturedAt(entry.observationFrontier) ? { observationFrontier: entry.observationFrontier } : {}),
      ...(entry.projectIdentified === true ? { projectIdentified: true } : {}),
      ...(Array.isArray(entry.unresolvedSessionIds) ? { unresolvedSessionIds: entry.unresolvedSessionIds
        .map(id => sourceSessionId(id, client)).filter(Boolean) } : {}),
      ...(entry.fallbackDays ? { fallbackDays: sourceDays(entry.fallbackDays, client, false) || {} } : {})
    };
  }
  for (const [key, entry] of Object.entries(value?.sourceSessions || {})) {
    const client = sourceClient(entry?.client);
    const sessionId = sourceSessionId(entry?.sessionId, client);
    const metadata = sourceMetadata(entry);
    const days = sourceDays(entry?.days, client, false);
    const events = sourceEvents(entry?.events, client, false);
    if (!client || !sessionId || key !== `${client}:${sessionId}` || !metadata
      || !days || !events || !eventsMatchDays(events, days)) {
      // Pre-event archives and invalid identities cannot be made exact by
      // inventing ownership. Keep their usage available for later migration.
      normalized.unresolvedDays ||= {};
      mergeUnresolvedDays(normalized.unresolvedDays, entry?.days, true);
      if (normalized.sourceSnapshots?.[client] && Array.isArray(entry?.events) && entry?.eventIdentityVersion === 1) {
        normalized.sourceSnapshots[client].replacementAuthority = false;
        normalized.sourceSnapshots[client].reason = 'identity-gap';
      }
      continue;
    }
    const sourcePath = ownedSessionSourcePath(entry.sourcePath);
    normalized.sourceSessions ||= {};
    normalized.sourceSessions[key] = {
      client, sessionId, ...metadata, days, events,
      ...(events.some(event => event.id === null && Object.keys(event.days).length)
        ? { unresolvedDays: daysFromEvents(events.filter(event => event.id === null)) } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      sourceState: entry.sourceState === 'present' ? 'present'
        : entry.sourceState === 'missing' && sourcePath ? 'missing' : 'unknown',
      ...(validCapturedAt(entry.sourceObservedAt) ? { sourceObservedAt: entry.sourceObservedAt } : {})
    };
  }
  suspendUnresolvedEventUnions(normalized);
  const clients = Object.entries(normalized.sourceSnapshots || {})
    .filter(([, entry]) => entry.replacementAuthority).map(([client]) => client).sort();
  if (clients.length || Array.isArray(value?.sourceClients) || normalized.sourceSnapshots) normalized.sourceClients = clients;
  return normalized;
}

function sourceClient(value) {
  if (typeof value !== 'string') return null;
  const client = value.trim();
  return client && /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9_.-]+)?$/i.test(client)
    && !['unknown', 'synthetic', 'null', 'undefined'].includes(client.toLowerCase()) ? client : null;
}

function sourceSessionId(value, client) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && !id.includes('\0') && id.toLowerCase() !== 'unknown'
    && !(client === 'copilot' && id.toLowerCase() === 'unknown-session') ? id : null;
}

function eventOwnershipKey(client, id) {
  const raw = client.toLowerCase();
  const family = raw.startsWith('cc-mirror/') ? 'claude'
    : raw === '9router' ? 'gjc'
      : ['antigravity', 'antigravity-cli', 'antigravity-extension'].includes(raw) ? 'antigravity' : client;
  return `${family}:${id}`;
}

function validCapturedAt(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function sourceMetadata(value) {
  if (!validCapturedAt(value?.capturedAt) || value.eventIdentityVersion !== 1
    || typeof value.bucketTimezone !== 'string' || !value.bucketTimezone.trim()
    || typeof value.dayKey !== 'string' || !DAY_KEY_RE.test(value.dayKey)
    || !Number.isFinite(Date.parse(`${value.dayKey}T00:00:00Z`))
    || new Date(`${value.dayKey}T00:00:00Z`).toISOString().slice(0, 10) !== value.dayKey) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: value.bucketTimezone }); } catch (_) { return null; }
  return {
    capturedAt: value.capturedAt, bucketTimezone: value.bucketTimezone,
    dayKey: value.dayKey, eventIdentityVersion: 1
  };
}

function sourceDays(value, client, graphRows) {
  if (!value || typeof value !== 'object' || (graphRows && !Array.isArray(value))
    || (!graphRows && Array.isArray(value))) return null;
  if (graphRows && value.some(row => !DAY_KEY_RE.test(String(row?.date || '')) || !Array.isArray(row?.clients)
    || row.clients.some(entry => sourceClient(entry?.client) !== client))) return null;
  const days = graphRows ? Object.fromEntries(observationsFromGraphs({ contributions: value }, { sourceIdentity: true })) : value;
  const result = {};
  for (const [date, rawDay] of Object.entries(days)) {
    if (!rawDay || typeof rawDay !== 'object' || !DAY_KEY_RE.test(date)
      || (!graphRows && (!rawDay.observations || typeof rawDay.observations !== 'object'))) return null;
    if (!graphRows && Object.values(rawDay.observations).some(row => sourceClient(row?.client) !== client)) return null;
    const day = normalizeDay(rawDay, date, true);
    if (day) result[day.date] = day;
  }
  return result;
}

function sourceEvents(value, client, graphRows) {
  if (!Array.isArray(value)) return null;
  const events = [];
  const seen = new Set();
  for (const event of value) {
    if (!event || (event.id !== null && (typeof event.id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(event.id)))
      || seen.has(event.id)) return null;
    const days = sourceDays(event.days, client, graphRows);
    if (!days) return null;
    seen.add(event.id);
    events.push({ id: event.id, days });
  }
  return events;
}

function daysFromEvents(events) {
  const days = {};
  for (const event of events) {
    for (const [date, sourceDay] of Object.entries(event.days)) {
      const day = days[date] ||= { date, activeTimeMs: 0, observations: {} };
      for (const [key, observation] of Object.entries(sourceDay.observations)) {
        day.observations[key] = addObservation(day.observations[key], observation);
      }
    }
  }
  return days;
}

function eventsMatchDays(events, days) {
  const union = daysFromEvents(events);
  const dates = new Set([...Object.keys(union), ...Object.keys(days)]);
  for (const date of dates) {
    const left = union[date]?.observations || {};
    const right = days[date]?.observations || {};
    if (Object.keys(left).length !== Object.keys(right).length) return false;
    for (const [key, observation] of Object.entries(left)) {
      const other = right[key];
      if (!other || observation.tokenComponentsAvailable !== other.tokenComponentsAvailable) return false;
      if (providerSet(observation.providerId) !== providerSet(other.providerId)) return false;
      for (const field of ['tokens', 'messages', 'cost', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'unclassifiedTokens']) {
        if (Math.abs(num(observation[field]) - num(other[field])) > 1e-9 * Math.max(1, num(observation[field]), num(other[field]))) return false;
      }
    }
  }
  return true;
}

function mergeUnresolvedDays(target, source, additive = false) {
  for (const [date, rawDay] of Object.entries(source || {})) {
    const day = normalizeDay(rawDay, date, true);
    if (!day) continue;
    const previous = target[date] || { date, activeTimeMs: 0, observations: {} };
    const observations = { ...previous.observations };
    for (const [key, observation] of Object.entries(day.observations)) {
      observations[key] = additive ? addObservation(observations[key], observation) : observation;
    }
    target[date] = { ...day, activeTimeMs: Math.max(previous.activeTimeMs, day.activeTimeMs), observations };
  }
}

// The aggregate fold is additive by raw client/model. Providers are labels,
// not accounting partitions; a residual keeps the aggregate's provider set.
function remainderDays(aggregate, identified) {
  if (!aggregate) return null;
  const result = {};
  for (const date of new Set([...Object.keys(aggregate), ...Object.keys(identified)])) {
    const observations = {};
    const whole = aggregate[date]?.observations || {};
    const known = identified[date]?.observations || {};
    for (const key of new Set([...Object.keys(whole), ...Object.keys(known)])) {
      const row = whole[key];
      const removed = known[key];
      if (!row && removed) return null;
      const residual = { ...row };
      for (const field of ['tokens', 'messages', 'cost', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'unclassifiedTokens']) {
        const difference = num(row?.[field]) - num(removed?.[field]);
        if (difference < -1e-9 * Math.max(1, num(row?.[field]), num(removed?.[field]))) return null;
        residual[field] = Math.max(0, difference);
      }
      const observation = normalizeObservation(residual, true);
      if (observation) observations[key] = observation;
    }
    if (Object.keys(observations).length) result[date] = { date, activeTimeMs: 0, observations };
  }
  return result;
}

function sourceScansFromGraphs(graphs) {
  const scans = new Map();
  for (const graph of graphsArray(graphs)) {
    const source = graph.sourceUsage;
    const metadata = sourceMetadata(source);
    if (source?.version !== 1 || source.fullHistory !== true || !metadata
      || !Array.isArray(source.sessions) || !Array.isArray(source.replacementClients)) continue;
    const partial = new Set((Array.isArray(source.partialClients) ? source.partialClients : []).map(sourceClient).filter(Boolean));
    const selectedRaw = new Set(source.replacementClients.map(sourceClient).filter(Boolean));
    const selected = new Set([...selectedRaw].map(sourceProjectionClient));
    const clients = new Set(selectedRaw);
    for (const entry of source.sessions) {
      const client = sourceClient(entry?.client);
      if (client && (partial.has(client) || selected.has(sourceProjectionClient(client)))) clients.add(client);
    }
    // A synthetic-only selection has no client replacement authority. Its
    // partial clients may suspend earlier authority, but cannot acquire it.
    for (const client of partial) clients.add(client);
    for (const rawClient of Object.keys(source.rowsWithoutIdentity || {})) {
      const client = sourceClient(rawClient);
      if (client) clients.add(client);
    }
    for (const client of clients) {
      const sessions = new Map();
      const unresolvedSessionIds = new Set();
      const inScope = !partial.has(client) && selected.has(sourceProjectionClient(client));
      let reason = partial.has(client) || !inScope ? 'partial-client-scope' : '';
      if (Object.entries(source.rowsWithoutIdentity || {}).some(([rawClient, count]) => sourceClient(rawClient) === client && num(count) > 0)) reason = 'identity-gap';
      for (const entry of source.sessions.filter(entry => sourceClient(entry?.client) === client)) {
        const sessionId = sourceSessionId(entry.sessionId, client);
        const days = sourceDays(entry.days, client, true);
        const events = sourceEvents(entry.events, client, true);
        const key = `${client}:${sessionId}`;
        if (!sessionId || !days || !events || !eventsMatchDays(events, days) || sessions.has(key)) {
          reason = 'identity-gap';
          if (sessionId) unresolvedSessionIds.add(sessionId);
          continue;
        }
        sessions.set(key, { client, sessionId, ...metadata, days, events, sourceState: 'present' });
        if (events.some(event => event.id === null && Object.keys(event.days).length)) reason = 'identity-gap';
      }
      const aggregateDays = Array.isArray(graph.contributions) ? sourceDays(graph.contributions
        .map(day => ({ ...day, clients: (day.clients || []).filter(row => sourceClient(row?.client) === client) })), client, true) : null;
      if (Array.isArray(graph.contributions) && (!aggregateDays
        || !eventsMatchDays([...sessions.values()].map(entry => ({ days: entry.days })), aggregateDays))) reason = 'identity-gap';
      const eventIds = new Set();
      for (const entry of sessions.values()) for (const event of entry.events) {
        if (event.id === null) continue;
        if (eventIds.has(event.id)) reason = 'identity-gap';
        eventIds.add(event.id);
      }
      const fallbackDays = remainderDays(aggregateDays, daysFromEvents([...sessions.values()]));
      // A gap outside valid identified rows must not erase omitted retained
      // IDs. Only the unmatched aggregate remainder uses the fallback lane.
      const projectIdentified = inScope && fallbackDays !== null && eventIds.size ===
        [...sessions.values()].flatMap(entry => entry.events.filter(event => event.id !== null)).length;
      const previous = scans.get(client);
      if (previous && Date.parse(previous.capturedAt) > Date.parse(metadata.capturedAt)) continue;
      scans.set(client, { ...metadata, replacementAuthority: !reason, ...(reason ? { reason } : {}),
        ...(reason && projectIdentified ? { projectIdentified: true } : {}),
        ...(unresolvedSessionIds.size ? { unresolvedSessionIds: [...unresolvedSessionIds] } : {}),
        sessions, aggregateDays, fallbackDays: projectIdentified ? fallbackDays : aggregateDays, graph });
    }
  }
  return scans;
}

// A complete scan replaces every day/model of each observed identity, including
// zero usage. Only literal, complete client selections can grant that authority.
function sourceSnapshotsFromGraphs(graphs) {
  const sessions = new Map();
  for (const scan of sourceScansFromGraphs(graphs).values()) {
    if (scan.replacementAuthority) for (const [key, entry] of scan.sessions) sessions.set(key, entry);
  }
  return sessions;
}

function removeSourceClients(days, clients, unresolved) {
  if (!clients.size) return;
  for (const [date, day] of Object.entries(days || {})) {
    const keep = {};
    const moved = {};
    for (const [key, observation] of Object.entries(day.observations)) {
      (clients.has(sourceProjectionClient(observation.client)) ? moved : keep)[key] = observation;
    }
    if (!Object.keys(moved).length) continue;
    if (unresolved) mergeUnresolvedDays(unresolved, { [date]: { ...day, observations: moved } });
    if (Object.keys(keep).length || num(day.activeTimeMs) > 0) days[date] = { ...day, observations: keep, componentSummary: undefined };
    else delete days[date];
  }
}

function newestSourceObservation(entry) {
  return Math.max(Date.parse(entry?.capturedAt) || 0, Date.parse(entry?.sourceObservedAt) || 0,
    Date.parse(entry?.observationFrontier) || 0);
}

function suspendUnresolvedEventUnions(archive) {
  for (const entry of Object.values(archive.sourceSessions || {})) {
    if (!entry.events.some(event => event.id === null && Object.keys(event.days).length)) continue;
    const snapshot = archive.sourceSnapshots?.[entry.client];
    if (snapshot?.replacementAuthority) {
      snapshot.replacementAuthority = false;
      snapshot.reason = 'identity-gap';
      snapshot.projectIdentified = true;
      snapshot.fallbackDays = {};
    }
  }
}

function captureSourceDailyHistory(archive, graphs, options) {
  const scans = sourceScansFromGraphs(graphs);
  const rejectedGraphs = new Set();
  const rejectedClients = new Set();
  for (const graph of graphsArray(graphs)) {
    if (graph.sourceUsage || !Array.isArray(graph.contributions)) continue;
    const fallbackFamilies = new Set();
    for (const [client, previous] of Object.entries(archive.sourceSnapshots || {})) {
      if (scans.has(client)) continue;
      const family = sourceProjectionClient(client);
      const familyAggregate = client !== family && graph.contributions.some(day =>
        (day.clients || []).some(row => sourceClient(row?.client) === family));
      const rows = graph.contributions.map(day => ({ ...day,
        clients: (Array.isArray(day.clients) ? day.clients : []).filter(row =>
          familyAggregate ? sourceClient(row?.client) === family : sourceClient(row?.client) === client)
          .map(row => ({ ...row, client })) }));
      if (!rows.some(day => day.clients.length)) continue;
      const capturedAt = graph.meta?.generatedAt ?? graph.meta?.generated_at;
      if (validCapturedAt(capturedAt) && Date.parse(capturedAt) < newestSourceObservation(previous)) {
        rejectedGraphs.add(graph);
        rejectedClients.add(client);
        continue;
      }
      // This aggregate has no identity evidence. Preserve the last proven
      // metadata and session states, but suspend exact replacement authority.
      const fallbackDays = familyAggregate && fallbackFamilies.has(family) ? {} : sourceDays(rows, client, true);
      if (familyAggregate) fallbackFamilies.add(family);
      scans.set(client, { ...previous, replacementAuthority: false, reason: 'identity-gap',
        projectIdentified: false,
        ...(validCapturedAt(capturedAt) ? { observationFrontier: capturedAt } : {}),
        sessions: new Map(), aggregateDays: fallbackDays, fallbackDays, graph });
    }
  }
  const accepted = new Map();
  accepted.rejectedClients = rejectedClients;
  accepted.rejectedGraphs = rejectedGraphs;
  for (const [client, scan] of scans) {
    const capturedAt = newestSourceObservation(scan);
    if (newestSourceObservation(archive.sourceSnapshots?.[client]) > capturedAt
      || Object.values(archive.sourceSessions || {}).some(entry => entry.client === client && newestSourceObservation(entry) > capturedAt)) {
      accepted.rejectedClients.add(client);
      accepted.rejectedGraphs.add(scan.graph);
      continue;
    }
    const incomingEvents = new Set([...scan.sessions.values()].flatMap(entry => entry.events.filter(event => event.id !== null)
      .map(event => eventOwnershipKey(entry.client, event.id))));
    if (Object.values(archive.sourceSessions || {}).some(entry => entry.client !== client
      && Math.max(newestSourceObservation(entry), newestSourceObservation(archive.sourceSnapshots?.[entry.client])) > capturedAt
      && entry.events.some(event => incomingEvents.has(eventOwnershipKey(entry.client, event.id))))) {
      accepted.rejectedClients.add(client);
      accepted.rejectedGraphs.add(scan.graph);
      continue;
    }
    // A partial alias scan may suspend existing authority; it does not create
    // a source-managed client when no complete snapshot has ever been seen.
    if (!scan.replacementAuthority && scan.reason === 'partial-client-scope' && !archive.sourceSnapshots?.[client]
      && !Object.keys(archive.sourceSnapshots || {}).some(raw => sourceProjectionClient(raw) === sourceProjectionClient(client))) continue;
    archive.sourceSnapshots ||= {};
    const { sessions, aggregateDays: _aggregateDays, fallbackDays, graph: _graph, ...metadata } = scan;
    archive.sourceSnapshots[client] = { ...metadata,
      ...(!scan.replacementAuthority ? { fallbackDays: fallbackDays || {} } : {}) };
    accepted.set(client, scan);
    archive.unresolvedDays ||= {};
    const family = new Set([sourceProjectionClient(client)]);
    removeSourceClients(archive.days, family, archive.unresolvedDays);
    removeSourceClients(archive.liveDays, family, archive.unresolvedDays);
    if (!scan.replacementAuthority && !scan.projectIdentified) {
      continue;
    }
    archive.sourceSessions ||= {};
    for (const [key, entry] of sessions) {
      const sourcePath = ownedSessionSourcePath(options.sourcePaths?.[key]) || archive.sourceSessions[key]?.sourcePath;
      archive.sourceSessions[key] = { ...entry, sourceObservedAt: entry.capturedAt, ...(sourcePath ? { sourcePath } : {}) };
    }
    for (const [key, entry] of Object.entries(archive.sourceSessions)) {
      if (entry.client !== client || sessions.has(key)) continue;
      const sourcePath = ownedSessionSourcePath(options.sourcePaths?.[key]) || entry.sourcePath;
      const classified = classifySessionSourcePath(sourcePath, options.sourceStateDeps);
      entry.sourceState = classified === 'missing' ? 'missing' : 'unknown';
      entry.sourceObservedAt = scan.capturedAt;
      if (sourcePath) entry.sourcePath = sourcePath;
    }
  }
  // The digest includes the fork's dedup family, which can span clients.
  // Remove only contributions whose newer owner was present in this scan.
  const owners = new Map();
  const observed = new Set();
  for (const scan of accepted.values()) {
    if (!scan.replacementAuthority && !scan.projectIdentified) continue;
    for (const [key, entry] of scan.sessions) {
      observed.add(key);
      for (const event of entry.events) {
        if (event.id === null) continue;
        const identity = eventOwnershipKey(entry.client, event.id);
        owners.set(identity, Math.max(owners.get(identity) || 0, Date.parse(entry.capturedAt)));
      }
    }
  }
  for (const [key, entry] of Object.entries(archive.sourceSessions || {})) {
    if (observed.has(key)) continue;
    // This scan may already have stamped an omitted source observation. Its
    // usage timestamp still names the event contributions being replaced.
    const frontier = accepted.has(entry.client) ? Date.parse(entry.capturedAt) : newestSourceObservation(entry);
    const retained = entry.events.filter(event => event.id === null || (owners.get(eventOwnershipKey(entry.client, event.id)) ?? -Infinity) < frontier);
    if (retained.length !== entry.events.length) {
      const observedAt = Math.max(...entry.events.filter(event => owners.has(eventOwnershipKey(entry.client, event.id)))
        .map(event => owners.get(eventOwnershipKey(entry.client, event.id))));
      entry.events = retained;
      entry.days = daysFromEvents(retained);
      const classified = classifySessionSourcePath(entry.sourcePath, options.sourceStateDeps);
      entry.sourceState = classified === 'missing' ? 'missing' : 'unknown';
      if (newestSourceObservation(entry) < observedAt) entry.sourceObservedAt = new Date(observedAt).toISOString();
    }
  }
  suspendUnresolvedEventUnions(archive);
  if (archive.sourceSnapshots) archive.sourceClients = Object.entries(archive.sourceSnapshots)
    .filter(([, scan]) => scan.replacementAuthority).map(([client]) => client).sort();
  return accepted;
}

function graphsArray(graphs) {
  return (Array.isArray(graphs) ? graphs : [graphs]).filter((graph) => graph && typeof graph === 'object');
}

// A day that was first observed while two clients shared one row keeps that
// merged identity: the archived row already contains both products' usage, so
// replaying a post-split scan of the same day as two rows would count the split
// client twice. Folding is decided by the day's own provenance rather than by
// its current contents, because "holds the merged id and not the split id" is a
// legal post-split state: a day whose first scan sees only Pi looks exactly like
// a merged-era day, and folding it would permanently absorb Oh My Pi into Pi for
// every later scan of that day. A day with no generation marker predates the
// split and is the only kind that may be folded; a day this version wrote carries
// the current generation and is taken at face value.
function foldClientForDate(client, date, options = {}) {
  if (!client) return client;
  const day = options.archive?.days?.[date];
  if (!day || !isPreSplitEntry(day)) return client;
  for (const { merged, split } of CLIENT_IDENTITY_SPLITS) {
    if (client !== split) continue;
    return merged;
  }
  return client;
}

function observationsFromGraphs(graphs, options = {}) {
  const days = new Map();
  for (const graph of graphsArray(graphs)) {
    for (const row of (Array.isArray(graph.contributions) ? graph.contributions : [])) {
      const date = String(row?.date || '').slice(0, 10);
      if (!DAY_KEY_RE.test(date)) continue;
      const day = days.get(date) || { date, activeTimeMs: 0, observations: {} };
      if (!options.rejectedGraphs?.has(graph)) day.activeTimeMs += Math.max(0, Math.round(num(row.activeTimeMs ?? row.active_time_ms)));
      for (const raw of (Array.isArray(row?.clients) ? row.clients : [])) {
        const canonicalClient = sourceProjectionClient(raw?.client);
        const client = (options.sourceIdentity ? sourceClient(raw?.client) : foldClientForDate(canonicalClient, date, options)) || 'unknown';
        const candidate = normalizeObservation({
          ...raw,
          client,
          tokens: sumTokens(raw?.tokens, canonicalClient),
          reasoningTokens: raw?.tokens?.reasoning,
          tokenComponentsAvailable: raw?.tokenComponentsAvailable !== false,
          cacheReadTokens: raw?.tokens?.cacheRead ?? raw?.tokens?.cache_read,
          cacheWriteTokens: raw?.tokens?.cacheWrite ?? raw?.tokens?.cache_write,
          outputTokens: sumOutputTokens(raw?.tokens, canonicalClient)
        }, options.sourceIdentity);
        if (!candidate) continue;
        const key = options.sourceIdentity ? sourceObservationKey(candidate) : observationKey(candidate);
        day.observations[key] = addObservation(day.observations[key], candidate);
      }
      days.set(date, day);
    }
  }
  return days;
}

function shouldReplaceObservation(previous, incoming) {
  if (!previous) return true;
  if (incoming.tokens !== previous.tokens) return incoming.tokens > previous.tokens;
  if (incoming.messages !== previous.messages) return incoming.messages > previous.messages;
  // Equal usage can legitimately receive corrected pricing or richer metadata.
  // Replace the whole observation so token and cost values always share a source.
  return true;
}

function captureDailyHistoryArchive(existingArchive, graphs, options = {}) {
  const archive = normalizeDailyHistoryArchive(existingArchive);
  const sourceScans = captureSourceDailyHistory(archive, graphs, options);
  const reprice = options.reprice === true;
  if (typeof options.pricingRevision === 'string') {
    // Stamp each retained observation before adopting the new revision. A
    // source absent from this scan must still be repriced when it reappears.
    const previousRevision = archive.pricingRevision ?? 'legacy';
    for (const day of Object.values(archive.liveDays || {})) {
      for (const observation of Object.values(day.observations)) {
        observation.pricingRevision ??= previousRevision;
      }
    }
  }
  const todayKey = String(options.todayKey || '').slice(0, 10);
  const hasTodayKey = DAY_KEY_RE.test(todayKey);
  const incomingDays = observationsFromGraphs(graphs, { sourceIdentity: true, rejectedGraphs: sourceScans.rejectedGraphs });
  const managedClients = new Set(Object.keys(archive.sourceSnapshots || {}));
  const managedFamilies = new Set([...managedClients].map(sourceProjectionClient));
  for (const [date, day] of incomingDays) {
    for (const [key, observation] of Object.entries(day.observations)) {
      if (managedClients.has(observation.client) || sourceScans.rejectedClients.has(observation.client)
        || (observation.client === sourceProjectionClient(observation.client) && managedFamilies.has(observation.client))) delete day.observations[key];
      else observation.client = foldClientForDate(sourceProjectionClient(observation.client), date, { archive });
    }
    const normalized = normalizeDay(day, date);
    if (normalized) incomingDays.set(date, normalized);
    if (!Object.keys(day.observations).length && day.activeTimeMs <= 0) incomingDays.delete(date);
  }

  // A failed/empty graph did not confirm any current prices. Keep the old
  // revision so a later successful scan still reconciles retained live costs.
  if ((incomingDays.size > 0 || [...sourceScans.values()].some(scan => scan.replacementAuthority))
    && typeof options.pricingRevision === 'string') archive.pricingRevision = options.pricingRevision;
  const timingGraphs = graphsArray(graphs).filter(graph => !sourceScans.rejectedGraphs.has(graph));
  const timeMetrics = graphTimeMetrics(timingGraphs, 0);
  if (timeMetrics && (sourceScans.size > 0 || !timingGraphs.some(graph => graph.sourceUsage))) archive.timeMetrics = timeMetrics;

  for (const [date, incoming] of incomingDays) {
    if (hasTodayKey && date > todayKey) continue;
    const existing = archive.days[date] || null;
    const previous = existing || { date, activeTimeMs: 0, observations: {} };
    // A day already stored without a marker predates the split, so it keeps that
    // status: its observations genuinely span both products and must keep folding.
    // Anything else is written at the current generation, which is what stops a
    // post-split day from being absorbed into the merged id when Pi happens to be
    // scanned first.
    const legacy = existing !== null && isPreSplitEntry(existing);
    const next = {
      date,
      activeTimeMs: Math.max(previous.activeTimeMs, incoming.activeTimeMs),
      ...(legacy ? {} : { clientIdentityGeneration: CLIENT_IDENTITY_GENERATION }),
      observations: { ...previous.observations }
    };
    for (const [key, observation] of Object.entries(incoming.observations)) {
      if (shouldReplaceObservation(previous.observations[key], observation)) {
        next.observations[key] = observation;
      }
    }
    const normalized = normalizeDay(next, date);
    if (normalized) archive.days[date] = normalized;
    // When the collector rescans with current pricing, matching source usage
    // owns its price (including explicit zero). Keep archive-only usage and
    // richer live metadata, but do not let an older live cost undo repricing.
    const liveDay = archive.liveDays?.[date];
    if (liveDay && (reprice || typeof options.pricingRevision === 'string')) {
      archive.liveDays[date] = withReconciledGraphCosts(liveDay, incoming, liveDay, reprice, options.pricingRevision);
    }
  }

  // Presentation and sync windows are intentionally applied later by
  // normalizeHistory(). The local archive keeps every observed past day so a
  // future year selector can read it without depending on source transcripts.
  if (hasTodayKey) {
    for (const date of Object.keys(archive.days)) {
      if (date > todayKey) delete archive.days[date];
    }
  }
  return archive;
}

function periodLiveDay(period, date) {
  if (!period || typeof period !== 'object' || !DAY_KEY_RE.test(date)) return null;
  const observations = new Map();
  const addObservation = (client, modelId, tokens, cost) => {
    const observation = {
      client,
      modelId,
      tokens: Math.max(0, Math.round(num(tokens))),
      cost: Math.max(0, num(cost)),
      messages: 0
    };
    const key = observationKey(observation);
    const previous = observations.get(key);
    if (!previous) {
      observations.set(key, observation);
      return;
    }
    previous.tokens += observation.tokens;
    previous.cost += observation.cost;
  };
  const clientModels = period.clientModels && typeof period.clientModels === 'object'
    ? period.clientModels
    : {};
  const clientModelCosts = period.clientModelCosts && typeof period.clientModelCosts === 'object'
    ? period.clientModelCosts
    : {};
  const clients = period.clients && typeof period.clients === 'object' ? period.clients : {};
  const clientCosts = period.clientCosts && typeof period.clientCosts === 'object' ? period.clientCosts : {};
  const clientIds = new Set([...Object.keys(clientModels), ...Object.keys(clients), ...Object.keys(clientCosts)]);

  for (const client of clientIds) {
    const models = clientModels[client] && typeof clientModels[client] === 'object'
      ? clientModels[client]
      : {};
    const modelIds = Object.keys(models);
    let modeledTokens = 0;
    let modeledCost = 0;
    for (const modelId of modelIds) {
      const modelTokens = Math.max(0, Math.round(num(models[modelId])));
      const modelCost = Math.max(0, num(clientModelCosts[client]?.[modelId]));
      addObservation(client, modelId, modelTokens, modelCost);
      modeledTokens += modelTokens;
      modeledCost += modelCost;
    }
    const clientTokens = Math.max(0, Math.round(num(clients[client])));
    const clientCost = Math.max(0, num(clientCosts[client]));
    const remainderTokens = Math.max(0, clientTokens - modeledTokens);
    const remainderCost = Math.max(0, clientCost - modeledCost);
    if (modelIds.length === 0 || remainderTokens > 0 || remainderCost > 0) {
      addObservation(client, 'unknown', remainderTokens, remainderCost);
    }
  }

  const totalTokens = Math.max(0, Math.round(num(period.totalTokens)));
  const totalCost = Math.max(0, num(period.costUsd));
  const observed = [...observations.values()];
  const observedTokens = observed.reduce((sum, observation) => sum + observation.tokens, 0);
  const observedCost = observed.reduce((sum, observation) => sum + observation.cost, 0);
  if (totalTokens > observedTokens || totalCost > observedCost) {
    addObservation(
      'unknown',
      'unknown',
      Math.max(0, totalTokens - observedTokens),
      Math.max(0, totalCost - observedCost)
    );
  }

  const hasKnownComponents = num(period.cacheReadTokens)
    + num(period.cacheWriteTokens)
    + num(period.outputTokens) > 0;
  const componentSummary = totalTokens > 0
    && (period.capabilities?.tokenComponents === true || hasKnownComponents)
    ? {
        tokenComponentsAvailable: period.capabilities?.tokenComponents === true,
        cacheReadTokens: num(period.cacheReadTokens),
        cacheWriteTokens: num(period.cacheWriteTokens),
        outputTokens: num(period.outputTokens),
        unclassifiedTokens: num(period.unclassifiedTokens),
        perClient: Object.fromEntries([...clientIds].map((client) => [client, {
          cacheReadTokens: num(period.clientCacheReads?.[client]),
          cacheWriteTokens: num(period.clientCacheWrites?.[client]),
          outputTokens: num(period.clientOutputs?.[client]),
          unclassifiedTokens: num(period.clientUnclassifiedTokens?.[client])
        }])),
        perModel: Object.fromEntries(Object.keys(period.models || {}).map((model) => [model, {
          cacheReadTokens: num(period.modelCacheReads?.[model]),
          cacheWriteTokens: num(period.modelCacheWrites?.[model]),
          outputTokens: num(period.modelOutputs?.[model]),
          unclassifiedTokens: num(period.modelUnclassifiedTokens?.[model])
        }]))
      }
    : null;
  const day = normalizeDay({
    date,
    activeTimeMs: 0,
    observations: [...observations.values()],
    ...(componentSummary ? { componentSummary } : {})
  }, date);
  return day && Object.keys(day.observations).length > 0 ? day : null;
}

function dayTokens(day) {
  return Object.values(day?.observations || {}).reduce((sum, observation) => sum + num(observation.tokens), 0);
}

function dayCost(day) {
  return Object.values(day?.observations || {}).reduce((sum, observation) => sum + num(observation.cost), 0);
}

function dayComponentQuality(day) {
  if (day?.componentSummary?.tokenComponentsAvailable === true) return 2;
  if (day?.componentSummary) return 1;
  const usage = Object.values(day?.observations || {}).filter((observation) => num(observation.tokens) > 0);
  if (usage.length === 0 || usage.every((observation) => observation.tokenComponentsAvailable === true)) return 2;
  return usage.some((observation) => (
    num(observation.cacheReadTokens) > 0
    || num(observation.cacheWriteTokens) > 0
    || num(observation.outputTokens) > 0
  )) ? 1 : 0;
}

function liveDayIsGreater(incoming, previous) {
  const incomingTokens = dayTokens(incoming);
  const previousTokens = dayTokens(previous);
  if (incomingTokens !== previousTokens) return incomingTokens > previousTokens;
  const qualityDifference = dayComponentQuality(incoming) - dayComponentQuality(previous);
  if (qualityDifference !== 0) return qualityDifference > 0;
  // Equal usage can receive a corrected price in either direction. The later
  // live observation is authoritative once its provenance quality is equal.
  return dayCost(incoming) !== dayCost(previous);
}

// A changed pricing revision makes matching graph usage authoritative, even
// when its new cost is zero. Otherwise preserve live prices, with Cursor's
// existing positive-graph-price preference and live fallback for missing cost.
function withReconciledGraphCosts(day, graphDay, liveDay, reprice = false, pricingRevision) {
  let changed = false;
  const observations = Object.fromEntries(Object.entries(day.observations).map(([key, observation]) => {
    const graphObservation = graphDay.observations[key];
    const liveObservation = liveDay.observations[key];
    const revisionChanged = typeof pricingRevision === 'string'
      && liveObservation?.pricingRevision !== pricingRevision;
    const useGraphPrice = reprice || revisionChanged;
    const isCursor = normalizeTokscaleClientName(observation.client) === 'cursor';
    if ((!useGraphPrice && typeof pricingRevision !== 'string' && !isCursor)
      || !graphObservation
      || !liveObservation
      || num(graphObservation.tokens) !== num(liveObservation.tokens)) {
      return [key, observation];
    }
    const cost = useGraphPrice || (isCursor && num(graphObservation.cost) > 0)
      ? graphObservation.cost : liveObservation.cost;
    if (num(cost) === num(observation.cost)
      && (typeof pricingRevision !== 'string' || observation.pricingRevision === pricingRevision)) return [key, observation];
    changed = true;
    return [key, {
      ...observation, cost,
      ...(typeof pricingRevision === 'string' ? { pricingRevision } : {})
    }];
  }));
  return changed ? { ...day, observations } : day;
}

function mergeLiveDayMetadata(liveDay, previousDay) {
  if (!previousDay) return liveDay;
  const observations = Object.fromEntries(Object.entries(liveDay.observations).map(([key, observation]) => {
    const previous = previousDay.observations[key];
    if (!previous) return [key, observation];
    if (liveDay.componentSummary) {
      return [key, {
        ...observation,
        messages: Math.max(observation.messages, previous.messages),
        ...(Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) > 0
          ? { reasoningTokens: Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) }
          : {})
      }];
    }
    const incomingTokens = num(observation.tokens);
    const previousTokens = num(previous.tokens);
    const canRetainPreviousComponents = incomingTokens >= previousTokens;
    const previousUnclassified = Math.min(previousTokens, num(previous.unclassifiedTokens));
    const unclassifiedTokens = canRetainPreviousComponents
      ? previousUnclassified + (incomingTokens - previousTokens)
      : incomingTokens;
    return [key, {
      ...observation,
      messages: Math.max(observation.messages, previous.messages),
      ...(canRetainPreviousComponents && previousTokens - previousUnclassified > 0 ? {
        cacheReadTokens: num(previous.cacheReadTokens),
        cacheWriteTokens: num(previous.cacheWriteTokens),
        outputTokens: num(previous.outputTokens)
      } : {}),
      unclassifiedTokens,
      tokenComponentsAvailable: unclassifiedTokens === 0,
      ...(Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) > 0
        ? { reasoningTokens: Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) }
        : {})
    }];
  }));
  return {
    ...liveDay,
    activeTimeMs: Math.max(liveDay.activeTimeMs, previousDay.activeTimeMs),
    observations
  };
}

function captureLiveDailyHistory(existingArchive, period, options = {}) {
  const archive = normalizeDailyHistoryArchive(existingArchive);
  const date = String(options.todayKey || '').slice(0, 10);
  if (DAY_KEY_RE.test(date) && archive.liveDays) {
    for (const liveDate of Object.keys(archive.liveDays)) {
      if (liveDate > date) delete archive.liveDays[liveDate];
    }
  }
  const incoming = periodLiveDay(period, date);
  if (!incoming) return archive;
  const sourceFamilies = new Set((archive.sourceClients || []).map(sourceProjectionClient));
  const unresolvedFamilies = new Set(Object.entries(archive.sourceSnapshots || {})
    .filter(([, scan]) => !scan.replacementAuthority).map(([client]) => sourceProjectionClient(client)));
  const unresolved = {};
  for (const [key, observation] of Object.entries(incoming.observations)) {
    if (sourceFamilies.has(observation.client)) delete incoming.observations[key];
    else if (unresolvedFamilies.has(observation.client)) {
      unresolved[key] = observation;
      delete incoming.observations[key];
    }
  }
  if (Object.keys(unresolved).length) {
    archive.unresolvedDays ||= {};
    const previous = archive.unresolvedDays[date];
    const next = normalizeDay({ date, activeTimeMs: 0, observations: unresolved }, date, true);
    if (next) {
      const observations = { ...previous?.observations };
      for (const client of new Set(Object.values(unresolved).map(row => row.client))) {
        const select = day => normalizeDay({ date, observations: Object.values(day?.observations || {}).filter(row => row.client === client) }, date, true);
        const incomingClient = select(next);
        const previousClient = select(previous);
        if (!incomingClient || (previousClient && !liveDayIsGreater(incomingClient, previousClient))) continue;
        for (const [key, row] of Object.entries(observations)) if (row.client === client) delete observations[key];
        Object.assign(observations, incomingClient.observations);
      }
      archive.unresolvedDays[date] = { ...next, activeTimeMs: previous?.activeTimeMs || 0, observations };
      for (const [rawClient, snapshot] of Object.entries(archive.sourceSnapshots || {})) {
        if (!unresolvedFamilies.has(sourceProjectionClient(rawClient)) || snapshot.replacementAuthority) continue;
        if (Object.keys(archive.sourceSnapshots).filter(client => sourceProjectionClient(client) === sourceProjectionClient(rawClient)).length !== 1) continue;
        const rows = Object.values(archive.unresolvedDays[date].observations)
          .filter(row => row.client === sourceProjectionClient(rawClient)).map(row => ({ ...row, client: rawClient }));
        if (!rows.length) continue;
        let fallback = normalizeDay({ date, observations: rows }, date, true);
        if (snapshot.projectIdentified) {
          const present = Object.values(archive.sourceSessions || {}).filter(entry => entry.client === rawClient
            && entry.sourceState === 'present' && !snapshot.unresolvedSessionIds?.includes(entry.sessionId));
          const known = daysFromEvents(present)[date]?.observations || {};
          const knownDay = { observations: known };
          if (dayTokens(fallback) < dayTokens(knownDay)) continue;
          if (Object.entries(known).some(([key, row]) => num(fallback?.observations[key]?.tokens) < row.tokens)) {
            const tokens = dayTokens(fallback) - dayTokens(knownDay);
            fallback = normalizeDay({ date, observations: [{ client: rawClient, modelId: 'unknown', tokens,
              cost: Math.max(0, dayCost(fallback) - dayCost(knownDay)), messages: 0, unclassifiedTokens: tokens }] }, date, true);
          } else fallback = normalizeDay({ date, observations: Object.entries(fallback?.observations || {}).map(([key, row]) => ({
              ...row, tokens: row.tokens - num(known[key]?.tokens), cost: Math.max(0, row.cost - num(known[key]?.cost)),
              messages: 0, tokenComponentsAvailable: false, cacheReadTokens: 0, cacheWriteTokens: 0,
              outputTokens: 0, reasoningTokens: 0, unclassifiedTokens: row.tokens - num(known[key]?.tokens)
            })) }, date, true);
        }
        snapshot.fallbackDays = { ...(snapshot.fallbackDays || {}) };
        if (fallback) snapshot.fallbackDays[date] = fallback;
        else delete snapshot.fallbackDays[date];
      }
    }
  }
  if (!Object.keys(incoming.observations).length) return archive;
  if (archive.sourceClients?.length) delete incoming.componentSummary;
  if (typeof options.pricingRevision === 'string') {
    for (const observation of Object.values(incoming.observations)) {
      observation.pricingRevision = options.pricingRevision;
    }
  }
  const previous = archive.liveDays?.[date];
  const equalUsage = previous && dayTokens(incoming) === dayTokens(previous);
  // Revision provenance comes from the retained rows, not a missing model key.
  // Equal totals can also be reattributed by a parser correction independently
  // of pricing. Keep the incoming identities and merge only matching metadata.
  const revisionChanged = equalUsage && typeof options.pricingRevision === 'string'
    && Object.values(previous.observations).some(observation => (
      observation.pricingRevision !== options.pricingRevision
    ));
  const attributionChanged = equalUsage && (
    Object.keys(incoming.observations).length !== Object.keys(previous.observations).length
    || Object.entries(incoming.observations).some(([key, observation]) => (
      observation.tokens !== previous.observations[key]?.tokens
    ))
  );
  if (!previous || liveDayIsGreater(incoming, previous) || revisionChanged || attributionChanged) {
    let selected = incoming;
    if (equalUsage && dayComponentQuality(incoming) < dayComponentQuality(previous)) {
      selected = mergeLiveDayMetadata(incoming, previous);
      // A whole-day component summary is reusable only for identical attribution.
      if (!attributionChanged && previous.componentSummary) {
        selected.componentSummary = previous.componentSummary;
      }
    }
    archive.liveDays = { ...(archive.liveDays || {}), [date]: selected };
  }
  return archive;
}

function graphTimeMetrics(graphs, activeTimeMs) {
  const source = graphsArray(graphs)
    .map((graph) => graph.timeMetrics ?? graph.time_metrics)
    .find((value) => value && typeof value === 'object');
  if (!source) return null;
  return {
    ...source,
    totalActiveTimeMs: Math.max(
      num(source.totalActiveTimeMs ?? source.total_active_time_ms),
      activeTimeMs
    )
  };
}

function dayContribution(day) {
  return {
    date: day.date,
    activeTimeMs: day.activeTimeMs,
    ...(day.componentSummary ? { tokenComponentSummary: day.componentSummary } : {}),
    clients: Object.values(day.observations || {}).map(observation => ({
      client: observation.client, modelId: observation.modelId,
      ...(observation.providerId ? { providerId: observation.providerId } : {}),
      tokens: {
        input: Math.max(0, observation.tokens - num(observation.outputTokens)
          - num(observation.cacheReadTokens) - num(observation.cacheWriteTokens)),
        output: num(observation.outputTokens), cacheRead: num(observation.cacheReadTokens),
        cacheWrite: num(observation.cacheWriteTokens), reasoning: 0
      },
      tokenComponentsAvailable: observation.tokenComponentsAvailable === true,
      ...(num(observation.unclassifiedTokens) > 0 ? { unclassifiedTokens: num(observation.unclassifiedTokens) } : {}),
      cost: observation.cost, messages: observation.messages
    }))
  };
}

function graphFromDailyHistoryArchive(graphs, archive, options = {}) {
  const normalizedArchive = graphsArray(graphs).length
    ? captureDailyHistoryArchive(archive, graphs, options) : normalizeDailyHistoryArchive(archive);
  const currentDays = new Map();
  const todayKey = String(options.todayKey || '').slice(0, 10);
  const hasTodayKey = DAY_KEY_RE.test(todayKey);

  for (const [date, day] of Object.entries(normalizedArchive.days)) {
    if (hasTodayKey && date > todayKey) continue;
    currentDays.set(date, day);
  }
  for (const [date, liveDay] of Object.entries(normalizedArchive.liveDays || {})) {
    if (hasTodayKey && date > todayKey) continue;
    const previous = currentDays.get(date);
    if (!previous) {
      currentDays.set(date, liveDay);
    } else {
      const selected = liveDayIsGreater(liveDay, previous) ? mergeLiveDayMetadata(liveDay, previous) : previous;
      currentDays.set(date, withReconciledGraphCosts(selected, previous, liveDay, options.reprice === true));
    }
  }

  const clients = new Set(normalizedArchive.sourceClients || []);
  const unresolvedClients = new Set(Object.entries(normalizedArchive.sourceSnapshots || {})
    .filter(([, scan]) => !scan.replacementAuthority).map(([client]) => client));
  const projected = Object.fromEntries(currentDays);
  removeSourceClients(projected, new Set([...clients, ...unresolvedClients].map(sourceProjectionClient)));
  currentDays.clear();
  for (const [date, day] of Object.entries(projected)) currentDays.set(date, day);
  for (const [date, unresolvedDay] of Object.entries(normalizedArchive.unresolvedDays || {})) {
    if (hasTodayKey && date > todayKey) continue;
    const rows = Object.entries(unresolvedDay.observations).filter(([, observation]) =>
      unresolvedClients.has(observation.client) && !normalizedArchive.sourceSnapshots[observation.client].fallbackDays);
    if (!rows.length) continue;
    const day = currentDays.get(date) || { date, activeTimeMs: 0, observations: {} };
    day.activeTimeMs = Math.max(day.activeTimeMs, unresolvedDay.activeTimeMs);
    for (const [key, observation] of rows) day.observations[key] = observation;
    delete day.componentSummary;
    currentDays.set(date, day);
  }
  for (const snapshot of Object.values(normalizedArchive.sourceSnapshots || {})) {
    if (snapshot.replacementAuthority) continue;
    for (const [date, fallbackDay] of Object.entries(snapshot.fallbackDays || {})) {
      if (hasTodayKey && date > todayKey) continue;
      const day = currentDays.get(date) || { date, activeTimeMs: 0, observations: {} };
      for (const observation of Object.values(fallbackDay.observations)) {
        const canonical = normalizeObservation(observation);
        const key = observationKey(canonical);
        day.observations[key] = addObservation(day.observations[key], canonical);
      }
      delete day.componentSummary;
      currentDays.set(date, day);
    }
  }
  for (const entry of Object.values(normalizedArchive.sourceSessions || {})) {
    if (!clients.has(entry.client) && !normalizedArchive.sourceSnapshots?.[entry.client]?.projectIdentified) continue;
    if (normalizedArchive.sourceSnapshots?.[entry.client]?.unresolvedSessionIds?.includes(entry.sessionId)) continue;
    for (const [date, sourceDay] of Object.entries(entry.days)) {
      if (hasTodayKey && date > todayKey) continue;
      const day = currentDays.get(date) || { date, activeTimeMs: 0, observations: {} };
      for (const observation of Object.values(sourceDay.observations)) {
        const canonical = normalizeObservation(observation);
        const key = observationKey(canonical);
        day.observations[key] = addObservation(day.observations[key], canonical);
      }
      delete day.componentSummary;
      currentDays.set(date, day);
    }
  }

  const contributions = [...currentDays.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map(day => dayContribution({ ...day, observations: Object.values(day.observations)
      .sort((left, right) => sourceObservationKey(left).localeCompare(sourceObservationKey(right))) }));
  const activeTimeMs = contributions.reduce((sum, day) => sum + num(day.activeTimeMs), 0);
  const timeMetrics = graphTimeMetrics([normalizedArchive], activeTimeMs);
  return { contributions, ...(timeMetrics ? { timeMetrics } : {}),
    ...(normalizedArchive.sourceSnapshots ? { sourceUsage: {
      version: 1, fullHistory: false, clients: [...clients], replacementClients: [...clients],
      sourceSnapshots: normalizedArchive.sourceSnapshots,
      unresolvedClients: [...unresolvedClients],
      unresolvedSessions: Object.values(normalizedArchive.sourceSessions || {})
        .filter(entry => entry.unresolvedDays && Object.keys(entry.unresolvedDays).length)
        .map(entry => ({ client: entry.client, sessionId: entry.sessionId,
          sourceState: entry.sourceState, capturedAt: entry.capturedAt,
          bucketTimezone: entry.bucketTimezone, dayKey: entry.dayKey,
          days: Object.values(entry.unresolvedDays).map(dayContribution) })),
      // Partial identity evidence can retain an omitted ID without replacing
      // its native client. Keep that permission distinct from whole-client
      // replacement authority. Null groups use the separate unresolved lane.
      sessions: Object.values(normalizedArchive.sourceSessions || {}).filter(entry =>
        (clients.has(entry.client) || normalizedArchive.sourceSnapshots?.[entry.client]?.projectIdentified === true)
        && !normalizedArchive.sourceSnapshots?.[entry.client]?.unresolvedSessionIds?.includes(entry.sessionId))
        .map(({ client, sessionId, days, sourceState, capturedAt, bucketTimezone, dayKey, eventIdentityVersion, sourceObservedAt, events }) => ({
          client, sessionId, sourceState, capturedAt, bucketTimezone, dayKey, eventIdentityVersion, sourceObservedAt,
          days: Object.values(clients.has(client) ? days : daysFromEvents(events.filter(event => event.id !== null))).map(dayContribution),
          events: events.filter(event => event.id !== null)
            .map(event => ({ id: event.id, days: Object.values(event.days).map(dayContribution) }))
        }))
    } } : {}) };
}

function dailyHistoryArchivePath(options = {}) {
  return options.path || path.join(sharedDataDir(options), 'daily-history-archive.json');
}

function validateDailyHistoryArchiveDocument(value, filePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Could not parse JSON in ${filePath}: archive root must be an object`);
  }
  for (const key of ['days', 'liveDays', 'sourceSessions', 'sourceSnapshots', 'unresolvedDays']) {
    if (Object.prototype.hasOwnProperty.call(value, key)
      && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) {
      throw new Error(`Could not parse JSON in ${filePath}: ${key} must be an object`);
    }
  }
  return value;
}

function readDailyHistoryArchive(options = {}) {
  const filePath = dailyHistoryArchivePath(options);
  if (typeof options.readJson === 'function') {
    return normalizeDailyHistoryArchive(
      validateDailyHistoryArchiveDocument(options.readJson(filePath, {}), filePath)
    );
  }
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return normalizeDailyHistoryArchive({});
    throw error;
  }
  if (!content.trim()) {
    throw new Error(`Could not parse JSON in ${filePath}: archive is empty`);
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const parseError = new Error(`Could not parse JSON in ${filePath}: ${error.message}`);
    parseError.cause = error;
    throw parseError;
  }
  return normalizeDailyHistoryArchive(validateDailyHistoryArchiveDocument(parsed, filePath));
}

function writeDailyHistoryArchive(archive, options = {}) {
  const write = options.writeJsonAtomic || writeJsonAtomic;
  write(dailyHistoryArchivePath(options), normalizeDailyHistoryArchive(archive));
}

function clearDailyHistoryArchive(options = {}) {
  const unlink = options.unlinkSync || fs.unlinkSync;
  try {
    unlink(dailyHistoryArchivePath(options));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function mergeLiveDaysIntoArchive(existingArchive, liveDays) {
  const archive = normalizeDailyHistoryArchive(existingArchive);
  const incoming = normalizeDailyHistoryArchive({ liveDays }).liveDays || {};
  removeSourceClients(incoming, new Set((archive.sourceClients || []).map(sourceProjectionClient)));
  for (const [date, liveDay] of Object.entries(incoming)) {
    const previous = archive.liveDays?.[date];
    if (!previous || liveDayIsGreater(liveDay, previous)) {
      archive.liveDays = { ...(archive.liveDays || {}), [date]: liveDay };
    }
  }
  return archive;
}

function archiveWriteEnabled(options = {}) {
  return typeof options.writeEnabled === 'function'
    ? options.writeEnabled() !== false
    : options.writeEnabled !== false;
}

function retainDailyHistory(graphs, options = {}) {
  const previous = readDailyHistoryArchive(options);
  const capture = (archive) => captureDailyHistoryArchive(
    mergeLiveDaysIntoArchive(archive, options.liveDays),
    graphs,
    options
  );
  let next = capture(previous);
  // Ownership can change while a graph scan is running (for example, a
  // headless agent starts after Electron's collector tick begins). Resolve a
  // lazy guard immediately before the write instead of freezing it at startup.
  if (archiveWriteEnabled(options) && !isDeepStrictEqual(previous, next)) {
    // The graph scan can take long enough for the other collector to update the
    // shared archive. Rebase on the latest file immediately before writing so
    // this scan cannot put that newer observation back on disk.
    const latest = readDailyHistoryArchive(options);
    next = capture(latest);
    if (archiveWriteEnabled(options) && !isDeepStrictEqual(latest, next)) {
      writeDailyHistoryArchive(next, options);
    }
  }
  return graphFromDailyHistoryArchive(graphs, next, options);
}

function retainLiveDailyHistory(period, options = {}) {
  const previous = readDailyHistoryArchive(options);
  const capture = (archive) => captureLiveDailyHistory(
    mergeLiveDaysIntoArchive(archive, options.liveDays),
    period,
    options
  );
  let next = capture(previous);
  if (archiveWriteEnabled(options) && !isDeepStrictEqual(previous, next)) {
    const latest = readDailyHistoryArchive(options);
    next = capture(latest);
    if (archiveWriteEnabled(options) && !isDeepStrictEqual(latest, next)) {
      writeDailyHistoryArchive(next, options);
    }
  }
  return next;
}

module.exports = {
  sourceSnapshotsFromGraphs,
  captureDailyHistoryArchive,
  clearDailyHistoryArchive,
  dailyHistoryArchivePath,
  graphFromDailyHistoryArchive,
  captureLiveDailyHistory,
  normalizeDailyHistoryArchive,
  observationKey,
  readDailyHistoryArchive,
  retainDailyHistory,
  retainLiveDailyHistory,
  shouldReplaceObservation,
  writeDailyHistoryArchive
};
