'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { aggregateDevices, mergePeriods, normalizePeriod } = require('../../src/shared/usage');
const { RUNNING_WINDOW_MS, sessionActivityState } = require('../../src/shared/sessionLive');
const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  normalizeSessionUsageArchive,
  updateSessionUsageArchive
} = require('../../src/shared/usage/sessionUsageArchive');
const {
  classifySessionSourcePath
} = require('../../src/shared/usage/sessionSourceState');
const {
  createSessionUsageArchiveStore,
  readSessionUsageArchiveSnapshot
} = require('../../src/shared/usage/sessionUsageArchiveStore');

const KEY = 'claude:one';
const NOW = new Date('2026-10-10T09:00:00.000Z');
const LATER = new Date('2026-10-10T09:05:00.000Z');
const PERIODS = ['today', 'month', 'allTime'];

function row(tokens = 100, model = 'old', client = 'claude', sessionId = 'one') {
  return {
    client, sessionId, totalTokens: tokens, costUsd: tokens / 100,
    inputTokens: tokens / 2, outputTokens: tokens / 2,
    models: { [model]: tokens }, modelCosts: { [model]: tokens / 100 }
  };
}

function period(sessions) {
  return normalizePeriod({
    totalTokens: Object.values(sessions).reduce((sum, value) => sum + value.totalTokens, 0),
    costUsd: Object.values(sessions).reduce((sum, value) => sum + value.costUsd, 0),
    models: Object.fromEntries(Object.values(sessions).flatMap((value) => Object.entries(value.models))),
    modelCosts: Object.fromEntries(Object.values(sessions).flatMap((value) => Object.entries(value.modelCosts))),
    sessions
  });
}

function summary(sessions = {}, source = { fullScan: true, presentKeys: Object.keys(sessions) }) {
  return {
    ...Object.fromEntries(PERIODS.map((name) => [name, period(sessions)])),
    sessionArchiveSource: source
  };
}

