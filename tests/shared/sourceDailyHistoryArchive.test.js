'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { captureDailyHistoryArchive, graphFromDailyHistoryArchive, captureLiveDailyHistory, normalizeDailyHistoryArchive, sourceSnapshotsFromGraphs, retainDailyHistory, readDailyHistoryArchive, writeDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { parseGraphResult, normalizeHistory } = require('../../src/shared/history');
const { applySourceDailyUsage } = require('../../src/shared/usage/sourceDailyUsage');
const { emptyPeriod, extractUsageFromTokscale } = require('../../src/shared/usage');
const day = (date, tokens, model = 'opus', cost = tokens / 100) => ({ date, clients: [{ client: 'claude', modelId: model, tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }, cost, messages: 1 }] });
const graph = (sessions, capturedAt = '2026-10-11T12:00:00Z', extra = {}) => ({
  contributions: sessions.flatMap(row => row.days),
  sourceUsage: { version: 1, eventIdentityVersion: 1, capturedAt, fullHistory: true,
    replacementClients: ['claude'], partialClients: [], bucketTimezone: 'Asia/Hong_Kong', dayKey: '2026-10-11', sessions, ...extra }
});
const digest = id => `sha256:${createHash('sha256').update(id).digest('hex')}`;
const event = (id, days) => ({ id: digest(id), days });
const source = (sessionId, days, events = [event(sessionId, days)]) => ({ client: 'claude', sessionId, days, events });
const total = archive => normalizeHistory(parseGraphResult(graphFromDailyHistoryArchive([], archive))).summary.totalTokens;

test('whole identity correction removes old days/models and accepts lower usage and zero prices', () => {
  let archive = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-10', 100), day('2026-10-11', 50)])]));
  archive = captureDailyHistoryArchive(archive, graph([source('a', [day('2026-10-11', 20, 'sonnet', 0)])], '2026-10-11T12:01:00Z'));
  assert.equal(total(archive), 20);
  assert.deepEqual(Object.keys(archive.sourceSessions['claude:a'].days), ['2026-10-11']);
  assert.equal(graphFromDailyHistoryArchive([], archive).contributions[0].clients[0].modelId, 'sonnet');
  assert.equal(graphFromDailyHistoryArchive([], archive).contributions[0].clients[0].cost, 0);
  archive = captureDailyHistoryArchive(archive, graph([source('a', [])], '2026-10-11T12:02:00Z'));
  assert.equal(total(archive), 0);
});

test('omitted and failed sources retain exact observations without declaring deletion', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-10', 100)]), source('b', [day('2026-10-11', 20)])]));
  const next = captureDailyHistoryArchive(first, graph([source('b', [day('2026-10-11', 5)])], '2026-10-11T12:01:00Z'));
  assert.equal(total(next), 105);
  assert.equal(next.sourceSessions['claude:a'].sourceState, 'unknown');
  assert.equal(total(captureDailyHistoryArchive(next, [])), 105);
});

test('stale source scans and date-filtered scans cannot undo a complete correction', () => {
  const newer = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 20)])], '2026-10-11T12:02:00Z'));
  const stale = captureDailyHistoryArchive(newer, graph([source('a', [day('2026-10-10', 100)])]));
  assert.equal(total(stale), 20);
  const partial = captureDailyHistoryArchive(stale, graph([source('a', [day('2026-10-10', 200)])], '2026-10-11T12:03:00Z', { fullHistory: false }));
  assert.equal(total(partial), 20);
});

test('old day/live aggregates remain recoverable but cannot floor exact source snapshots', () => {
  const old = { days: { '2026-10-11': { date: '2026-10-11', observations: [{ client: 'claude', modelId: 'opus', tokens: 1300, cost: 1 }] } } };
  const next = captureDailyHistoryArchive(old, graph([source('a', [day('2026-10-11', 1000)])]));
  assert.equal(total(next), 1000);
  assert.equal(Object.values(next.unresolvedDays['2026-10-11'].observations)[0].tokens, 1300);
  const live = extractUsageFromTokscale({ entries: [{ client: 'claude', sessionId: 'a', modelId: 'opus', input: 1500 }] });
  assert.equal(total(captureLiveDailyHistory(next, live, { todayKey: '2026-10-11' })), 1000);
  assert.equal(total(normalizeDailyHistoryArchive(next)), 1000);
});

test('clients containing identity-less usage preserve validated identified rows without claiming full authority', () => {
  const next = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 100)])], undefined, { rowsWithoutIdentity: { claude: 1 } }));
  assert.ok(next.sourceSessions['claude:a']);
  assert.equal(next.sourceSnapshots.claude.projectIdentified, true);
  assert.equal(total(next), 100);
});

test('retained source daily rows project exact allTime and do not restore a moved live Today', () => {
  const summary = { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod(), sessionArchiveSource: { presentKeys: ['claude:live'] } };
  const retained = { version: 1, clients: ['claude'], sessions: [
    { ...source('gone', [day('2026-10-10', 30)]), sourceState: 'unknown' },
    source('live', [day('2026-10-11', 100)])
  ].map(row => ({ ...row, bucketTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, dayKey: '2026-10-11' })) };
  applySourceDailyUsage(summary, retained, { todayKey: '2026-10-11', allTimeSince: '2026-01-01' });
  assert.equal(summary.today.totalTokens, 0);
  assert.equal(summary.allTime.totalTokens, 30);
  assert.equal(summary.allTime.sessions['claude:gone'].archived, undefined);
  assert.equal(summary.allTime.sessions['claude:gone'].sourceState, 'unknown');
  assert.deepEqual(summary.sessionArchiveSource.managedKeys, ['claude:gone', 'claude:live']);
});

function tempArchive(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-daily-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, options: { path: path.join(directory, 'archive.json') } };
}

function roundTrip(archive) {
  return normalizeDailyHistoryArchive(JSON.parse(JSON.stringify(archive)));
}

