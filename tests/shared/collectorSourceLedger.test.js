'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
const { captureSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const now = new Date('2026-10-11T04:00:00Z');

function optionsFor(t, clients = 'claude') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-ledger-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { clients, allTimeSince: '2026-01-01', deviceId: 'ledger-fixture', homeDir: directory,
    env: {}, wslScanEnabled: false, projectsEnabled: false, codexLocalUsageEnabled: false,
    includeHistory: true, dailyHistoryArchiveEnabled: true,
    getSessionUsageArchive: () => ({ version: 1, sessions: {} }),
    dailyHistoryArchiveOptions: { path: path.join(directory, 'daily.json') },
    sessionMetadataDeps: { resolveSessionMetadata: () => null } };
}

function graph(rows, clock, { clients = ['claude'], readStatus = 'complete', identityStatus = 'exact',
  fullHistory = true, version = 2, scopeId = digest('fixture-domain') } = {}) {
  const date = localTodayKey(clock);
  const contributions = rows.filter(row => row.tokens > 0).map(row => ({ date, clients: [{
    client: row.client || clients[0], modelId: 'fixture-model', providerId: 'fixture-provider',
    tokens: { input: row.tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: row.tokens / 100, messages: 1
  }] }));
  return { contributions, sourceUsage: { version, eventIdentityVersion: 2, fullHistory,
    capturedAt: clock.toISOString(), bucketTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, dayKey: date,
    replacementClients: clients, partialClients: readStatus === 'complete' ? [] : clients,
    scopes: [{ id: scopeId, clients, readStatus, identityStatus }], rowsWithoutIdentity: {},
    sessions: rows.map(row => ({ client: row.client || clients[0], sessionId: row.sessionId, scopeId,
      events: row.tokens === 0 ? [] : [{ id: digest(row.event || 'shared-response'), contributions: [{
        timestamp: now.getTime(), modelId: 'fixture-model', providerId: 'fixture-provider',
        tokens: { input: row.tokens, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: row.tokens / 100, messages: 1
      }] }] })) } };
}

function native(rows) {
  return async () => ({ entries: rows.filter(row => row.tokens > 0).map(row => ({
    client: row.client || 'claude', sessionId: row.sessionId, model: 'fixture-model', provider: 'fixture-provider',
    input: row.tokens, cost: row.tokens / 100
  })) });
}

function assertTotals(summary, tokens) {
  assert.equal(summary.allTime.totalTokens, tokens);
  assert.equal(summary.allTime.costUsd, tokens / 100);
  assert.equal(Object.values(summary.allTime.sessions).reduce((sum, row) => sum + row.totalTokens, 0), tokens);
  if (summary.history) assert.equal(summary.history.summary.totalTokens, tokens);
}

test('permanent ownership prevents A100 resurrection after B20 transfer, timezone change, fallback and reload', async t => {
  const priorTimezone = process.env.TZ;
  t.after(() => { if (priorTimezone === undefined) delete process.env.TZ; else process.env.TZ = priorTimezone; });
  process.env.TZ = 'Asia/Hong_Kong';
  const options = optionsFor(t);
  const a = [{ sessionId: 'A', tokens: 100 }];
  const b = [{ sessionId: 'B', tokens: 20 }];
  const initial = await collectUsageOnce({ ...options, now, runTokscale: native(a), runGraph: async () => graph(a, now) });
  assertTotals(initial, 100);
  // Keep the old generic archive deliberately unchanged: permanent ownership
  // must block it even when today's export cannot render an accepted revision.
  const legacy = captureSessionUsageArchive({}, initial, now);
  const correctedAt = new Date(now.getTime() + 1000);
  const corrected = await collectUsageOnce({ ...options, now: correctedAt, runTokscale: native(b), runGraph: async () => graph(b, correctedAt) });
  assertTotals(applySessionUsageArchive(corrected, legacy, { now: correctedAt }), 20);
  for (const [index, phase] of ['timezone', 'aggregate', 'unsupported', 'failed', 'reload'].entries()) {
    const clock = new Date(now.getTime() + 2000 + index * 1000);
    if (phase === 'timezone') process.env.TZ = 'America/Los_Angeles';
    const summary = await collectUsageOnce({ ...options, now: clock,
      includeHistory: phase !== 'reload', runTokscale: native(b), runGraph: async () => {
        if (phase === 'failed') throw new Error('read unavailable');
        if (phase === 'unsupported') return graph(b, clock, { version: 99 });
        return { contributions: graph(b, clock).contributions };
      } });
    assertTotals(summary, 20);
    const projected = applySessionUsageArchive(summary, legacy, { now: clock });
    assertTotals(projected, 20);
    assert.equal(projected.allTime.sessions['claude:A'], undefined, phase);
    const wire = serializeSyncPayload(projected).body;
    assert.equal(wire.includes(options.homeDir), false);
    assert.equal(wire.includes('sourceUsage'), false);
    assert.equal(wire.includes('sha256:'), false);
  }
});

for (const readStatus of ['partial', 'unknown']) {
  test(`${readStatus} read preserves45 until a complete authoritative15 correction`, async t => {
    const options = optionsFor(t, 'codex');
    const first = [{ client: 'codex', sessionId: 'turn-session', tokens: 45 }];
    const lower = [{ client: 'codex', sessionId: 'turn-session', tokens: 15 }];
    const initial = await collectUsageOnce({ ...options, now, runTokscale: native(first), runGraph: async () => graph(first, now, { clients: ['codex'] }) });
    assertTotals(initial, 45);
    const partialAt = new Date(now.getTime() + 1000);
    let anchor;
    let projection;
    const partial = await collectUsageOnce({ ...options, now: partialAt, runTokscale: native(lower),
      runGraph: async () => graph(lower, partialAt, { clients: ['codex'], readStatus }),
      onAnchorComputed: value => { anchor = value; }, onSourceArchiveComputed: value => { projection = value; } });
    assertTotals(partial, 45);
    const watch = await collectUsageOnce({ ...options, now: partialAt, includeHistory: false,
      sourceArchiveSnapshot: projection, todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: localTodayKey(partialAt),
        todayPartitions: anchor.todayPartitions, nativeRawPresence: anchor.nativeRawPresence }, runTokscale: native(lower) });
    assertTotals(watch, 45);
    const acceptedAt = new Date(now.getTime() + 2000);
    const accepted = await collectUsageOnce({ ...options, now: acceptedAt, runTokscale: native(lower),
      runGraph: async () => graph(lower, acceptedAt, { clients: ['codex'] }) });
    assertTotals(accepted, 15);
  });
}

test('MiMo shared-scope ownership transfer counts response once across raw CLI and Desktop IDs', async t => {
  const options = optionsFor(t, 'mimo');
  const clients = ['micode', 'micode-desktop'];
  const cli = [{ client: 'micode', sessionId: 'cli', tokens: 15 }];
  const desktop = [{ client: 'micode-desktop', sessionId: 'desktop', tokens: 15 }];
  const initial = await collectUsageOnce({ ...options, now, runTokscale: native(cli), runGraph: async () => graph(cli, now, { clients }) });
  assertTotals(initial, 15);
  const clock = new Date(now.getTime() + 1000);
  const transferred = await collectUsageOnce({ ...options, now: clock, runTokscale: native(desktop), runGraph: async () => graph(desktop, clock, { clients }) });
  assertTotals(transferred, 15);
  assert.equal(transferred.allTime.sessions['mimo:cli'], undefined);
  assert.equal(transferred.allTime.sessions['mimo:desktop'].totalTokens, 15);
});

test('explicit zero inventory remains owned and stale complete scans cannot restore old accounting', async t => {
  const options = optionsFor(t);
  const initialRows = [{ sessionId: 'A', tokens: 100 }];
  const initial = await collectUsageOnce({ ...options, now, runTokscale: native(initialRows), runGraph: async () => graph(initialRows, now) });
  const legacy = captureSessionUsageArchive({}, initial, now);
  const zeroAt = new Date(now.getTime() + 2000);
  const zeros = [{ sessionId: 'A', tokens: 0 }];
  const cleared = await collectUsageOnce({ ...options, now: zeroAt, runTokscale: native(zeros), runGraph: async () => graph(zeros, zeroAt) });
  assertTotals(applySessionUsageArchive(cleared, legacy, { now: zeroAt }), 0);
  const stale = await collectUsageOnce({ ...options, now: new Date(now.getTime() + 3000), runTokscale: native(initialRows),
    runGraph: async () => graph(initialRows, now) });
  assertTotals(applySessionUsageArchive(stale, legacy, { now: zeroAt }), 0);
});

test('cached App projection preserves one native Today scan and its exact watch delta', async t => {
  const options = optionsFor(t);
  let anchor;
  let projection;
  const rows = [{ sessionId: 'A', tokens: 20 }];
  await collectUsageOnce({ ...options, now, runTokscale: native(rows), runGraph: async () => graph(rows, now),
    onAnchorComputed: value => { anchor = value; }, onSourceArchiveComputed: value => { projection = value; } });
  let calls = 0;
  const watch = await collectUsageOnce({ ...options, now: new Date(now.getTime() + 1000), includeHistory: false,
    sourceArchiveSnapshot: projection, todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: localTodayKey(now),
      todayPartitions: anchor.todayPartitions, nativeRawPresence: anchor.nativeRawPresence },
    runTokscale: async args => {
      calls++;
      assert.deepEqual(args.flags, ['--today']);
      return native([{ sessionId: 'A', tokens: 25 }])();
    }, runGraph: async () => { throw new Error('watch must use the cached App projection'); } });
  assert.equal(calls, 1);
  for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 25);
});