function captured(sourcePath) {
  return captureSessionUsageArchive({}, summary({ [KEY]: row() }, {
    fullScan: true, presentKeys: [KEY], paths: sourcePath ? { [KEY]: sourcePath } : {}
  }), NOW);
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function error(code) {
  return Object.assign(new Error(code), { code });
}

function restored(summaryValue, archive) {
  return applySessionUsageArchive(summaryValue, archive, { now: LATER }).allTime.sessions[KEY];
}

test('full live ID accepts lower tokens, cost and corrected model across every period', () => {
  const archive = captured();
  const corrected = summary({ [KEY]: row(20, 'corrected') });
  const next = updateSessionUsageArchive(archive, corrected, LATER);
  for (const name of PERIODS) {
    const session = next.archive.sessions[KEY].periods[name];
    assert.equal(session.totalTokens, 20);
    assert.equal(session.costUsd, 0.2);
    assert.deepEqual(session.models, { corrected: 20 });
    assert.deepEqual(session.modelCosts, { corrected: 0.2 });
  }
  const visible = applySessionUsageArchive(corrected, next.archive, { now: LATER });
  assert.equal(visible.allTime.totalTokens, 20);
  assert.deepEqual(visible.allTime.models, { corrected: 20 });
});

test('full live ID clears absent short-period snapshots and prevents ghosts', () => {
  const archive = captured();
  const corrected = summary();
  corrected.allTime = period({ [KEY]: row(15, 'new') });
  // allTime itself is live evidence, even when the additional key list is empty.
  const { archive: next } = updateSessionUsageArchive(archive, corrected, LATER);
  assert.equal(next.sessions[KEY].periods.today, undefined);
  assert.equal(next.sessions[KEY].periods.month, undefined);
  const visible = applySessionUsageArchive(corrected, next, { now: LATER });
  assert.equal(visible.today.totalTokens, 0);
  assert.equal(visible.month.totalTokens, 0);
  assert.equal(visible.allTime.totalTokens, 15);
});

test('a presentKeys-only zero correction replaces all old usage while retaining its frontier', () => {
  const empty = summary({}, { fullScan: true, presentKeys: [KEY] });
  const { archive } = updateSessionUsageArchive(captured(), empty, LATER);
  const entry = archive.sessions[KEY];
  assert.equal(entry.sourceState, 'present');
  assert.equal(entry.periods.allTime.totalTokens, 0);
  assert.equal(entry.periods.allTime.costUsd, 0);
  assert.deepEqual(entry.periods.allTime.models, {});
  assert.equal(entry.periods.today, undefined);
  assert.equal(entry.periods.month, undefined);
  const visible = applySessionUsageArchive(empty, archive, { now: LATER });
  assert.equal(visible.allTime.totalTokens, 0);
  assert.equal(visible.allTime.sessions[KEY], undefined);
  const normalized = normalizeSessionUsageArchive(archive);
  assert.equal(normalized.sessions[KEY].periods.allTime.totalTokens, 0);
  assert.equal(normalized.sessions[KEY].periodWindows.today.capturedAt, LATER.toISOString());
  const stale = updateSessionUsageArchive(normalized, summary({ [KEY]: row(90) }), NOW).archive;
  assert.equal(stale.sessions[KEY].periods.allTime.totalTokens, 0);
  assert.equal(stale.sessions[KEY].periods.today, undefined);
});

test('an explicit zero session row survives capture and normalization', () => {
  const { archive } = updateSessionUsageArchive(captured(), summary({ [KEY]: row(0) }), LATER);
  for (const name of PERIODS) {
    assert.equal(normalizeSessionUsageArchive(archive).sessions[KEY].periods[name].totalTokens, 0);
  }
});

for (const [name, make] of [
  ['watch', () => {
    const value = summary({}, { fullScan: false, presentKeys: [KEY] });
    value.today = normalizePeriod({ sessions: { [KEY]: row(12) } });
    return value;
  }],
  ['today preview', () => ({ today: normalizePeriod({ sessions: { [KEY]: row(12) } }),
    sessionArchiveSource: { fullScan: true, presentKeys: [KEY] } })],
  ['no allTime', () => ({ today: normalizePeriod({}), month: normalizePeriod({}),
    sessionArchiveSource: { fullScan: true, presentKeys: [KEY] } })],
  ['no today', () => ({ month: normalizePeriod({}), allTime: normalizePeriod({}),
    sessionArchiveSource: { fullScan: true, presentKeys: [KEY] } })],
  ['null allTime', () => ({ ...summary({}, { fullScan: true, presentKeys: [KEY] }), allTime: null })],
  ['legacy summary', () => { const value = summary(); delete value.sessionArchiveSource; return value; }]
]) {
  test(`${name} cannot clear unscanned or unconfirmed broad usage`, () => {
    const { archive } = updateSessionUsageArchive(captured(), make(), LATER);
    assert.equal(archive.sessions[KEY].periods.allTime.totalTokens, 100);
    assert.equal(archive.sessions[KEY].periods.month.totalTokens, 100);
    if (name === 'watch' || name === 'today preview') assert.equal(archive.sessions[KEY].periods.today.totalTokens, 12);
    else assert.equal(archive.sessions[KEY].periods.today.totalTokens, 100);
  });
}

test('confirmed ENOENT of an owned file archives the retained snapshot', (t) => {
  const sourcePath = path.join(temporaryDirectory(t), 'session.jsonl');
  fs.writeFileSync(sourcePath, '{}\n');
  const archive = captured(sourcePath);
  fs.unlinkSync(sourcePath);
  assert.equal(classifySessionSourcePath(sourcePath), 'missing');
  const { archive: next } = updateSessionUsageArchive(archive, summary(), LATER);
  const session = restored(summary(), next);
  assert.equal(next.sessions[KEY].sourceState, 'missing');
  assert.equal(session.archived, true);
  assert.equal(session.retained, undefined);
  assert.equal(session.totalTokens, 100);
  assert.equal(session.sourcePath, undefined);
});

test('readable nearest ancestor proves nested ENOENT; roots and relative paths do not', (t) => {
  const directory = temporaryDirectory(t);
  assert.equal(classifySessionSourcePath(path.join(directory, 'gone', 'session.jsonl')), 'missing');
  assert.equal(classifySessionSourcePath(directory), 'unknown', 'a discovery directory is not a file origin');
  assert.equal(classifySessionSourcePath(path.parse(directory).root), 'unknown');
  assert.equal(classifySessionSourcePath('session.jsonl'), 'unknown');
  assert.equal(classifySessionSourcePath(undefined), 'unknown');
});

for (const code of ['EACCES', 'EPERM', 'EIO']) {
  test(`${code} and unreadable ancestor keep source unknown`, (t) => {
    const sourcePath = path.join(temporaryDirectory(t), 'session.jsonl');
    assert.equal(classifySessionSourcePath(sourcePath, { lstatSync: () => { throw error(code); } }), 'unknown');
    assert.equal(classifySessionSourcePath(sourcePath, { accessSync: () => { throw error(code); } }), 'unknown');
    const { archive } = updateSessionUsageArchive(captured(sourcePath), summary(), LATER, {
      sourceStateDeps: { lstatSync: () => { throw error(code); } }
    });
    const session = restored(summary(), archive);
    assert.equal(session.archived, undefined);
    assert.equal(session.retained, true);
    assert.equal(session.sourceState, 'unknown');
    assert.equal(session.liveActivity, undefined);
  });
}

test('an existing file with no parsed usage is unknown and cannot zero the archive', (t) => {
  const sourcePath = path.join(temporaryDirectory(t), 'session.jsonl');
  fs.writeFileSync(sourcePath, '{}\n');
  assert.equal(classifySessionSourcePath(sourcePath), 'present');
  const { archive } = updateSessionUsageArchive(captured(sourcePath), summary(), LATER);
  assert.equal(archive.sessions[KEY].sourceState, 'unknown');
  assert.equal(restored(summary(), archive).totalTokens, 100);
  assert.equal(restored(summary(), archive).retained, true);
});

test('a returned source path without usage changes missing to unknown without clearing usage', (t) => {
  const sourcePath = path.join(temporaryDirectory(t), 'session.jsonl');
  const archive = captured(sourcePath);
  updateSessionUsageArchive(archive, summary(), LATER);
  assert.equal(archive.sessions[KEY].sourceState, 'missing');
  fs.writeFileSync(sourcePath, '{}\n');
  updateSessionUsageArchive(archive, summary(), new Date(LATER.getTime() + 1000));
  assert.equal(archive.sessions[KEY].sourceState, 'unknown');
  assert.equal(restored(summary(), archive).retained, true);
  assert.equal(archive.sessions[KEY].periods.allTime.totalTokens, 100);
});

test('symlink origins require a valid file target and a dangling link stays unknown', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'target.jsonl');
  const link = path.join(directory, 'session.jsonl');
  fs.writeFileSync(target, '{}\n');
  try { fs.symlinkSync(target, link); } catch (cause) {
    if (cause.code === 'EPERM') return t.skip('symlink creation is unavailable');
    throw cause;
  }
  assert.equal(classifySessionSourcePath(link), 'present');
  fs.unlinkSync(target);
  assert.equal(classifySessionSourcePath(link), 'unknown');
});