test('serialized native graph and disk archive retain exact source components, providers, time and metadata', t => {
  const { options } = tempArchive(t);
  const rows = [{ date: '2026-10-11', activeTimeMs: 12000, clients: [
    { client: 'claude', modelId: 'opus', providerId: 'anthropic', tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, cost: 0, messages: 2 },
    { client: 'claude', modelId: 'opus', providerId: 'proxy', tokens: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }, cost: 0.25, messages: 1 }
  ] }];
  const native = JSON.parse(JSON.stringify({ ...graph([source('a', rows)]), timeMetrics: { totalActiveTimeMs: 12000, longestContinuousMs: 12000, maxConcurrentSessions: 1, sessionCount: 1 } }));
  const visible = retainDailyHistory(native, options);
  const archive = readDailyHistoryArchive(options);
  const snapshot = archive.sourceSnapshots.claude;
  assert.deepEqual(snapshot, { capturedAt: '2026-10-11T12:00:00Z', eventIdentityVersion: 1,
    bucketTimezone: 'Asia/Hong_Kong', dayKey: '2026-10-11', replacementAuthority: true });
  assert.deepEqual(archive.sourceSessions['claude:a'].events[0].id, digest('a'));
  assert.deepEqual(visible.sourceUsage.sessions[0].days[0].clients.map(row => row.providerId), ['anthropic, proxy']);
  const restarted = graphFromDailyHistoryArchive([], archive);
  assert.equal(total(archive), 126);
  assert.equal(restarted.contributions[0].activeTimeMs, 12000);
  assert.deepEqual(restarted.timeMetrics, native.timeMetrics);
  const history = normalizeHistory(parseGraphResult(JSON.parse(JSON.stringify(restarted))));
  assert.equal(history.summary.totalCost, 0.25);
  const period = { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
  applySourceDailyUsage(period, JSON.parse(JSON.stringify(restarted.sourceUsage)), { todayKey: '2026-10-11', timeZone: 'Asia/Hong_Kong' });
  assert.equal(period.allTime.totalTokens, 126);
  assert.equal(period.allTime.outputTokens, 26);
  assert.equal(period.allTime.cacheReadTokens, 37);
  assert.equal(period.allTime.cacheWriteTokens, 48);
  assert.equal(period.allTime.costUsd, 0.25);
});

test('event ownership moving to a present ID removes the fully overlapped omitted snapshot', () => {
  const rows = [day('2026-10-10', 100)];
  let archive = roundTrip(captureDailyHistoryArchive({}, graph([source('old', rows, [event('shared', rows)])])));
  const corrected = [day('2026-10-11', 20, 'sonnet', 0)];
  archive = roundTrip(captureDailyHistoryArchive(archive, graph([source('new', corrected, [event('shared', corrected)])], '2026-10-11T12:01:00Z')));
  assert.equal(total(archive), 20);
  assert.deepEqual(archive.sourceSessions['claude:old'].days, {});
  assert.deepEqual(archive.sourceSessions['claude:old'].events, []);
  assert.equal(archive.sourceSessions['claude:old'].sourceState, 'unknown');
  assert.equal(archive.sourceSessions['claude:new'].sourceState, 'present');
});

test('partial event overlap keeps the omitted ID remainder with coherent model, components and cost', () => {
  const migrated = [day('2026-10-10', 100, 'opus', 2)];
  const remainder = [{ date: '2026-10-11', clients: [{ client: 'claude', modelId: 'sonnet', providerId: 'anthropic',
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, cost: 0.5, messages: 3 }] }];
  const old = source('old', [...migrated, ...remainder], [event('shared', migrated), event('kept', remainder)]);
  const fresh = [day('2026-10-11', 7, 'haiku', 0)];
  const first = roundTrip(captureDailyHistoryArchive({}, graph([old])));
  const next = roundTrip(captureDailyHistoryArchive(first, graph([source('new', fresh, [event('shared', fresh)])], '2026-10-11T12:01:00Z')));
  assert.equal(total(next), 107);
  const retained = Object.values(next.sourceSessions['claude:old'].days['2026-10-11'].observations)[0];
  assert.deepEqual(retained, { client: 'claude', modelId: 'sonnet', providerId: 'anthropic', tokens: 100,
    cost: 0.5, messages: 3, tokenComponentsAvailable: true, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
  assert.deepEqual(next.sourceSessions['claude:old'].events.map(row => row.id), [digest('kept')]);
  assert.equal(next.sourceSessions['claude:old'].capturedAt, first.sourceSessions['claude:old'].capturedAt);
  assert.equal(next.sourceSessions['claude:old'].sourceObservedAt, '2026-10-11T12:01:00Z');
});

test('an observed same ID may decrease or clear while an absent ID retains its disjoint events', t => {
  const { options } = tempArchive(t);
  retainDailyHistory(graph([source('a', [day('2026-10-11', 100)]), source('b', [day('2026-10-10', 50)])]), options);
  retainDailyHistory(graph([source('a', [day('2026-10-11', 5, 'sonnet', 0)])], '2026-10-11T12:01:00Z'), options);
  assert.equal(total(readDailyHistoryArchive(options)), 55);
  retainDailyHistory(graph([source('a', [], [])], '2026-10-11T12:02:00Z'), options);
  const restarted = readDailyHistoryArchive(options);
  assert.equal(total(restarted), 50);
  assert.deepEqual(restarted.sourceSessions['claude:a'].days, {});
  assert.deepEqual(restarted.sourceSessions['claude:a'].events, []);
});

test('complete zero-ID scans persist client authority and protect against legacy aggregate floors', t => {
  const { options } = tempArchive(t);
  const old = captureDailyHistoryArchive({}, { contributions: [day('2026-10-11', 500)] });
  writeDailyHistoryArchive(old, options);
  retainDailyHistory(graph([]), options);
  const restarted = readDailyHistoryArchive(options);
  assert.deepEqual(restarted.sourceClients, ['claude']);
  assert.equal(restarted.sourceSnapshots.claude.replacementAuthority, true);
  assert.equal(total(restarted), 0);
  assert.equal(Object.values(restarted.unresolvedDays['2026-10-11'].observations)[0].tokens, 500);
});

test('identity gaps suspend previous authority and explicitly project current unknown aggregates', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 100)])]));
  const incomplete = graph([source('a', [day('2026-10-11', 5)])], '2026-10-11T12:01:00Z', { rowsWithoutIdentity: { claude: 1 } });
  incomplete.contributions.push(day('2026-10-11', 70, 'unknown'));
  const next = roundTrip(captureDailyHistoryArchive(first, incomplete));
  assert.deepEqual(next.sourceClients, []);
  assert.equal(next.sourceSnapshots.claude.reason, 'identity-gap');
  assert.equal(total(next), 75);
  const projected = graphFromDailyHistoryArchive(incomplete, next);
  assert.equal(normalizeHistory(parseGraphResult(projected)).summary.totalTokens, 75);
  assert.deepEqual(projected.sourceUsage.unresolvedClients, ['claude']);
  assert.deepEqual(projected.sourceUsage.sessions.map(row => row.sessionId), ['a']);
  assert.deepEqual(projected.sourceUsage.replacementClients, []);
  assert.equal(Object.values(next.sourceSessions['claude:a'].days['2026-10-11'].observations)[0].tokens, 5);
  assert.equal(Object.values(next.sourceSnapshots.claude.fallbackDays['2026-10-11'].observations)[0].tokens, 70);
  const recovered = captureDailyHistoryArchive(next, graph([source('a', [day('2026-10-11', 3)])], '2026-10-11T12:02:00Z'));
  assert.equal(total(recovered), 3);
  assert.deepEqual(recovered.sourceClients, ['claude']);
});

test('identity-less events and unknown session sentinels stay unresolved rather than becoming fake exact IDs', () => {
  for (const snapshot of [source('unknown', [day('2026-10-11', 10)]),
    source('a', [day('2026-10-11', 10)], [{ id: null, days: [day('2026-10-11', 10)] }]),
    source('a', [day('2026-10-11', 10)], [])]) {
    const archive = roundTrip(captureDailyHistoryArchive({}, graph([snapshot])));
    assert.equal(total(archive), 10);
    assert.deepEqual(archive.sourceClients, []);
    if (snapshot.events[0]?.id === null) {
      assert.equal(archive.sourceSessions['claude:a'].events[0].id, null);
      assert.equal(Object.values(archive.sourceSessions['claude:a'].unresolvedDays['2026-10-11'].observations)[0].tokens, 10);
      assert.deepEqual(graphFromDailyHistoryArchive([], archive).sourceUsage.unresolvedSessions.map(row => row.sessionId), ['a']);
    } else assert.deepEqual(archive.sourceSessions || {}, {});
    assert.equal(archive.sourceSnapshots.claude.reason, 'identity-gap');
  }
  const copilot = { ...source('unknown-session', [day('2026-10-11', 10)]), client: 'copilot' };
  copilot.days[0].clients[0].client = 'copilot';
  copilot.events = [event('copilot', copilot.days)];
  assert.equal(sourceSnapshotsFromGraphs(graph([copilot], undefined, { replacementClients: ['copilot'] })).size, 0);
});

test('legacy source records without event identity remain on disk as unresolved data', () => {
  const legacy = { sourceClients: ['claude'], sourceSessions: { 'claude:a': { client: 'claude', sessionId: 'a',
    capturedAt: '2026-10-11T12:00:00Z', days: { '2026-10-11': { date: '2026-10-11', observations: [
      { client: 'claude', modelId: 'opus', tokens: 100, cost: 1 }
    ] } } } } };
  const normalized = roundTrip(legacy);
  assert.equal(normalized.sourceSessions, undefined);
  assert.deepEqual(normalized.sourceClients, []);
  assert.equal(Object.values(normalized.unresolvedDays['2026-10-11'].observations)[0].tokens, 100);
  assert.equal(total(normalized), 0);
});

test('source paths remain local and only persisted session-file proof can mark omitted sources missing', t => {
  const { directory, options } = tempArchive(t);
  const file = path.join(directory, 'a.jsonl');
  fs.writeFileSync(file, '{}');
  retainDailyHistory(graph([source('a', [day('2026-10-11', 10)])]), { ...options, sourcePaths: { 'claude:a': file } });
  let archive = readDailyHistoryArchive(options);
  assert.equal(archive.sourceSessions['claude:a'].sourcePath, file);
  assert.equal(JSON.stringify(graphFromDailyHistoryArchive([], archive)).includes(file), false);
  fs.unlinkSync(file);
  retainDailyHistory(graph([], '2026-10-11T12:01:00Z'), options);
  archive = readDailyHistoryArchive(options);
  assert.equal(archive.sourceSessions['claude:a'].sourceState, 'missing');
  assert.equal(total(archive), 10);
  const error = Object.assign(new Error('unreadable'), { code: 'EACCES' });
  const failed = captureDailyHistoryArchive(archive, graph([], '2026-10-11T12:02:00Z'), { sourceStateDeps: { lstatSync: () => { throw error; } } });
  assert.equal(failed.sourceSessions['claude:a'].sourceState, 'unknown');
  for (const invalid of ['relative.jsonl', '/', '\0broken', directory]) {
    const next = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 10)])]), { sourcePaths: { 'claude:a': invalid } });
    const omitted = captureDailyHistoryArchive(roundTrip(next), graph([], '2026-10-11T12:01:00Z'));
    assert.equal(omitted.sourceSessions['claude:a'].sourceState, 'unknown');
  }
});

test('stale and filtered scans cannot reclassify newer sources or replace metadata', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 10)])], '2026-10-11T12:02:00Z'));
  for (const input of [graph([], '2026-10-11T12:00:00Z'),
    graph([], '2026-10-11T12:03:00Z', { fullHistory: false }),
    graph([source('a', [day('2026-10-10', 100)])], '2026-10-11T12:00:00Z', { rowsWithoutIdentity: { claude: 1 } })]) {
    const next = captureDailyHistoryArchive(first, input, { sourcePaths: { 'claude:a': '/private/tmp/absent-source.jsonl' } });
    assert.deepEqual(next.sourceSessions, first.sourceSessions);
    assert.deepEqual(next.sourceSnapshots, first.sourceSnapshots);
    assert.equal(total(next), 10);
  }
});

test('an older observed ID cannot undo a newer omission or ownership migration', () => {
  const rows = [day('2026-10-11', 100)];
  const first = captureDailyHistoryArchive({}, graph([source('a', rows, [event('shared', rows)])]));
  const next = captureDailyHistoryArchive(first, graph([source('b', rows, [event('shared', rows)])], '2026-10-11T12:02:00Z'));
  const stale = captureDailyHistoryArchive(next, graph([source('a', [day('2026-10-11', 200)])], '2026-10-11T12:01:00Z'));
  assert.deepEqual(stale.sourceSessions, next.sourceSessions);
  assert.equal(total(stale), 100);
});

test('synthetic-only partial client snapshots never acquire replacement authority', () => {
  const partial = graph([source('a', [day('2026-10-11', 40)])], undefined, { replacementClients: [], partialClients: ['claude'] });
  const next = captureDailyHistoryArchive({}, partial);
  assert.equal(next.sourceSessions, undefined);
  assert.equal(next.sourceSnapshots, undefined);
  assert.equal(total(next), 40);
  assert.equal(sourceSnapshotsFromGraphs(partial).size, 0);
  const full = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 100)])]));
  partial.sourceUsage.capturedAt = '2026-10-11T12:01:00Z';
  const suspended = captureDailyHistoryArchive(full, partial);
  assert.deepEqual(suspended.sourceClients, []);
  assert.equal(suspended.sourceSnapshots.claude.reason, 'partial-client-scope');
  assert.deepEqual(suspended.sourceSessions, full.sourceSessions);
  assert.equal(total(suspended), 40);
});