test('dangling ancestor symlinks retain unknown source state at every nesting depth', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'target');
  const link = path.join(directory, 'source');
  fs.mkdirSync(target);
  try { fs.symlinkSync(target, link, 'dir'); } catch (cause) {
    if (cause.code === 'EPERM') return t.skip('symlink creation is unavailable');
    throw cause;
  }
  fs.rmSync(target, { recursive: true });
  for (const parts of [['session.jsonl'], ['nested', 'session.jsonl'], ['a', 'b', 'session.jsonl']]) {
    const sourcePath = path.join(link, ...parts);
    assert.equal(classifySessionSourcePath(sourcePath), 'unknown');
    const { archive } = updateSessionUsageArchive(captured(sourcePath), summary(), LATER);
    assert.equal(archive.sessions[KEY].sourceState, 'unknown');
    const visible = restored(summary(), archive);
    assert.equal(visible.retained, true);
    assert.equal(visible.archived, undefined);
    assert.equal(visible.totalTokens, 100);
  }
});

test('a readable symlink ancestor still proves an absent owned file', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'target');
  const link = path.join(directory, 'source');
  fs.mkdirSync(target);
  try { fs.symlinkSync(target, link, 'dir'); } catch (cause) {
    if (cause.code === 'EPERM') return t.skip('symlink creation is unavailable');
    throw cause;
  }
  assert.equal(classifySessionSourcePath(path.join(link, 'gone', 'session.jsonl')), 'missing');
});

test('legacy archive rows without provenance retain usage without claiming deletion', () => {
  const archive = captured();
  delete archive.sessions[KEY].sourceState;
  delete archive.sessions[KEY].sourceObservedAt;
  archive.sessions[KEY].periods.allTime.archived = true;
  archive.sessions[KEY].periods.allTime.deleted = true;
  archive.sessions[KEY].periods.allTime.sourceDeleted = true;
  const session = restored(summary(), archive);
  assert.equal(session.retained, true);
  assert.equal(session.sourceState, 'unknown');
  assert.equal(session.archived, undefined);
  assert.equal(session.deleted, undefined);
  assert.equal(session.sourceDeleted, undefined);
});

test('older scans cannot overwrite source state, path or whole-ID correction', (t) => {
  const directory = temporaryDirectory(t);
  const sourcePath = path.join(directory, 'session.jsonl');
  const archive = captured(sourcePath);
  updateSessionUsageArchive(archive, summary(), LATER);
  const before = structuredClone(archive.sessions[KEY]);
  updateSessionUsageArchive(archive, summary({ [KEY]: row(250) }, {
    fullScan: true, presentKeys: [KEY], paths: { [KEY]: path.join(directory, 'other.jsonl') }
  }), NOW);
  assert.deepEqual(archive.sessions[KEY], before);
  updateSessionUsageArchive(archive, summary({ [KEY]: row(250) }, {
    fullScan: false, presentKeys: [KEY], paths: { [KEY]: path.join(directory, 'other.jsonl') }
  }), NOW);
  assert.deepEqual(archive.sessions[KEY], before);
});

test('a newer period frontier blocks source classification from an older scan', () => {
  const archive = captured();
  archive.sessions[KEY].periodWindows.month.capturedAt = new Date(LATER.getTime() + 1000).toISOString();
  const before = structuredClone(archive.sessions[KEY]);
  updateSessionUsageArchive(archive, summary(), LATER);
  assert.deepEqual(archive.sessions[KEY], before);
});

test('watch omission cannot reclassify an unscanned source as missing', (t) => {
  const sourcePath = path.join(temporaryDirectory(t), 'missing.jsonl');
  const archive = captured(sourcePath);
  updateSessionUsageArchive(archive, summary({}, { fullScan: false, presentKeys: [] }), LATER);
  assert.equal(archive.sessions[KEY].sourceState, 'present');
  assert.equal(restored(summary(), archive).sourceState, 'unknown');
  assert.equal(restored(summary(), archive).archived, undefined);
});

test('codexLocalSessionKeys never enter whole-ID corrections or source observations', () => {
  const key = 'codex:dots';
  const value = summary({ [key]: row(80, 'gpt', 'codex', 'dots') });
  value.codexLocalSessionKeys = [key];
  assert.deepEqual(updateSessionUsageArchive({}, value, NOW).archive.sessions, {});
  const archive = captureSessionUsageArchive({}, summary({ [key]: row(80, 'gpt', 'codex', 'dots') }), NOW);
  const before = structuredClone(archive.sessions[key]);
  const correction = summary({}, { fullScan: true, presentKeys: [key] });
  correction.codexLocalSessionKeys = [key];
  updateSessionUsageArchive(archive, correction, LATER);
  assert.deepEqual(archive.sessions[key], before);
});

test('resolver provenance stays in local metadata and never reaches published rows', (t) => {
  const sourcePath = path.join(temporaryDirectory(t), 'session.jsonl');
  fs.writeFileSync(sourcePath, '{"timestamp":"2026-10-10T08:00:00Z"}\n');
  const metadataCache = new Map();
  const periods = { allTime: normalizePeriod({ sessions: { [KEY]: row() } }) };
  applySessionMetadata(periods, os.homedir(), {
    metadataCache,
    sessionMetadataResolvers: new Map([['claude', { resolve: (_ids, context) =>
      new Map([['one', context.fileSessionMetadata('one', sourcePath)]]) }]])
  });
  assert.equal(metadataCache.get(KEY).sourcePath, sourcePath);
  assert.equal(periods.allTime.sessions[KEY].sourcePath, undefined);
  const value = summary({ [KEY]: row() }, { fullScan: true, presentKeys: [KEY], paths: { [KEY]: sourcePath } });
  const archive = captureSessionUsageArchive({}, value, NOW);
  const visible = applySessionUsageArchive(value, archive, { now: NOW });
  assert.equal(visible.sessionArchiveSource, undefined);
  assert.equal(JSON.stringify(visible).includes(sourcePath), false);
});