test('only selected clients can own source graphs and independent clients survive replacement', () => {
  const cursorRows = [day('2026-10-11', 90)];
  cursorRows[0].clients[0].client = 'cursor';
  const cursor = { ...source('cursor-a', cursorRows), client: 'cursor' };
  const input = graph([source('a', [day('2026-10-11', 10)]), cursor]);
  const next = captureDailyHistoryArchive({}, input);
  assert.deepEqual(next.sourceClients, ['claude']);
  assert.deepEqual(Object.keys(next.sourceSessions), ['claude:a']);
  assert.equal(total(next), 100);
  const cleared = captureDailyHistoryArchive(next, graph([], '2026-10-11T12:01:00Z'));
  assert.equal(total(cleared), 100, 'zero observed IDs are omissions, retaining exact prior IDs');
});

test('malformed source metadata cannot grant exact authority and source snapshot containers fail closed', t => {
  for (const extra of [{ bucketTimezone: 'invalid-zone' }, { dayKey: 'bad' }, { eventIdentityVersion: 2 }, { replacementClients: undefined }]) {
    const next = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 10)])], undefined, extra));
    assert.equal(next.sourceSessions, undefined);
    assert.equal(total(next), 10);
  }
  const { options } = tempArchive(t);
  fs.writeFileSync(options.path, JSON.stringify({ days: {}, sourceSnapshots: [] }));
  assert.throws(() => readDailyHistoryArchive(options), /sourceSnapshots must be an object/);
});

test('unreported identity-less aggregate usage suspends source authority rather than dropping its remainder', () => {
  const input = graph([source('a', [day('2026-10-11', 10)])]);
  input.contributions.push(day('2026-10-11', 20, 'missing-id'));
  const next = captureDailyHistoryArchive({}, input);
  assert.equal(total(next), 30);
  assert.deepEqual(next.sourceClients, []);
  assert.equal(next.sourceSnapshots.claude.reason, 'identity-gap');
});

test('ownership migration across shared client digest lanes keeps only disjoint events', () => {
  const oldRows = [day('2026-10-10', 100)];
  const keptRows = [day('2026-10-11', 20)];
  const first = captureDailyHistoryArchive({}, graph([source('old', [...oldRows, ...keptRows], [event('shared', oldRows), event('kept', keptRows)])]));
  const newRows = [day('2026-10-11', 5, 'sonnet', 0)];
  newRows[0].clients[0].client = 'cc-mirror/ssh';
  const next = roundTrip(captureDailyHistoryArchive(first, graph([{ client: 'cc-mirror/ssh', sessionId: 'new', days: newRows,
    events: [event('shared', newRows)] }], '2026-10-11T12:01:00Z', { replacementClients: ['cc-mirror/ssh'] })));
  assert.equal(total(next), 25);
  assert.equal(next.sourceSessions['claude:old'].sourceState, 'unknown');
  assert.equal(next.sourceSessions['claude:old'].sourceObservedAt, '2026-10-11T12:01:00.000Z');
  assert.deepEqual(next.sourceSessions['claude:old'].events.map(row => row.id), [digest('kept')]);
});

test('same-model partial ownership transfer subtracts exact event components and costs without ratios', () => {
  const one = [{ date: '2026-10-11', clients: [{ client: 'claude', modelId: 'opus', providerId: 'anthropic',
    tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, cost: 9, messages: 1 }] }];
  const two = [{ date: '2026-10-11', clients: [{ client: 'claude', modelId: 'opus', providerId: 'anthropic',
    tokens: { input: 4, output: 3, cacheRead: 2, cacheWrite: 1 }, cost: 0, messages: 2 }] }];
  const first = captureDailyHistoryArchive({}, graph([source('old', [...one, ...two], [event('one', one), event('two', two)])]));
  const next = roundTrip(captureDailyHistoryArchive(first, graph([source('new', two, [event('one', two)])], '2026-10-11T12:01:00Z')));
  assert.equal(total(next), 20);
  const retained = Object.values(next.sourceSessions['claude:old'].days['2026-10-11'].observations)[0];
  assert.equal(retained.tokens, 10);
  assert.equal(retained.cost, 0);
  assert.equal(retained.outputTokens, 3);
  assert.equal(retained.cacheReadTokens, 2);
  assert.equal(retained.cacheWriteTokens, 1);
  assert.equal(retained.messages, 2);
});

test('normalization rejects mismatched identity keys and preserves each legacy contribution unresolved', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 10)]), source('b', [day('2026-10-11', 20)])]));
  const invalid = JSON.parse(JSON.stringify(first));
  invalid.sourceSessions['claude:a'].sessionId = 'unknown';
  invalid.sourceSessions['claude:b'].sessionId = 'mismatched';
  const next = normalizeDailyHistoryArchive(invalid);
  assert.equal(next.sourceSessions, undefined);
  assert.deepEqual(next.sourceClients, []);
  assert.equal(next.sourceSnapshots.claude.reason, 'identity-gap');
  assert.equal(total(next), 30);
});

test('suspended clients retain growing live aggregate fallback while other clients remain accounted', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 10)])], undefined, { rowsWithoutIdentity: { claude: 1 } }));
  const live = extractUsageFromTokscale({ entries: [{ client: 'claude', modelId: 'opus', input: 30 }] });
  const next = captureLiveDailyHistory(first, live, { todayKey: '2026-10-11' });
  assert.equal(total(next), 30);
  assert.equal(next.sourceSnapshots.claude.replacementAuthority, false);
});

// Captured from the fork CLI with an isolated OpenCode source home and offline
// pricing caches. Calendar padding and unrelated meta are omitted; all source
// rows, event digests and accounting/bucket metadata are the exported bytes.
const nativeSerializedGraph = '{"contributions":[{"date":"2026-03-03","totals":{"tokens":103,"cost":0.25,"messages":1},"intensity":3,"tokenBreakdown":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"reasoning":3},"clients":[{"client":"opencode","modelId":"model-0","providerId":"provider","tokens":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"reasoning":3},"cost":0.25,"messages":1}]},{"date":"2026-03-04","totals":{"tokens":21,"cost":0.5,"messages":1},"intensity":4,"tokenBreakdown":{"input":2,"output":4,"cacheRead":6,"cacheWrite":8,"reasoning":1},"clients":[{"client":"opencode","modelId":"model-1","providerId":"provider","tokens":{"input":2,"output":4,"cacheRead":6,"cacheWrite":8,"reasoning":1},"cost":0.5,"messages":1}]}],"sourceUsage":{"version":1,"eventIdentityVersion":1,"capturedAt":"2026-10-11T04:57:01.753283+00:00","fullHistory":true,"replacementClients":["opencode"],"partialClients":[],"bucketTimezone":"Asia/Hong_Kong","dayKey":"2026-10-11","sessions":[{"client":"opencode","sessionId":"native-session","days":[{"date":"2026-03-03","totals":{"tokens":103,"cost":0.25,"messages":1},"intensity":3,"tokenBreakdown":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"reasoning":3},"clients":[{"client":"opencode","modelId":"model-0","providerId":"provider","tokens":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"reasoning":3},"cost":0.25,"messages":1}]},{"date":"2026-03-04","totals":{"tokens":21,"cost":0.5,"messages":1},"intensity":4,"tokenBreakdown":{"input":2,"output":4,"cacheRead":6,"cacheWrite":8,"reasoning":1},"clients":[{"client":"opencode","modelId":"model-1","providerId":"provider","tokens":{"input":2,"output":4,"cacheRead":6,"cacheWrite":8,"reasoning":1},"cost":0.5,"messages":1}]}],"events":[{"id":"sha256:3b396ef7fa6d76906982cb85f6fed91d2d3b3b69cca4cc98519646ff01bc49a0","days":[{"date":"2026-03-04","totals":{"tokens":21,"cost":0.5,"messages":1},"intensity":4,"tokenBreakdown":{"input":2,"output":4,"cacheRead":6,"cacheWrite":8,"reasoning":1},"clients":[{"client":"opencode","modelId":"model-1","providerId":"provider","tokens":{"input":2,"output":4,"cacheRead":6,"cacheWrite":8,"reasoning":1},"cost":0.5,"messages":1}]}]},{"id":"sha256:e7d837b447e593c7c0aea2b05067d0537b9038059881a7e7565cb370884ba83a","days":[{"date":"2026-03-03","totals":{"tokens":103,"cost":0.25,"messages":1},"intensity":4,"tokenBreakdown":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"reasoning":3},"clients":[{"client":"opencode","modelId":"model-0","providerId":"provider","tokens":{"input":10,"output":20,"cacheRead":30,"cacheWrite":40,"reasoning":3},"cost":0.25,"messages":1}]}]}]}],"rowsWithoutIdentity":{}},"timeMetrics":{"totalActiveTimeMs":0,"longestContinuousMs":0,"maxConcurrentSessions":1,"sessionCount":2}}';

test('fork CLI serialized export round-trips real reasoning buckets through persisted source graph', t => {
  const native = JSON.parse(nativeSerializedGraph);
  const { options } = tempArchive(t);
  retainDailyHistory(native, options);
  const archive = readDailyHistoryArchive(options);
  assert.deepEqual(archive.sourceClients, ['opencode']);
  assert.equal(archive.sourceSessions['opencode:native-session'].events.length, 2);
  assert.equal(archive.sourceSnapshots.opencode.bucketTimezone, 'Asia/Hong_Kong');
  const replay = JSON.parse(JSON.stringify(graphFromDailyHistoryArchive([], archive)));
  const history = normalizeHistory(parseGraphResult(replay));
  assert.equal(history.summary.totalTokens, 124);
  assert.equal(history.summary.totalCost, 0.75);
  const summary = { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
  applySourceDailyUsage(summary, replay.sourceUsage, { todayKey: '2026-10-11', timeZone: native.sourceUsage.bucketTimezone });
  assert.equal(summary.allTime.totalTokens, 124);
  assert.equal(summary.allTime.outputTokens, 28);
  assert.equal(summary.allTime.cacheReadTokens, 36);
  assert.equal(summary.allTime.cacheWriteTokens, 48);
  assert.equal(summary.allTime.costUsd, 0.75);
  assert.deepEqual(replay.sourceUsage.sessions[0].days.flatMap(day => day.clients.map(row => row.providerId)), ['provider', 'provider']);
});

test('current identity-less aggregate graphs suspend old source authority without hiding their usage', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 100)])]));
  const aggregate = { contributions: [day('2026-10-11', 75, 'unknown')] };
  const next = roundTrip(captureDailyHistoryArchive(first, aggregate));
  assert.equal(total(next), 75);
  assert.deepEqual(next.sourceClients, []);
  assert.equal(next.sourceSnapshots.claude.reason, 'identity-gap');
  assert.deepEqual(next.sourceSessions, first.sourceSessions, 'the aggregate carries no source classification evidence');
  assert.equal(normalizeHistory(parseGraphResult(graphFromDailyHistoryArchive(aggregate, first))).summary.totalTokens, 75);
  const stale = { ...aggregate, meta: { generatedAt: '2026-10-11T11:00:00Z' } };
  const unchanged = captureDailyHistoryArchive(first, stale);
  assert.deepEqual(unchanged.sourceSnapshots, first.sourceSnapshots);
  assert.equal(total(unchanged), 100);
});

function rawSource(client, sessionId, tokens, eventId = `${client}:${sessionId}`) {
  const rows = [day('2026-10-11', tokens)];
  rows[0].clients[0].client = client;
  return { client, sessionId, days: rows, events: [event(eventId, rows)] };
}

test('independent raw Devin partitions with the same session ID accumulate only at canonical projection', () => {
  const first = captureDailyHistoryArchive({}, graph([rawSource('devin-cli', 'shared', 100)], undefined, { replacementClients: ['devin-cli'] }));
  const next = roundTrip(captureDailyHistoryArchive(first, graph([rawSource('devin-desktop', 'shared', 5)],
    '2026-10-11T12:01:00Z', { replacementClients: ['devin-desktop'] })));
  assert.deepEqual(Object.keys(next.sourceSessions).sort(), ['devin-cli:shared', 'devin-desktop:shared']);
  assert.deepEqual(next.sourceClients, ['devin-cli', 'devin-desktop']);
  assert.equal(total(next), 105);
  const replay = graphFromDailyHistoryArchive([], next);
  assert.deepEqual(replay.contributions[0].clients.map(row => row.client), ['devin']);
  assert.deepEqual(replay.sourceUsage.sessions.map(row => row.client).sort(), ['devin-cli', 'devin-desktop']);
  const corrected = roundTrip(captureDailyHistoryArchive(next, graph([rawSource('devin-desktop', 'shared', 0)],
    '2026-10-11T12:02:00Z', { replacementClients: ['devin-desktop'] })));
  assert.equal(total(corrected), 100);
});