test('SQLite roundtrip retains zero correction, source evidence and absent-period frontiers', (t) => {
  const directory = temporaryDirectory(t);
  const options = { databasePath: path.join(directory, 'archive.sqlite'), path: path.join(directory, 'archive.json') };
  const sourcePath = path.join(directory, 'owned-session.jsonl');
  const store = createSessionUsageArchiveStore(options);
  const value = summary({ [KEY]: row() }, { fullScan: true, presentKeys: [KEY], paths: { [KEY]: sourcePath } });
  try {
    assert.equal(store.capture(value, NOW).error, null);
    assert.equal(store.capture(summary({}, { fullScan: true, presentKeys: [KEY] }), LATER).error, null);
  } finally {
    store.close();
  }
  const snapshot = readSessionUsageArchiveSnapshot(options);
  assert.equal(snapshot.sessions[KEY].periods.allTime.totalTokens, 0);
  assert.equal(snapshot.sessions[KEY].sourceState, 'present');
  assert.equal(snapshot.sessions[KEY].sourcePath, sourcePath);
  assert.equal(snapshot.sessions[KEY].sourceObservedAt, LATER.toISOString());
  assert.equal(snapshot.sessions[KEY].periodWindows.today.capturedAt, LATER.toISOString());
  const reopened = createSessionUsageArchiveStore(options);
  try {
    assert.equal(reopened.capture(value, NOW).error, null);
    assert.equal(reopened.refresh().sessions[KEY].periods.allTime.totalTokens, 0);
    assert.equal(reopened.capture(summary(), new Date(LATER.getTime() + 1000)).error, null);
    assert.equal(reopened.refresh().sessions[KEY].sourceState, 'missing');
  } finally {
    reopened.close();
  }
});


test('watch accepts a zero today reading without clearing month or allTime', () => {
  const value = summary({}, { fullScan: false, presentKeys: [] });
  value.today = period({ [KEY]: row(0) });
  const { archive } = updateSessionUsageArchive(captured(), value, LATER);
  assert.equal(archive.sessions[KEY].periods.today.totalTokens, 0);
  assert.equal(archive.sessions[KEY].periods.month.totalTokens, 100);
  assert.equal(archive.sessions[KEY].periods.allTime.totalTokens, 100);
  const visible = applySessionUsageArchive(value, archive, { now: LATER });
  assert.equal(visible.today.totalTokens, 0);
});

test('carried watch month and allTime rows cannot change confirmed missing source state', (t) => {
  const sourcePath = path.join(temporaryDirectory(t), 'session.jsonl');
  const archive = captured(sourcePath);
  updateSessionUsageArchive(archive, summary(), LATER);
  const value = summary({ [KEY]: row() }, { fullScan: false, presentKeys: [KEY] });
  value.today = period({});
  updateSessionUsageArchive(archive, value, new Date(LATER.getTime() + 1000));
  assert.equal(archive.sessions[KEY].sourceState, 'missing');
  assert.equal(archive.sessions[KEY].sourceObservedAt, LATER.toISOString());
});

test('an old explicit missing flag without owned provenance is unknown', () => {
  const archive = captured();
  archive.sessions[KEY].sourceState = 'missing';
  assert.equal(normalizeSessionUsageArchive(archive).sessions[KEY].sourceState, 'unknown');
  assert.equal(restored(summary(), archive).archived, undefined);
  assert.equal(restored(summary(), archive).retained, true);
});


test('a zero corrected split ID suppresses the old merged copy in every period', () => {
  const mergedKey = 'pi:split-one';
  const splitKey = 'omp:split-one';
  const archive = captureSessionUsageArchive({}, summary({ [mergedKey]: row(100, 'old', 'pi', 'split-one') }), NOW);
  const zero = summary({}, { fullScan: true, presentKeys: [splitKey] });
  updateSessionUsageArchive(archive, zero, LATER);
  const visible = applySessionUsageArchive(zero, archive, { now: LATER });
  for (const name of PERIODS) assert.equal(visible[name].totalTokens, 0);
});