test('raw partial Antigravity scope is rejected before aliases acquire complete selection authority', () => {
  const first = captureDailyHistoryArchive({}, graph([rawSource('antigravity-cli', 'old', 100)], undefined,
    { replacementClients: ['antigravity-cli'] }));
  const input = graph([rawSource('antigravity-cli', 'new', 5), rawSource('antigravity-extension', 'ext', 20)],
    '2026-10-11T12:01:00Z', { replacementClients: ['antigravity-cli'], partialClients: ['antigravity-extension'] });
  assert.deepEqual([...sourceSnapshotsFromGraphs(input).keys()], ['antigravity-cli:new']);
  const next = roundTrip(captureDailyHistoryArchive(first, input));
  assert.deepEqual(next.sourceClients, ['antigravity-cli']);
  assert.equal(next.sourceSnapshots['antigravity-cli'].replacementAuthority, true);
  assert.equal(next.sourceSnapshots['antigravity-extension'].replacementAuthority, false);
  assert.equal(next.sourceSessions['antigravity-extension:ext'], undefined);
  assert.equal(total(next), 125);
  assert.deepEqual(graphFromDailyHistoryArchive([], next).contributions[0].clients.map(row => row.client), ['antigravity']);
});

test('shared-family aliases retain raw session partitions while their independent events fold to the app parent', () => {
  const first = captureDailyHistoryArchive({}, graph([rawSource('claude', 'shared', 100)]));
  const next = roundTrip(captureDailyHistoryArchive(first, graph([rawSource('cc-mirror/ssh', 'shared', 5)],
    '2026-10-11T12:01:00Z', { replacementClients: ['claude'] })));
  assert.equal(total(next), 105);
  assert.deepEqual(Object.keys(next.sourceSessions).sort(), ['cc-mirror/ssh:shared', 'claude:shared']);
  assert.deepEqual(graphFromDailyHistoryArchive([], next).contributions[0].clients.map(row => row.client), ['claude']);
});

test('only shared dedup families can transfer digest ownership across raw partitions', () => {
  const first = captureDailyHistoryArchive({}, graph([rawSource('devin-cli', 'shared', 100, 'same-digest')], undefined,
    { replacementClients: ['devin-cli'] }));
  const next = roundTrip(captureDailyHistoryArchive(first, graph([rawSource('devin-desktop', 'shared', 5, 'same-digest')],
    '2026-10-11T12:01:00Z', { replacementClients: ['devin-desktop'] })));
  assert.equal(total(next), 105);
});

test('empty null events allow an observed whole-ID clear and preserve unrelated omitted identified usage', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 100)]), source('b', [day('2026-10-11', 50)])]));
  const next = roundTrip(captureDailyHistoryArchive(first, graph([source('a', [], [{ id: null, days: [] }])], '2026-10-11T12:01:00Z')));
  assert.equal(total(next), 50);
  assert.deepEqual(next.sourceClients, ['claude']);
  assert.deepEqual(next.sourceSessions['claude:a'].days, {});
  assert.deepEqual(next.sourceSessions['claude:b'].events, first.sourceSessions['claude:b'].events);
});

test('mixed keyed and null event usage stays explicitly unresolved without hiding retained disjoint IDs', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 100)]), source('b', [day('2026-10-11', 50)])]));
  const keyed = [day('2026-10-11', 10)];
  const unkeyed = [day('2026-10-11', 3)];
  const next = roundTrip(captureDailyHistoryArchive(first, graph([source('a', [...keyed, ...unkeyed],
    [event('a', keyed), { id: null, days: unkeyed }])], '2026-10-11T12:01:00Z')));
  assert.equal(total(next), 63);
  assert.deepEqual(next.sourceClients, []);
  assert.equal(next.sourceSnapshots.claude.projectIdentified, true);
  assert.equal(Object.values(next.sourceSessions['claude:a'].unresolvedDays['2026-10-11'].observations)[0].tokens, 3);
  assert.equal(graphFromDailyHistoryArchive([], next).sourceUsage.unresolvedSessions[0].sessionId, 'a');
  const replay = graphFromDailyHistoryArchive([], next).sourceUsage;
  assert.deepEqual(replay.sessions.map(row => row.sessionId).sort(), ['a', 'b']);
  assert.deepEqual(replay.replacementClients, []);
  assert.equal(replay.sourceSnapshots.claude.replacementAuthority, false);
  assert.equal(replay.sessions.find(row => row.sessionId === 'a').days[0].clients[0].tokens.input, 10);
  assert.equal(replay.sessions.find(row => row.sessionId === 'a').events.some(row => row.id === null), false);
  const migrated = roundTrip(captureDailyHistoryArchive(next, graph([source('new', [day('2026-10-11', 2)],
    [event('a', [day('2026-10-11', 2)])])], '2026-10-11T12:02:00Z')));
  assert.equal(total(migrated), 55, 'only the keyed ten moves; null three and unrelated fifty survive');
  assert.deepEqual(migrated.sourceSessions['claude:a'].events.map(row => row.id), [null]);
  const omitted = graphFromDailyHistoryArchive([], migrated).sourceUsage;
  assert.deepEqual(omitted.sessions.map(row => row.sessionId).sort(), ['a', 'b', 'new']);
  assert.deepEqual(omitted.sessions.find(row => row.sessionId === 'a').days, []);
  assert.equal(omitted.unresolvedSessions.find(row => row.sessionId === 'a').days[0].clients[0].tokens.input, 3);
});

test('unkeyed aggregate remainder advances observed rows and preserves unrelated omitted IDs', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 100)]), source('b', [day('2026-10-11', 50)])]));
  const input = graph([source('a', [day('2026-10-11', 5)])], '2026-10-11T12:01:00Z', { rowsWithoutIdentity: { claude: 1 } });
  input.contributions.push(day('2026-10-11', 70));
  const next = roundTrip(captureDailyHistoryArchive(first, input));
  assert.equal(total(next), 125);
  assert.equal(Object.values(next.sourceSnapshots.claude.fallbackDays['2026-10-11'].observations)[0].tokens, 70);
  assert.equal(Object.values(next.sourceSessions['claude:b'].days['2026-10-11'].observations)[0].tokens, 50);
});

test('a malformed observed event group suspends that identity without suppressing unrelated retained identities', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 100)]), source('b', [day('2026-10-11', 50)])]));
  const next = roundTrip(captureDailyHistoryArchive(first, graph([source('a', [day('2026-10-11', 5)], [])], '2026-10-11T12:01:00Z')));
  assert.equal(total(next), 55);
  assert.deepEqual(next.sourceSnapshots.claude.unresolvedSessionIds, ['a']);
  assert.equal(Object.values(next.sourceSessions['claude:a'].days['2026-10-11'].observations)[0].tokens, 100, 'last proof remains on disk');
});

test('legacy source rows lacking event identities remain local unresolved alongside an exact client projection', () => {
  const first = captureDailyHistoryArchive({}, graph([source('b', [day('2026-10-11', 50)])]));
  const legacy = { ...JSON.parse(JSON.stringify(first)), sourceSessions: { ...first.sourceSessions,
    'claude:a': { ...first.sourceSessions['claude:b'], sessionId: 'a', events: undefined } } };
  const next = roundTrip(legacy);
  assert.equal(total(next), 50);
  assert.equal(next.sourceSessions['claude:a'], undefined);
  assert.equal(Object.values(next.unresolvedDays['2026-10-11'].observations)[0].tokens, 50);
  assert.deepEqual(next.sourceClients, ['claude']);
});

test('aggregate fallback persists an independent frontier and keeps the last proven source metadata', t => {
  const { options } = tempArchive(t);
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 100)])]));
  const newer = captureDailyHistoryArchive(first, { meta: { generatedAt: '2026-10-11T12:03:00Z' }, contributions: [day('2026-10-11', 75)] });
  writeDailyHistoryArchive(newer, options);
  const persisted = readDailyHistoryArchive(options);
  assert.equal(persisted.sourceSnapshots.claude.observationFrontier, '2026-10-11T12:03:00Z');
  assert.equal(persisted.sourceSnapshots.claude.capturedAt, first.sourceSnapshots.claude.capturedAt);
  assert.deepEqual(persisted.sourceSessions, first.sourceSessions);
  const stale = roundTrip(captureDailyHistoryArchive(persisted, graph([source('a', [day('2026-10-11', 200)])], '2026-10-11T12:01:00Z')));
  assert.equal(total(stale), 75);
  assert.deepEqual(stale.sourceSnapshots, persisted.sourceSnapshots);
  const fresh = captureDailyHistoryArchive(stale, graph([source('a', [day('2026-10-11', 3)])], '2026-10-11T12:04:00Z'));
  assert.equal(total(fresh), 3);
  assert.equal(fresh.sourceSnapshots.claude.observationFrontier, undefined);
});

test('prewrite rebase excludes rejected source accounting and daily timing from the persisted and replayed graph', () => {
  const timed = (tokens, capturedAt, activeTimeMs) => ({ ...graph([source('a', [day('2026-10-11', tokens)])], capturedAt),
    contributions: [{ ...day('2026-10-11', tokens), activeTimeMs }],
    timeMetrics: { totalActiveTimeMs: activeTimeMs, longestContinuousMs: activeTimeMs, maxConcurrentSessions: 1, sessionCount: 1 } });
  const first = captureDailyHistoryArchive({}, timed(100, '2026-10-11T12:00:00Z', 10000));
  const newest = captureDailyHistoryArchive(first, timed(20, '2026-10-11T12:02:00Z', 20000));
  let reads = 0;
  const writes = [];
  const result = retainDailyHistory(timed(300, '2026-10-11T12:01:00Z', 50000), {
    path: '/private/tmp/source-daily-rebase-fixture.json', readJson: () => ++reads === 1 ? first : newest,
    writeJsonAtomic: (_file, value) => writes.push(value)
  });
  assert.equal(reads, 2);
  assert.deepEqual(writes, [], 'the rejected scan produces no accounting or timing write');
  assert.equal(result.timeMetrics.totalActiveTimeMs, 20000);
  assert.equal(result.timeMetrics.longestContinuousMs, 20000);
  assert.equal(result.contributions[0].activeTimeMs, 20000);
  assert.equal(normalizeHistory(parseGraphResult(result)).summary.totalTokens, 20);
});

test('an older aggregate fallback cannot replace newer fallback timing or its observation frontier', () => {
  const first = captureDailyHistoryArchive({}, { ...graph([source('a', [day('2026-10-11', 100)])]),
    contributions: [{ ...day('2026-10-11', 100), activeTimeMs: 10000 }] });
  const newer = roundTrip(captureDailyHistoryArchive(first, { meta: { generatedAt: '2026-10-11T12:03:00Z' },
    contributions: [{ ...day('2026-10-11', 75), activeTimeMs: 20000 }], timeMetrics: { totalActiveTimeMs: 20000 } }));
  const stale = roundTrip(captureDailyHistoryArchive(newer, { meta: { generatedAt: '2026-10-11T12:02:00Z' },
    contributions: [{ ...day('2026-10-11', 200), activeTimeMs: 50000 }], timeMetrics: { totalActiveTimeMs: 50000 } }));
  assert.deepEqual(stale, newer);
  assert.equal(graphFromDailyHistoryArchive([], stale).timeMetrics.totalActiveTimeMs, 20000);
});

test('stale shared-lane snapshots cannot duplicate a newer event owner in another client', () => {
  const rows = [day('2026-10-11', 10)];
  const first = captureDailyHistoryArchive({}, graph([source('a', rows, [event('shared', rows)])], '2026-10-11T12:02:00Z'));
  const copied = [day('2026-10-11', 100)];
  copied[0].clients[0].client = 'cc-mirror/ssh';
  const stale = captureDailyHistoryArchive(first, graph([{ client: 'cc-mirror/ssh', sessionId: 'a', days: copied,
    events: [event('shared', copied)] }], '2026-10-11T12:01:00Z', { replacementClients: ['cc-mirror/ssh'] }));
  assert.deepEqual(stale.sourceSessions, first.sourceSessions);
  assert.deepEqual(stale.sourceSnapshots, first.sourceSnapshots);
  assert.equal(total(stale), 10);
});