test('a zero corrected Cursor identity suppresses its linked legacy event', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const key = `cursor:${id}`;
  const legacyId = 'cursor-active-2026-10-10T08:00:00.000Z';
  const legacyKey = `cursor:${legacyId}`;
  const archive = captureSessionUsageArchive({}, summary({
    [legacyKey]: row(100, 'old', 'cursor', legacyId),
    [key]: row(100, 'old', 'cursor', id)
  }), NOW);
  archive.sessions[legacyKey].supersededBy = key;
  const zero = summary({}, { fullScan: true, presentKeys: [key] });
  updateSessionUsageArchive(archive, zero, LATER);
  const visible = applySessionUsageArchive(zero, archive, { now: LATER });
  for (const name of PERIODS) assert.equal(visible[name].totalTokens, 0);
});


test('retained source/day rows are not live evidence and cannot overwrite archived usage', (t) => {
  const sourcePath = path.join(temporaryDirectory(t), 'gone.jsonl');
  const archive = captured(sourcePath);
  const value = summary({ [KEY]: { ...row(5), sourceState: 'missing', retained: true, archived: true } },
    { fullScan: true, presentKeys: [] });
  updateSessionUsageArchive(archive, value, LATER);
  assert.equal(archive.sessions[KEY].sourceState, 'missing');
  for (const name of PERIODS) assert.equal(archive.sessions[KEY].periods[name].totalTokens, 100);
});

test('source/day managed identities cannot be resurrected by session overlay', () => {
  const value = summary({}, { fullScan: true, presentKeys: [], managedKeys: [KEY] });
  const visible = applySessionUsageArchive(value, captured(), { now: LATER });
  for (const name of PERIODS) {
    assert.equal(visible[name].totalTokens, 0);
    assert.equal(visible[name].sessions[KEY], undefined);
  }
  assert.equal(visible.sessionArchiveSource, undefined);
});

test('managed zero split identity suppresses the merged copy without a canonical archive row', () => {
  const mergedKey = 'pi:split-one';
  const splitKey = 'omp:split-one';
  const archive = captureSessionUsageArchive({}, summary({ [mergedKey]: row(100, 'old', 'pi', 'split-one') }), NOW);
  const value = summary({}, { fullScan: true, presentKeys: [], managedKeys: [splitKey] });
  const visible = applySessionUsageArchive(value, archive, { now: LATER });
  assert.equal(archive.sessions[splitKey], undefined);
  for (const name of PERIODS) {
    assert.equal(visible[name].totalTokens, 0);
    assert.deepEqual(visible[name].sessions, {});
  }
});

test('managed zero Cursor identity suppresses a linked legacy event without a canonical archive row', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const key = `cursor:${id}`;
  const legacyId = 'cursor-active-2026-10-10T08:00:00.000Z';
  const legacyKey = `cursor:${legacyId}`;
  const archive = captureSessionUsageArchive({}, summary({ [legacyKey]: row(100, 'old', 'cursor', legacyId) }), NOW);
  archive.sessions[legacyKey].supersededBy = key;
  const value = summary({}, { fullScan: true, presentKeys: [], managedKeys: [key] });
  const visible = applySessionUsageArchive(value, archive, { now: LATER });
  assert.equal(archive.sessions[key], undefined);
  for (const name of PERIODS) {
    assert.equal(visible[name].totalTokens, 0);
    assert.deepEqual(visible[name].sessions, {});
  }
});