// Real a4262ba fork CLI provider-set export; only empty calendar padding is omitted.
const nativeProviderSetGraph = "{\"contributions\":[{\"date\":\"2026-07-13\",\"totals\":{\"tokens\":50,\"cost\":0.5,\"messages\":2},\"intensity\":4,\"tokenBreakdown\":{\"input\":30,\"output\":8,\"cacheRead\":6,\"cacheWrite\":4,\"reasoning\":2},\"clients\":[{\"client\":\"opencode\",\"modelId\":\"claude-sonnet-4\",\"providerId\":\"anthropic, openrouter\",\"tokens\":{\"input\":30,\"output\":8,\"cacheRead\":6,\"cacheWrite\":4,\"reasoning\":2},\"cost\":0.5,\"messages\":2}],\"activeTimeMs\":60000}],\"sourceUsage\":{\"version\":1,\"eventIdentityVersion\":1,\"capturedAt\":\"2026-10-11T05:08:21.766366+00:00\",\"fullHistory\":true,\"replacementClients\":[\"opencode\"],\"partialClients\":[],\"bucketTimezone\":\"Asia/Hong_Kong\",\"dayKey\":\"2026-10-11\",\"sessions\":[{\"client\":\"opencode\",\"sessionId\":\"shared-session\",\"days\":[{\"date\":\"2026-07-13\",\"totals\":{\"tokens\":50,\"cost\":0.5,\"messages\":2},\"intensity\":4,\"tokenBreakdown\":{\"input\":30,\"output\":8,\"cacheRead\":6,\"cacheWrite\":4,\"reasoning\":2},\"clients\":[{\"client\":\"opencode\",\"modelId\":\"claude-sonnet-4\",\"providerId\":\"anthropic, openrouter\",\"tokens\":{\"input\":30,\"output\":8,\"cacheRead\":6,\"cacheWrite\":4,\"reasoning\":2},\"cost\":0.5,\"messages\":2}]}],\"events\":[{\"id\":\"sha256:2fac8f09e09612c4d46de1850330b5ad552dad61ba604f9f86ec27dd1f92ed1a\",\"days\":[{\"date\":\"2026-07-13\",\"totals\":{\"tokens\":20,\"cost\":0.25,\"messages\":1},\"intensity\":4,\"tokenBreakdown\":{\"input\":10,\"output\":4,\"cacheRead\":3,\"cacheWrite\":2,\"reasoning\":1},\"clients\":[{\"client\":\"opencode\",\"modelId\":\"claude-sonnet-4\",\"providerId\":\"anthropic\",\"tokens\":{\"input\":10,\"output\":4,\"cacheRead\":3,\"cacheWrite\":2,\"reasoning\":1},\"cost\":0.25,\"messages\":1}]}]},{\"id\":\"sha256:33c1fafb1fd994dfb6452bd25816b216750446a31ddd7a272c8af73961cb7e93\",\"days\":[{\"date\":\"2026-07-13\",\"totals\":{\"tokens\":30,\"cost\":0.25,\"messages\":1},\"intensity\":4,\"tokenBreakdown\":{\"input\":20,\"output\":4,\"cacheRead\":3,\"cacheWrite\":2,\"reasoning\":1},\"clients\":[{\"client\":\"opencode\",\"modelId\":\"claude-sonnet-4\",\"providerId\":\"openrouter\",\"tokens\":{\"input\":20,\"output\":4,\"cacheRead\":3,\"cacheWrite\":2,\"reasoning\":1},\"cost\":0.25,\"messages\":1}]}]}]}],\"rowsWithoutIdentity\":{}}}";


test('real fork provider-set export retains replacement authority, components and unrelated omitted history', t => {
  const native = JSON.parse(nativeProviderSetGraph);
  const omitted = rawSource('opencode', 'omitted', 7);
  const first = captureDailyHistoryArchive({}, graph([omitted], '2026-10-11T05:00:00Z', { replacementClients: ['opencode'] }));
  const { options } = tempArchive(t);
  writeDailyHistoryArchive(first, options);
  retainDailyHistory(native, options);
  const archive = readDailyHistoryArchive(options);
  assert.deepEqual(archive.sourceClients, ['opencode']);
  assert.equal(total(archive), 57);
  const rows = Object.values(archive.sourceSessions['opencode:shared-session'].days['2026-07-13'].observations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].providerId, 'anthropic, openrouter');
  assert.equal(rows[0].tokens, 50);
  assert.equal(rows[0].outputTokens, 10);
  assert.equal(rows[0].cacheReadTokens, 6);
  assert.equal(rows[0].cacheWriteTokens, 4);
  assert.equal(rows[0].cost, 0.5);
  assert.equal(rows[0].messages, 2);
  assert.deepEqual(archive.sourceSessions['opencode:shared-session'].events.flatMap(event =>
    Object.values(event.days).flatMap(day => Object.values(day.observations).map(row => row.providerId))).sort(), ['anthropic', 'openrouter']);
  const replay = graphFromDailyHistoryArchive([], archive);
  assert.equal(replay.contributions.find(day => day.date === '2026-07-13').activeTimeMs, 60000);
  assert.equal(replay.sourceUsage.sessions.length, 2);
});

test('canonical identity-less aggregate corrects raw alias partitions once and blocks their older source scans', () => {
  const first = captureDailyHistoryArchive({}, graph([rawSource('devin-cli', 'shared', 100), rawSource('devin-desktop', 'shared', 5)],
    undefined, { replacementClients: ['devin-cli', 'devin-desktop'] }));
  const aggregate = { meta: { generatedAt: '2026-10-11T12:03:00Z' }, contributions: rawSource('devin', 'unidentified', 75).days };
  const corrected = roundTrip(captureDailyHistoryArchive(first, aggregate));
  assert.equal(total(corrected), 75);
  assert.deepEqual(corrected.sourceClients, []);
  assert.deepEqual(corrected.sourceSessions, first.sourceSessions);
  for (const client of ['devin-cli', 'devin-desktop']) {
    assert.equal(corrected.sourceSnapshots[client].observationFrontier, '2026-10-11T12:03:00Z');
    const stale = roundTrip(captureDailyHistoryArchive(corrected, graph([rawSource(client, 'shared', 200)],
      '2026-10-11T12:01:00Z', { replacementClients: [client] })));
    assert.equal(total(stale), 75);
    assert.deepEqual(stale.sourceSnapshots, corrected.sourceSnapshots);
  }
});

test('live unresolved aggregate growth preserves unrelated omitted exact rows', () => {
  const first = captureDailyHistoryArchive({}, graph([source('a', [day('2026-10-11', 10)]), source('b', [day('2026-10-11', 50)])]));
  const next = captureDailyHistoryArchive(first, graph([source('a', [day('2026-10-11', 10)])],
    '2026-10-11T12:01:00Z', { rowsWithoutIdentity: { claude: 1 } }));
  const live = extractUsageFromTokscale({ entries: [{ client: 'claude', model: 'opus', input: 30 }] });
  const updated = roundTrip(captureLiveDailyHistory(next, live, { todayKey: '2026-10-11' }));
  assert.equal(total(updated), 80);
  assert.equal(Object.values(updated.sourceSessions['claude:b'].days['2026-10-11'].observations)[0].tokens, 50);
  assert.equal(Object.values(updated.sourceSnapshots.claude.fallbackDays['2026-10-11'].observations)[0].tokens, 20);
});