test('managed daily rows inherit descriptive archive metadata without replaying accounting or activity', () => {
  const metadata = { title: 'Retained title', projectId: 'project-app', projectLabel: 'app',
    sessionKind: 'background-review', lastUsedAt: LATER.toISOString(), turnEnded: false, contextTokens: 50, contextWindow: 100 };
  const archive = captureSessionUsageArchive({}, summary({ [KEY]: { ...row(100), ...metadata } }), NOW);
  const value = summary({ [KEY]: { ...row(5, 'projected'), retained: true, sourceState: 'unknown' } },
    { fullScan: true, presentKeys: [], managedKeys: [KEY] });
  const before = JSON.stringify(value);
  updateSessionUsageArchive(archive, value, LATER);
  const visible = applySessionUsageArchive(value, archive, { now: LATER });
  for (const name of PERIODS) {
    const session = visible[name].sessions[KEY];
    assert.equal(visible[name].totalTokens, 5);
    assert.equal(visible[name].costUsd, 0.05);
    assert.deepEqual(visible[name].models, { projected: 5 });
    assert.equal(session.title, metadata.title);
    assert.equal(session.projectId, metadata.projectId);
    assert.equal(session.projectLabel, metadata.projectLabel);
    assert.equal(session.sessionKind, metadata.sessionKind);
    assert.equal(session.retained, true);
    assert.equal(session.lastUsedAt, '');
    assert.equal(session.turnEnded, undefined);
    assert.equal(session.contextWindow, 0);
    assert.equal(archive.sessions[KEY].periods[name].totalTokens, 100);
  }
  assert.equal(JSON.stringify(value), before);
  const fresh = summary({ [KEY]: { ...row(2), title: 'Current title', projectId: 'other', projectLabel: 'other' } },
    { fullScan: true, presentKeys: [KEY], managedKeys: [KEY] });
  const current = applySessionUsageArchive(fresh, archive, { now: LATER }).allTime.sessions[KEY];
  assert.equal(current.title, 'Current title');
  assert.equal(current.projectId, 'other');
  assert.equal(current.projectLabel, 'other');
});

test('fresh native activity on retained accounting survives a live peer in either wire merge order', () => {
  const { serializeSyncPayload } = require('../../src/shared/syncPayload');
  const clock = Date.now();
  const capturedAt = new Date(clock - 1000);
  const archive = captureSessionUsageArchive({}, summary({ [KEY]: {
    ...row(100), lastUsedAt: capturedAt.toISOString(), turnEnded: false
  } }), capturedAt);
  const retained = applySessionUsageArchive(summary(), archive, { now: capturedAt });
  for (const name of PERIODS) retained[name].sessions[KEY].liveActivity = {
    state: 'waiting', observedAt: capturedAt.toISOString()
  };
  for (const activity of [undefined, { state: 'idle', observedAt: new Date(clock - 5000).toISOString() }]) {
    const live = summary({ [KEY]: { ...row(5), lastUsedAt: new Date(clock - 5000).toISOString(),
      ...(activity ? { liveActivity: activity } : {}) } });
    const devices = [retained, live].map((value, index) => serializeSyncPayload({
      ...value, deviceId: `source-${index}`, updatedAt: capturedAt.toISOString()
    }).payload);
    for (const ordered of [devices, [...devices].reverse()]) {
      const merged = aggregateDevices(ordered, 0, clock).periods.today.sessions[KEY];
      assert.equal(merged.totalTokens, 105);
      assert.equal(sessionActivityState(merged, clock), 'waiting');
      assert.equal(merged.liveActivity.observedAt, capturedAt.toISOString());
      assert.equal(merged.retained, undefined);
    }
  }
});

test('managed live corrections retain missing archive metadata while replacing every counter', () => {
  const archive = captureSessionUsageArchive({}, summary({ [KEY]: { ...row(100),
    title: 'Retained title', projectId: 'project-app', projectLabel: 'app' } }), NOW);
  const value = summary({ [KEY]: row(3, 'corrected') }, { fullScan: true, presentKeys: [KEY], managedKeys: [KEY] });
  updateSessionUsageArchive(archive, value, LATER);
  const visible = applySessionUsageArchive(value, archive, { now: LATER });
  for (const name of PERIODS) {
    assert.equal(visible[name].totalTokens, 3);
    assert.deepEqual(visible[name].models, { corrected: 3 });
    assert.equal(visible[name].sessions[KEY].title, 'Retained title');
    assert.equal(visible[name].sessions[KEY].projectId, 'project-app');
    assert.equal(archive.sessions[KEY].periods[name].totalTokens, 3);
  }
});

test('projected historical copies cannot replace live activity in merged periods or devices in either order', () => {
  const clock = Date.now();
  const capturedAt = new Date(clock - 1000);
  const key = 'codex:combined';
  const historical = { ...row(100, 'old', 'codex', 'combined'),
    lastUsedAt: capturedAt.toISOString(), turnEnded: false,
    contextTokens: 90, contextWindow: 100,
    promptCache: { observedAt: capturedAt.toISOString(), ttlSeconds: 300 } };
  const archive = captureSessionUsageArchive({}, summary({ [key]: historical }), capturedAt);
  const retained = applySessionUsageArchive(summary(), archive, { now: capturedAt });
  assert.equal(retained.allTime.sessions[key].retained, true);
  assert.equal(sessionActivityState(retained.allTime.sessions[key], clock), 'idle');
  archive.sessions[key].sourcePath = path.join(os.tmpdir(), 'missing-combined.jsonl');
  archive.sessions[key].sourceState = 'missing';
  const missing = applySessionUsageArchive(summary(), archive, { now: capturedAt });
  const missingOnly = aggregateDevices([{ ...missing, deviceId: 'missing', updatedAt: capturedAt.toISOString() }], 0, clock);
  assert.equal(missingOnly.periods.allTime.sessions[key].sourceState, 'missing');
  assert.equal(missingOnly.periods.allTime.sessions[key].archived, true);
  const base = { ...row(5, 'live', 'codex', 'combined'), sourceState: 'present' };
  const cases = [
    { ...base, lastUsedAt: new Date(clock - RUNNING_WINDOW_MS - 1000).toISOString() },
    { ...base, lastUsedAt: new Date(clock - 60_000).toISOString(), turnEnded: true, waitingForInput: false,
      liveActivity: { state: 'idle', observedAt: new Date(clock - 5000).toISOString() } },
    { ...base, lastUsedAt: new Date(clock - 60_000).toISOString(), turnEnded: true, waitingForInput: true,
      liveActivity: { state: 'waiting', observedAt: new Date(clock - 5000).toISOString() } }
  ];
  for (const liveRow of cases) {
    const live = summary({ [key]: liveRow });
    for (const ordered of [[live, retained], [retained, live], [live, missing], [missing, live]]) {
      const periodMerged = mergePeriods(...ordered.map(value => value.allTime)).sessions[key];
      const aggregate = aggregateDevices(ordered.map((value, index) => ({ ...value,
        deviceId: `device-${index}`, updatedAt: capturedAt.toISOString() })), 0, clock);
      for (const merged of [periodMerged, ...PERIODS.map(name => aggregate.periods[name].sessions[key])]) {
        assert.equal(merged.totalTokens, 105);
        assert.equal(merged.retained, undefined);
        assert.equal(merged.archived, undefined);
        assert.equal(merged.sourceState, 'present');
        assert.equal(merged.lastUsedAt, liveRow.lastUsedAt);
        assert.equal(merged.turnEnded, liveRow.turnEnded);
        assert.equal(merged.waitingForInput, liveRow.waitingForInput);
        assert.deepEqual(merged.liveActivity, liveRow.liveActivity);
        assert.equal(merged.promptCache, undefined);
        assert.equal(merged.contextWindow, 0);
        assert.equal(sessionActivityState(merged, clock), sessionActivityState(liveRow, clock));
      }
    }
  }
  assert.equal(retained.allTime.sessions[key].retained, true);
  assert.equal(retained.allTime.sessions[key].turnEnded, false);
});


test('a source returning during ancestor proof is present, not missing', (t) => {
  const sourcePath = path.join(temporaryDirectory(t), 'returned.jsonl');
  assert.equal(classifySessionSourcePath(sourcePath, {
    readdirSync: (directory) => {
      fs.writeFileSync(sourcePath, '{}\n');
      return fs.readdirSync(directory);
    }
  }), 'present');
});

test('full live reconciliation respects newer global prune frontiers', () => {
  const archive = captured();
  const nextMonth = new Date(2026, 10, 1, 12);
  updateSessionUsageArchive(archive, null, nextMonth);
  updateSessionUsageArchive(archive, summary({ [KEY]: row(25) }), LATER);
  assert.equal(archive.sessions[KEY].periods.today, undefined);
  assert.equal(archive.sessions[KEY].periods.month, undefined);
  assert.equal(archive.sessions[KEY].periods.allTime.totalTokens, 25);
});


test('Dots-owned keys cannot replay an older session archive contribution', () => {
  const key = 'codex:dots';
  const archive = captureSessionUsageArchive({}, summary({ [key]: row(80, 'gpt', 'codex', 'dots') }), NOW);
  const value = summary();
  value.codexLocalSessionKeys = [key];
  const visible = applySessionUsageArchive(value, archive, { now: LATER });
  for (const name of PERIODS) {
    assert.equal(visible[name].totalTokens, 0);
    assert.equal(visible[name].sessions[key], undefined);
  }
});
