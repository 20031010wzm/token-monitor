'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collectUsageOnce, startCollector, localTodayKey, collectorAnchorTrust, configFingerprint } = require('../../src/shared/collector');
const { applySessionUsageArchive, updateSessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { applySourceDailyUsage } = require('../../src/shared/usage/sourceDailyUsage');
const { extractUsageBundleFromTokscale } = require('../../src/shared/usage');

function contribution(date, tokens, model = 'opus', cost = tokens / 100, client = 'claude') {
  return { date, clients: [{ client, modelId: model, tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }, cost, messages: 1 }] };
}

function sourceGraph(now, sessions, extra = {}) {
  sessions = sessions.map(row => ({ ...row, events: row.days.map((day, index) => ({
    id: `sha256:${createHash('sha256').update(`${row.client}:${row.sessionId}:${day.date}:${index}`).digest('hex')}`, days: [day]
  })) }));
  return { contributions: sessions.flatMap(row => row.days), sourceUsage: {
    version: 1, eventIdentityVersion: 1, fullHistory: true, capturedAt: now.toISOString(), bucketTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayKey: localTodayKey(now), replacementClients: ['claude'], sessions, ...extra
  } };
}

function optionsFor(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { clients: 'claude', allTimeSince: '2026-01-01', deviceId: 'source-fixture',
    homeDir: dir, env: {}, wslScanEnabled: false, projectsEnabled: false,
    codexLocalUsageEnabled: false, includeHistory: true, dailyHistoryArchiveEnabled: true,
    dailyHistoryArchiveOptions: { path: path.join(dir, 'daily.json') },
    sessionMetadataDeps: { resolveSessionMetadata: () => null } };
}

test('collector projects one graph snapshot into totals, history and subsequent watch anchor', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const yesterday = localTodayKey(new Date(2026, 9, 10, 12));
  let anchor;
  const summary = await collectUsageOnce({ ...options, now,
    runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 'a', model: 'opus', provider: 'anthropic', input: 900, cost: 9 }] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(yesterday, 20, 'sonnet', 0)] }]),
    onAnchorComputed: value => { anchor = value; }
  });
  assert.equal(summary.today.totalTokens, 0);
  assert.equal(summary.month.totalTokens, 20);
  assert.equal(summary.allTime.totalTokens, 20);
  assert.equal(summary.allTime.costUsd, 0);
  assert.deepEqual(summary.allTime.models, { sonnet: 20 });
  assert.equal(summary.history.summary.totalTokens, 20);
  assert.equal(anchor.windowsPeriods.today.totalTokens, 0);
  assert.equal(anchor.windowsPeriods.allTime.totalTokens, 20);
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false,
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: today, todayPartitions: anchor.todayPartitions },
    runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 'a', model: 'sonnet', provider: 'anthropic', input: 5, cost: 0 }] })
  });
  assert.equal(watch.today.totalTokens, 5);
  assert.equal(watch.allTime.totalTokens, 25);
});

test('source snapshot serialization restores omitted IDs exactly once through session archive transform', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  const date = localTodayKey(now);
  const first = await collectUsageOnce({ ...options, now,
    runTokscale: async () => ({ entries: [{ client: 'claude', sessionId: 'a', model: 'opus', provider: 'anthropic', input: 100, cost: 1 }] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(date, 100)] }])
  });
  const archive = updateSessionUsageArchive({}, first, now).archive;
  let anchor;
  const next = await collectUsageOnce({ ...options, now: new Date(now.getTime() + 60000),
    runTokscale: async () => ({ entries: [] }),
    runGraph: async () => sourceGraph(new Date(now.getTime() + 60000), []),
    onAnchorComputed: value => { anchor = value; }
  });
  assert.equal(next.allTime.totalTokens, 100);
  assert.equal(next.history.summary.totalTokens, 100);
  const projected = applySessionUsageArchive(next, archive, { now });
  assert.equal(projected.allTime.totalTokens, 100);
  assert.equal(projected.allTime.sessions['claude:a'].sourceState, 'unknown');
  assert.equal(projected.allTime.sessions['claude:a'].archived, undefined);
  assert.equal(anchor.windowsPeriods.allTime.totalTokens, 0);
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false,
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: date, todayPartitions: anchor.todayPartitions },
    runTokscale: async () => ({ entries: [] }) });
  assert.equal(watch.today.totalTokens, 100);
  assert.equal(watch.allTime.totalTokens, 100);
});

test('disabled clients cannot replay a persisted source archive', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  await collectUsageOnce({ ...options, now, runTokscale: async () => ({ entries: [] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(localTodayKey(now), 100)] }]) });
  const next = await collectUsageOnce({ ...options, clients: 'codex', now, includeHistory: false,
    runTokscale: async () => ({ entries: [] }) });
  assert.equal(next.allTime.totalTokens, 0);
  assert.deepEqual(next.sessionArchiveSource.managedKeys, []);
});

test('source projection preserves matching native throughput across multiple sessions', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  const days = [contribution(localTodayKey(now), 100)];
  days[0].clients[0].tokens = { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 };
  days[0].clients[0].providerId = 'anthropic';
  let anchor;
  const summary = await collectUsageOnce({ ...options, now,
    runTokscale: async () => ({ entries: ['a', 'b'].map(sessionId => ({ client: 'claude', sessionId,
      model: 'opus', provider: 'anthropic', input: 80, output: 20, cost: 1,
      performance: { timedTokens: 100, totalDurationMs: 1000 } })) }),
    runGraph: async () => sourceGraph(now, ['a', 'b'].map(sessionId => ({ client: 'claude', sessionId, days }))),
    onAnchorComputed: value => { anchor = value; }
  });
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(summary[name].timedDurationMs, 2000);
    assert.equal(summary[name].timedOutputTokens, 40);
    assert.equal(summary[name].timedTokens, 200);
    assert.equal(summary[name].modelThroughput.opus.timedDurationMs, 2000);
    assert.equal(summary[name].sessions['claude:a'].timedDurationMs, 1000);
    assert.deepEqual(summary[name].sessions['claude:a'].providers, { anthropic: 100 });
    assert.equal(anchor.windowsPeriods[name].timedDurationMs, 2000);
  }
});

test('a changed host timezone invalidates the persisted today delta anchor', t => {
  const prior = process.env.TZ;
  t.after(() => { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; });
  const now = new Date('2026-10-11T04:00:00Z');
  process.env.TZ = 'Asia/Hong_Kong';
  const period = { totalTokens: 10, sessions: {} };
  const saved = { dateKey: localTodayKey(now), today: period, month: period, allTime: period,
    configFingerprint: configFingerprint('claude', '2026-01-01'), fullScanAt: now.toISOString() };
  assert.ok(collectorAnchorTrust(saved, { now, clients: 'claude', allTimeSince: '2026-01-01' }));
  process.env.TZ = 'Asia/Tokyo';
  assert.equal(localTodayKey(now), saved.dateKey);
  assert.equal(collectorAnchorTrust(saved, { now, clients: 'claude', allTimeSince: '2026-01-01' }), null);
});

function nativeRow(sessionId, input, client = 'claude') {
  return { client, sessionId, model: 'opus', provider: 'anthropic', input, cost: input / 100 };
}

function anchorFrom(captured, now) {
  return { ...captured.windowsPeriods, dateKey: localTodayKey(now), todayPartitions: captured.todayPartitions,
    nativeRawPresence: captured.nativeRawPresence };
}

for (const failure of ['throw', 'no-source', 'stale']) {
  test(`${failure} graph preserves fresh native rows and retains only absent source IDs`, async t => {
    const options = optionsFor(t);
    const now = new Date(2026, 9, 11, 12);
    const date = localTodayKey(now);
    await collectUsageOnce({ ...options, now,
      runTokscale: async () => ({ entries: [nativeRow('a', 100), nativeRow('gone', 20)] }),
      runGraph: async () => sourceGraph(now, ['a', 'gone'].map(sessionId => ({ client: 'claude', sessionId,
        days: [contribution(date, sessionId === 'a' ? 100 : 20)] }))) });
    const later = new Date(now.getTime() + 60000);
    let captured;
    let cached;
    const rows = [nativeRow('a', 400), nativeRow('b', 50)];
    const summary = await collectUsageOnce({ ...options, now: later,
      runTokscale: async () => ({ entries: rows }),
      runGraph: async () => {
        if (failure === 'throw') throw new Error('graph timeout');
        if (failure === 'no-source') return { contributions: [] };
        return sourceGraph(new Date(now.getTime() - 60000), [{ client: 'claude', sessionId: 'a', days: [contribution(date, 5)] }]);
      },
      onAnchorComputed: value => { captured = value; },
      onSourceArchiveComputed: value => { cached = value; }
    });
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(summary[name].totalTokens, 470);
      assert.equal(summary[name].sessions['claude:a'].totalTokens, 400);
      assert.equal(summary[name].sessions['claude:b'].totalTokens, 50);
      assert.equal(summary[name].sessions['claude:gone'].sourceState, 'unknown');
      assert.equal(summary[name].sessions['claude:gone'].retained, true);
      assert.equal(summary[name].sessions['claude:gone'].archived, undefined);
      assert.equal(captured.windowsPeriods[name].totalTokens, 450);
    }
    for (let i = 0; i < 2; i++) {
      const watch = await collectUsageOnce({ ...options, now: later, includeHistory: false,
        sourceArchiveSnapshot: cached, todayOnlyAnchor: anchorFrom(captured, later),
        runTokscale: async () => ({ entries: [nativeRow('a', 410), nativeRow('b', 50)] }) });
      assert.equal(watch.today.totalTokens, 480);
      assert.equal(watch.allTime.totalTokens, 480);
    }
  });
}

test('fresh source replacement is scoped to the clients accepted from this graph scan', async t => {
  const options = { ...optionsFor(t), clients: 'claude,codex' };
  const now = new Date(2026, 9, 11, 12);
  const date = localTodayKey(now);
  await collectUsageOnce({ ...options, now, runTokscale: async () => ({ entries: [] }),
    runGraph: async () => sourceGraph(now, [{ client: 'codex', sessionId: 'x', days: [contribution(date, 70, 'opus', 0.7, 'codex')] }],
      { replacementClients: ['codex'] }) });
  const later = new Date(now.getTime() + 60000);
  let captured;
  const summary = await collectUsageOnce({ ...options, now: later,
    runTokscale: async () => ({ entries: [nativeRow('a', 900), nativeRow('x', 700, 'codex'), nativeRow('new', 30, 'codex')] }),
    runGraph: async () => sourceGraph(later, [{ client: 'claude', sessionId: 'a', days: [contribution(date, 10)] }]),
    onAnchorComputed: value => { captured = value; } });
  assert.equal(summary.allTime.totalTokens, 740);
  assert.equal(summary.allTime.sessions['codex:x'].totalTokens, 700);
  assert.equal(summary.allTime.sessions['codex:new'].totalTokens, 30);
  assert.equal(captured.windowsPeriods.allTime.totalTokens, 740);
});

for (const mismatch of ['zone', 'day']) {
  test(`${mismatch} bucket mismatch rejects live and retained source projection on full and watch ticks`, async t => {
    const options = optionsFor(t);
    const now = new Date(2026, 9, 11, 1);
    const today = localTodayKey(now);
    const yesterday = localTodayKey(new Date(2026, 9, 10, 12));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const extra = mismatch === 'zone' ? { bucketTimezone: zone === 'UTC' ? 'Asia/Tokyo' : 'UTC' } : { dayKey: yesterday };
    let captured;
    let cached;
    const full = await collectUsageOnce({ ...options, now,
      runTokscale: async () => ({ entries: [nativeRow('a', 100)] }),
      runGraph: async () => sourceGraph(now, ['a', 'gone'].map(sessionId => ({ client: 'claude', sessionId,
        days: [contribution(yesterday, sessionId === 'a' ? 100 : 50)] })), extra),
      onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(full[name].totalTokens, 100);
      assert.equal(captured.windowsPeriods[name].totalTokens, 100);
    }
    assert.deepEqual(full.sessionArchiveSource.managedKeys, []);
    for (const cachedSource of [undefined, cached]) {
      const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cachedSource,
        todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: [nativeRow('a', 110)] }) });
      for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 110);
      assert.deepEqual(watch.sessionArchiveSource.managedKeys, []);
    }
    assert.equal(captured.windowsPeriods.today.totalTokens, 100, today);
  });
}

test('an absent source reappearing on watch adds only past days missing from each native anchor', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const yesterday = localTodayKey(new Date(2026, 9, 10, 12));
  await collectUsageOnce({ ...options, now,
    runTokscale: async ({ flags }) => ({ entries: [nativeRow('a', flags.includes('--today') ? 20 : 120)] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(yesterday, 100), contribution(today, 20)] }]) });
  const later = new Date(now.getTime() + 60000);
  let captured;
  let cached;
  const absent = await collectUsageOnce({ ...options, now: later, runTokscale: async () => ({ entries: [] }),
    runGraph: async () => sourceGraph(later, []), onAnchorComputed: value => { captured = value; },
    onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(absent.allTime.totalTokens, 120);
  assert.equal(captured.windowsPeriods.allTime.totalTokens, 0);
  for (const tokens of [20, 25, 25]) {
    let calls = 0;
    const watch = await collectUsageOnce({ ...options, now: later, includeHistory: false, sourceArchiveSnapshot: cached,
      todayOnlyAnchor: anchorFrom(captured, later), runTokscale: async ({ flags }) => {
        calls++;
        assert.deepEqual(flags, ['--today']);
        return { entries: [nativeRow('a', tokens)] };
      } });
    assert.equal(calls, 1);
    assert.equal(watch.today.totalTokens, tokens);
    assert.equal(watch.month.totalTokens, 100 + tokens);
    assert.equal(watch.allTime.totalTokens, 100 + tokens);
    assert.equal(watch.allTime.sessions['claude:a'].retained, undefined);
  }
});

test('period presence is independent when allTimeSince excludes a live month session', async t => {
  const options = { ...optionsFor(t), allTimeSince: '2026-10-08' };
  const now = new Date(2026, 9, 11, 12);
  let captured;
  let cached;
  const full = await collectUsageOnce({ ...options, now,
    runTokscale: async ({ flags }) => ({ entries: flags.includes('--month') ? [nativeRow('a', 100)] : [] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution('2026-10-03', 100)] }]),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(full.month.totalTokens, 100);
  assert.equal(full.allTime.totalTokens, 0);
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cached,
    todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: [] }) });
  assert.equal(watch.today.totalTokens, 0);
  assert.equal(watch.month.totalTokens, 100);
  assert.equal(watch.allTime.totalTokens, 0);
});

test('source replay cannot undo a watch correction that removes the last native Today row', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  let captured;
  let cached;
  await collectUsageOnce({ ...options, now, runTokscale: async () => ({ entries: [nativeRow('a', 100)] }),
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(localTodayKey(now), 100)] }]),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cached,
    todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: [] }) });
  for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 0);
});

test('canonical source aliases share native presence and watch accounting keys', async t => {
  const options = { ...optionsFor(t), clients: 'claude,kimi' };
  const now = new Date(2026, 9, 11, 12);
  let captured;
  let cached;
  const rows = [nativeRow('m', 100, 'cc-mirror/kimi-code')];
  const full = await collectUsageOnce({ ...options, now, runTokscale: async () => ({ entries: rows }),
    runGraph: async () => sourceGraph(now, [{ client: 'cc-mirror/kimi-code', sessionId: 'm',
      days: [contribution(localTodayKey(now), 100, 'opus', 1, 'cc-mirror/kimi-code')] }], { replacementClients: ['claude', 'kimi'] }),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(full.allTime.totalTokens, 100);
  assert.deepEqual(full.sessionArchiveSource.managedKeys, ['kimi:m']);
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cached,
    todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: rows }) });
  assert.equal(watch.allTime.totalTokens, 100);
  assert.deepEqual(Object.keys(watch.allTime.sessions), ['kimi:m']);
});

test('source replacement preserves complete metadata on untouched native periods and anchors', async t => {
  const now = new Date(2026, 9, 11, 12);
  const metadata = { title: 'Codex title', startedAt: new Date(now.getTime() - 60000).toISOString(), lastUsedAt: now.toISOString(),
    contextTokens: 123, contextWindow: 1000, turnEnded: true, waitingForInput: true,
    promptCache: { ttlSeconds: 300, observedAt: now.toISOString() } };
  const options = { ...optionsFor(t), clients: 'claude,codex', sessionMetadataDeps: {
    sessionMetadataResolvers: new Map([['codex', { resolve: ids => new Map([...ids].map(id => [id, metadata])) }]])
  } };
  const runTokscale = async ({ flags }) => ({ entries: [nativeRow('a', 100),
    ...(!flags.includes('--today') ? [nativeRow('old', 70, 'codex')] : [])] });
  const baseline = await collectUsageOnce({ ...options, now, includeHistory: false, dailyHistoryArchiveEnabled: false, runTokscale });
  let captured;
  const full = await collectUsageOnce({ ...options, now, runTokscale,
    runGraph: async () => sourceGraph(now, [{ client: 'claude', sessionId: 'a', days: [contribution(localTodayKey(now), 100)] }]),
    onAnchorComputed: value => { captured = value; } });
  for (const name of ['month', 'allTime']) {
    assert.equal(baseline[name].sessions['codex:old'].contextTokens, 123);
    assert.equal(baseline[name].sessions['codex:old'].waitingForInput, true);
    assert.deepEqual(baseline[name].sessions['codex:old'].promptCache, metadata.promptCache);
    assert.deepEqual(full[name].sessions['codex:old'], baseline[name].sessions['codex:old']);
    assert.deepEqual(captured.windowsPeriods[name].sessions['codex:old'], baseline[name].sessions['codex:old']);
  }
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false,
    todayOnlyAnchor: anchorFrom(captured, now), runTokscale });
  assert.deepEqual(watch.allTime.sessions['codex:old'], baseline.allTime.sessions['codex:old']);
});

for (const deferLiveHistoryCapture of [false, true]) {
  test(`a legacy daily archive caches the absence of source snapshots (deferred live capture: ${deferLiveHistoryCapture})`, async t => {
    const options = optionsFor(t);
    const now = new Date(2026, 9, 11, 12);
    const archivePath = options.dailyHistoryArchiveOptions.path;
    fs.writeFileSync(archivePath, JSON.stringify({ version: 1, days: {} }));
    const originalRead = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (file, ...args) {
      if (String(file) === archivePath) reads++;
      return originalRead.call(this, file, ...args);
    };
    t.after(() => { fs.readFileSync = originalRead; });
    let cached;
    for (let i = 0; i < 5; i++) {
      await collectUsageOnce({ ...options, now, includeHistory: false, deferLiveHistoryCapture,
        sourceArchiveSnapshot: cached, onSourceArchiveComputed: value => { cached = value; },
        runTokscale: async () => ({ entries: deferLiveHistoryCapture ? [nativeRow('a', 100)] : [] }) });
    }
    assert.deepEqual(cached, { version: 1, sessions: [] });
    assert.equal(reads, 1);
  });
}

for (const reason of ['partial', 'stale']) {
  test(`a ${reason} raw alias cannot promote its canonical native partition to replacement authority`, () => {
    const now = new Date(2026, 9, 11, 12);
    const today = localTodayKey(now);
    const metadata = { capturedAt: now.toISOString(), bucketTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dayKey: today, replacementAuthority: true };
    const rows = [nativeRow('a', 500, 'devin-cli'), nativeRow('b', 50, 'devin-desktop')];
    const nativePeriods = {};
    const nativePartitions = {};
    const summary = { sessionArchiveSource: { presentKeys: ['devin:a', 'devin:b'] } };
    for (const name of ['today', 'month', 'allTime']) {
      const bundle = extractUsageBundleFromTokscale({ entries: rows });
      nativePeriods[name] = summary[name] = bundle.period;
      nativePartitions[name] = bundle.byClient;
    }
    const sourceUsage = { version: 1, clients: reason === 'partial' ? ['devin-cli'] : ['devin-cli', 'devin-desktop'],
      unresolvedClients: reason === 'partial' ? ['devin-desktop'] : [],
      sourceSnapshots: { 'devin-cli': metadata, 'devin-desktop': { ...metadata,
        ...(reason === 'partial' ? { replacementAuthority: false, reason: 'partial-client-scope' }
          : { capturedAt: new Date(now.getTime() - 60000).toISOString() }) } },
      sessions: ['a', 'gone'].map(sessionId => ({ ...metadata, client: 'devin-cli', sessionId, sourceState: 'present',
        days: [contribution(today, sessionId === 'a' ? 5 : 20, 'opus', undefined, 'devin-cli')] })) };
    applySourceDailyUsage(summary, sourceUsage, { todayKey: today, allTimeSince: '2026-01-01', clients: 'devin',
      replaceLive: true, sourceClients: ['devin-cli'], nativePeriods, nativePartitions });
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(summary[name].totalTokens, 570);
      assert.equal(summary[name].sessions['devin:a'].totalTokens, 500);
      assert.equal(summary[name].sessions['devin:b'].totalTokens, 50);
      assert.equal(summary[name].sessions['devin:gone'].sourceState, 'unknown');
      assert.equal(nativePeriods[name].totalTokens, 550);
    }
  });
}

for (const [cliId, desktopId] of [['a', 'b'], ['shared', 'shared']]) {
test(`collector projects independent raw source clients into one canonical partition (${cliId}/${desktopId})`, async t => {
  const options = { ...optionsFor(t), clients: 'devin' };
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const nativeRows = [nativeRow(cliId, 300, 'devin-cli'), nativeRow(desktopId, 700, 'devin-desktop')];
  let captured;
  let cached;
  const full = await collectUsageOnce({ ...options, now, runTokscale: async () => ({ entries: nativeRows }),
    runGraph: async () => sourceGraph(now, [
      { client: 'devin-cli', sessionId: cliId, days: [contribution(today, 30, 'opus', 0.3, 'devin-cli')] },
      { client: 'devin-desktop', sessionId: desktopId, days: [contribution(today, 70, 'opus', 0.7, 'devin-desktop')] }
    ], { replacementClients: ['devin-cli', 'devin-desktop'] }),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(full[name].totalTokens, 100);
    assert.equal(full[name].sessions[`devin:${cliId}`].totalTokens, cliId === desktopId ? 100 : 30);
    assert.equal(full[name].sessions[`devin:${desktopId}`].totalTokens, cliId === desktopId ? 100 : 70);
  }
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cached,
    todayOnlyAnchor: anchorFrom(captured, now),
    runTokscale: async () => ({ entries: [nativeRow(cliId, 35, 'devin-cli'), nativeRow(desktopId, 70, 'devin-desktop')] }) });
  assert.equal(watch.allTime.totalTokens, 105);
});
}

test('partial antigravity-extension scope cannot suppress an authoritative CLI source correction', async t => {
  const options = { ...optionsFor(t), clients: 'antigravity', runAntigravitySync: async () => {} };
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  let captured;
  let cached;
  const full = await collectUsageOnce({ ...options, now,
    runTokscale: async () => ({ entries: [nativeRow('cli', 900, 'antigravity-cli'), nativeRow('extension', 20, 'antigravity-extension')] }),
    runGraph: async () => sourceGraph(now, [
      { client: 'antigravity-cli', sessionId: 'cli', days: [contribution(today, 30, 'opus', 0.3, 'antigravity-cli')] },
      { client: 'antigravity-extension', sessionId: 'extension', days: [contribution(today, 5, 'opus', 0.05, 'antigravity-extension')] }
    ], { replacementClients: ['antigravity-cli'], partialClients: ['antigravity-extension'] }),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(cached.sourceSnapshots['antigravity-cli'].replacementAuthority, true);
  assert.equal(cached.sourceSnapshots['antigravity-extension'].replacementAuthority, false);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(full[name].totalTokens, 50);
    assert.equal(full[name].sessions['antigravity:cli'].totalTokens, 30);
    assert.equal(full[name].sessions['antigravity:extension'].totalTokens, 20);
    assert.equal(captured.windowsPeriods[name].totalTokens, 50);
  }
  const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot: cached,
    todayOnlyAnchor: anchorFrom(captured, now),
    runTokscale: async () => ({ entries: [nativeRow('cli', 35, 'antigravity-cli'), nativeRow('extension', 25, 'antigravity-extension')] }) });
  assert.equal(watch.allTime.totalTokens, 60);
});

test('identified retained IDs survive an unresolved residual without acquiring native replacement authority', () => {
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const metadata = { capturedAt: now.toISOString(), bucketTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dayKey: today, replacementAuthority: false, projectIdentified: true };
  const nativePeriods = {};
  const nativePartitions = {};
  const summary = { sessionArchiveSource: { presentKeys: ['claude:a'] } };
  for (const name of ['today', 'month', 'allTime']) {
    const bundle = extractUsageBundleFromTokscale({ entries: [nativeRow('a', 500)] });
    nativePeriods[name] = summary[name] = bundle.period;
    nativePartitions[name] = bundle.byClient;
  }
  applySourceDailyUsage(summary, { version: 1, clients: [], unresolvedClients: ['claude'],
    sourceSnapshots: { claude: metadata }, sessions: ['a', 'gone'].map(sessionId => ({ ...metadata, client: 'claude', sessionId,
      sourceState: 'present', days: [contribution(today, sessionId === 'a' ? 5 : 20)] }))
  }, { todayKey: today, allTimeSince: '2026-01-01', clients: 'claude', replaceLive: true,
    sourceClients: ['claude'], nativePeriods, nativePartitions });
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(summary[name].totalTokens, 520);
    assert.equal(summary[name].sessions['claude:a'].totalTokens, 500);
    assert.equal(summary[name].sessions['claude:gone'].sourceState, 'unknown');
    assert.equal(summary[name].sessions['claude:gone'].liveActivity, undefined);
    assert.equal(nativePeriods[name].totalTokens, 500);
  }
});

for (const [cliId, desktopId] of [['old', 'live'], ['shared', 'shared']]) {
  test(`omitted raw source ID survives cached and disk watch projection (${cliId}/${desktopId})`, async t => {
    const options = { ...optionsFor(t), clients: 'devin' };
    const now = new Date(2026, 9, 11, 12);
    const today = localTodayKey(now);
    const cli = { client: 'devin-cli', sessionId: cliId, days: [contribution(today, 100, 'opus', 1, 'devin-cli')] };
    const desktop = { client: 'devin-desktop', sessionId: desktopId, days: [contribution(today, 5, 'opus', 0.05, 'devin-desktop')] };
    await collectUsageOnce({ ...options, now,
      runTokscale: async () => ({ entries: [nativeRow(cliId, 100, 'devin-cli'), nativeRow(desktopId, 5, 'devin-desktop')] }),
      runGraph: async () => sourceGraph(now, [cli, desktop], { replacementClients: ['devin-cli', 'devin-desktop'] }) });
    const later = new Date(now.getTime() + 60000);
    let captured;
    let cached;
    const full = await collectUsageOnce({ ...options, now: later,
      runTokscale: async () => ({ entries: [nativeRow(desktopId, 5, 'devin-desktop')] }),
      runGraph: async () => sourceGraph(later, [desktop], { replacementClients: ['devin-cli', 'devin-desktop'] }),
      onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
    assert.equal(full.history.summary.totalTokens, 105);
    assert.equal(cached.sessions.find(row => row.client === 'devin-cli').sourceState, 'unknown');
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(full[name].totalTokens, 105);
      assert.equal(captured.windowsPeriods[name].totalTokens, 5);
      assert.deepEqual(captured.nativeRawPresence[name], [`devin-desktop:${desktopId}`]);
    }
    const anchor = JSON.parse(JSON.stringify(anchorFrom(captured, later)));
    for (const sourceArchiveSnapshot of [cached, undefined, cached]) {
      let scans = 0;
      const watch = await collectUsageOnce({ ...options, now: later, includeHistory: false, sourceArchiveSnapshot,
        todayOnlyAnchor: anchor,
        runTokscale: async ({ flags }) => {
          scans++;
          assert.deepEqual(flags, ['--today']);
          return { entries: [nativeRow(desktopId, 5, 'devin-desktop')] };
        } });
      assert.equal(scans, 1);
      for (const name of ['today', 'month', 'allTime']) {
        assert.equal(watch[name].totalTokens, 105);
        assert.equal(watch[name].sessions[`devin:${cliId}`].totalTokens, cliId === desktopId ? 105 : 100);
        assert.equal(watch[name].sessions[`devin:${desktopId}`].totalTokens, cliId === desktopId ? 105 : 5);
      }
    }
  });
}

test('collector persists raw native presence across restart and targeted watch ticks', async t => {
  const options = { ...optionsFor(t), clients: 'devin,claude', watchEnabled: false, sessionActivityPolling: false,
    intervalMs: 60 * 60 * 1000, limitsEnabled: false };
  const priorDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = options.homeDir;
  let handle;
  t.after(async () => {
    handle?.stop();
    await handle?.whenIdle();
    if (priorDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = priorDir;
  });
  const now = new Date();
  const today = localTodayKey(now);
  const cli = { client: 'devin-cli', sessionId: 'shared', days: [contribution(today, 100, 'opus', 1, 'devin-cli')] };
  const desktop = { client: 'devin-desktop', sessionId: 'shared', days: [contribution(today, 5, 'opus', 0.05, 'devin-desktop')] };
  let omitted = false;
  let scans = [];
  const updates = [];
  const runtimeOptions = { ...options, now,
    runTokscale: async ({ clients, flags }) => {
      scans.push({ clients, flags });
      const requested = new Set(clients.split(','));
      return { entries: [
        ...(requested.has('devin') ? [
          ...(!omitted ? [nativeRow('shared', 100, 'devin-cli')] : []), nativeRow('shared', 5, 'devin-desktop')
        ] : []), ...(requested.has('claude') ? [nativeRow('c', 3)] : [])
      ] };
    },
    runGraph: async () => sourceGraph(now, [...(!omitted ? [cli] : []), desktop,
      { client: 'claude', sessionId: 'c', days: [contribution(today, 3)] }
    ], { replacementClients: ['devin-cli', 'devin-desktop', 'claude'] }),
    onUpdate: summary => { updates.push(summary); }, onError: error => { throw error; } };
  handle = startCollector(runtimeOptions);
  await handle.whenIdle();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].allTime.totalTokens, 108);
  omitted = true;
  await handle.tick('manual', { forceHistory: true });
  assert.equal(updates.at(-1).allTime.totalTokens, 108);
  handle.stop();
  await handle.whenIdle();
  const saved = JSON.parse(fs.readFileSync(path.join(options.homeDir, 'collector-anchor.json'), 'utf8'));
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(saved[name].totalTokens, 8);
    assert.deepEqual(saved.nativeRawPresence[name].sort(), ['claude:c', 'devin-desktop:shared']);
  }
  scans = [];
  handle = startCollector({ ...runtimeOptions, historyEnabled: false,
    runGraph: async () => { throw new Error('restart must use the persisted source archive'); } });
  await handle.whenIdle();
  assert.equal(scans.length, 1);
  assert.deepEqual(scans[0].flags, ['--today']);
  assert.equal(updates.at(-1).allTime.totalTokens, 108);
  for (const client of ['claude', 'devin', 'claude']) {
    const priorScans = scans.length;
    await handle.refreshClient(client);
    assert.equal(scans.length, priorScans + 1);
    assert.deepEqual(scans.at(-1), { clients: client, flags: ['--today'] });
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(updates.at(-1)[name].totalTokens, 108);
      assert.equal(updates.at(-1)[name].sessions['devin:shared'].totalTokens, 105);
    }
  }
  handle.stop();
  await handle.whenIdle();
  delete saved.nativeRawPresence;
  fs.writeFileSync(path.join(options.homeDir, 'collector-anchor.json'), JSON.stringify(saved));
  scans = [];
  handle = startCollector({ ...runtimeOptions, historyEnabled: false });
  await handle.whenIdle();
  assert.equal(scans.length, 3, 'an old canonical-only anchor must rebuild raw presence once');
  assert.equal(updates.at(-1).allTime.totalTokens, 108);
});

test('a returning raw alias adds its past days even when a canonical sibling was already native', async t => {
  const options = { ...optionsFor(t), clients: 'devin' };
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const yesterday = localTodayKey(new Date(2026, 9, 10, 12));
  const cli = { client: 'devin-cli', sessionId: 'shared', days: [contribution(yesterday, 100, 'opus', 1, 'devin-cli')] };
  const desktop = { client: 'devin-desktop', sessionId: 'shared', days: [contribution(today, 5, 'opus', 0.05, 'devin-desktop')] };
  await collectUsageOnce({ ...options, now, runTokscale: async ({ flags }) => ({ entries: [
    ...(!flags.includes('--today') ? [nativeRow('shared', 100, 'devin-cli')] : []), nativeRow('shared', 5, 'devin-desktop')
  ] }), runGraph: async () => sourceGraph(now, [cli, desktop], { replacementClients: ['devin-cli', 'devin-desktop'] }) });
  const later = new Date(now.getTime() + 60000);
  let captured;
  let cached;
  const full = await collectUsageOnce({ ...options, now: later,
    runTokscale: async () => ({ entries: [nativeRow('shared', 5, 'devin-desktop')] }),
    runGraph: async () => sourceGraph(later, [desktop], { replacementClients: ['devin-cli', 'devin-desktop'] }),
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(full.today.totalTokens, 5);
  assert.equal(full.allTime.totalTokens, 105);
  const anchor = anchorFrom(captured, later);
  for (const amount of [20, 25, 25]) {
    const watch = await collectUsageOnce({ ...options, now: later, includeHistory: false, sourceArchiveSnapshot: cached,
      todayOnlyAnchor: anchor, runTokscale: async () => ({ entries: [
        nativeRow('shared', amount, 'devin-cli'), nativeRow('shared', 5, 'devin-desktop')
      ] }) });
    assert.equal(watch.today.totalTokens, amount + 5);
    for (const name of ['month', 'allTime']) {
      assert.equal(watch[name].totalTokens, amount + 105);
      assert.equal(watch[name].sessions['devin:shared'].totalTokens, amount + 105);
    }
  }
});

for (const graphSucceeds of [true, false]) {
  test(`prior-day omitted source rows survive midnight (graph succeeds: ${graphSucceeds})`, async t => {
    const options = optionsFor(t);
    const yesterday = new Date(2026, 9, 10, 12);
    const now = new Date(2026, 9, 11, 12);
    const yesterdayKey = localTodayKey(yesterday);
    const today = localTodayKey(now);
    await collectUsageOnce({ ...options, now: yesterday,
      runTokscale: async () => ({ entries: [nativeRow('a', 100)] }),
      runGraph: async () => sourceGraph(yesterday, [{ client: 'claude', sessionId: 'a', days: [contribution(yesterdayKey, 100)] }]) });
    let captured;
    let cached;
    const full = await collectUsageOnce({ ...options, now,
      runTokscale: async () => ({ entries: [] }), runGraph: async () => {
        if (!graphSucceeds) throw new Error('graph failed after midnight');
        return sourceGraph(now, []);
      }, onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
    assert.equal(cached.sessions[0].dayKey, yesterdayKey, 'omission preserves the original entry capture metadata');
    assert.equal(cached.sourceSnapshots.claude.dayKey, graphSucceeds ? today : yesterdayKey);
    assert.equal(full.history.summary.totalTokens, 100);
    assert.equal(full.today.totalTokens, 0);
    for (const name of ['month', 'allTime']) {
      assert.equal(full[name].totalTokens, 100);
      assert.equal(full[name].sessions['claude:a'].sourceState, 'unknown');
      assert.equal(captured.windowsPeriods[name].totalTokens, 0);
    }
    for (const sourceArchiveSnapshot of [cached, undefined]) {
      const retained = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot,
        todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: [] }) });
      assert.equal(retained.today.totalTokens, 0);
      assert.equal(retained.month.totalTokens, 100);
      assert.equal(retained.allTime.totalTokens, 100);
      const watch = await collectUsageOnce({ ...options, now, includeHistory: false, sourceArchiveSnapshot,
        todayOnlyAnchor: anchorFrom(captured, now), runTokscale: async () => ({ entries: [nativeRow('a', 5)] }) });
      assert.equal(watch.today.totalTokens, 5);
      assert.equal(watch.month.totalTokens, 105);
      assert.equal(watch.allTime.totalTokens, 105);
    }
  });
}

test('actual unresolved daily export retains omitted exact IDs without native replacement', async t => {
  const options = optionsFor(t);
  const now = new Date(2026, 9, 11, 12);
  const today = localTodayKey(now);
  const first = await collectUsageOnce({ ...options, now,
    runTokscale: async () => ({ entries: [nativeRow('a', 100), nativeRow('b', 50)] }),
    runGraph: async () => sourceGraph(now, ['a', 'b'].map(sessionId => ({ client: 'claude', sessionId,
      days: [contribution(today, sessionId === 'a' ? 100 : 50)] }))) });
  const sessionArchive = updateSessionUsageArchive({}, first, now).archive;
  const later = new Date(now.getTime() + 60000);
  const graph = sourceGraph(later, [{ client: 'claude', sessionId: 'a', days: [contribution(today, 40)] }]);
  graph.sourceUsage.sessions[0].events = [
    { id: graph.sourceUsage.sessions[0].events[0].id, days: [contribution(today, 30)] },
    { id: null, days: [contribution(today, 10)] }
  ];
  let captured;
  let cached;
  const full = await collectUsageOnce({ ...options, now: later,
    runTokscale: async () => ({ entries: [nativeRow('a', 40)] }), runGraph: async () => graph,
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(cached.sourceSnapshots.claude.replacementAuthority, false);
  assert.equal(cached.sourceSnapshots.claude.projectIdentified, true);
  assert.deepEqual(cached.clients, []);
  assert.ok(cached.sessions.some(row => row.sessionId === 'b'), 'actual archive export must include the omitted exact ID');
  assert.equal(full.history.summary.totalTokens, 90);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(full[name].totalTokens, 90);
    assert.equal(full[name].sessions['claude:a'].totalTokens, 40);
    assert.equal(full[name].sessions['claude:b'].totalTokens, 50);
    assert.equal(full[name].sessions['claude:b'].sourceState, 'unknown');
    assert.equal(captured.windowsPeriods[name].totalTokens, 40);
  }
  for (const sourceArchiveSnapshot of [cached, undefined]) {
    const watch = await collectUsageOnce({ ...options, now: later, includeHistory: false, sourceArchiveSnapshot,
      todayOnlyAnchor: anchorFrom(captured, later), runTokscale: async () => ({ entries: [nativeRow('a', 40)] }) });
    for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 90);
  }
  const newest = new Date(later.getTime() + 60000);
  const moved = sourceGraph(newest, [
    { client: 'claude', sessionId: 'a', days: [contribution(today, 10)] },
    { client: 'claude', sessionId: 'new', days: [contribution(today, 2)] }
  ]);
  moved.sourceUsage.sessions[0].events[0].id = null;
  moved.sourceUsage.sessions[1].events[0].id = graph.sourceUsage.sessions[0].events[0].id;
  const nativeRows = [nativeRow('a', 10), nativeRow('new', 2)];
  const corrected = await collectUsageOnce({ ...options, now: newest,
    runTokscale: async () => ({ entries: nativeRows }), runGraph: async () => moved,
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(cached.sourceSnapshots.claude.replacementAuthority, false);
  assert.equal(cached.sourceSnapshots.claude.projectIdentified, true);
  assert.equal(corrected.history.summary.totalTokens, 62);
  assert.ok(corrected.sessionArchiveSource.managedKeys.includes('claude:b'));
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(corrected[name].totalTokens, 62);
    assert.equal(corrected[name].sessions['claude:a'].totalTokens, 10);
    assert.equal(corrected[name].sessions['claude:new'].totalTokens, 2);
    assert.equal(corrected[name].sessions['claude:b'].totalTokens, 50);
    assert.equal(captured.windowsPeriods[name].totalTokens, 12);
  }
  for (const sourceArchiveSnapshot of [cached, undefined, cached]) {
    const watch = await collectUsageOnce({ ...options, now: newest, includeHistory: false, sourceArchiveSnapshot,
      todayOnlyAnchor: anchorFrom(captured, newest), runTokscale: async () => ({ entries: nativeRows }) });
    for (const name of ['today', 'month', 'allTime']) assert.equal(watch[name].totalTokens, 62);
  }
  const omittedAt = new Date(newest.getTime() + 60000);
  const omitted = sourceGraph(omittedAt, [{ client: 'claude', sessionId: 'new', days: [contribution(today, 2)] }]);
  omitted.sourceUsage.sessions[0].events[0].id = moved.sourceUsage.sessions[1].events[0].id;
  const absent = await collectUsageOnce({ ...options, now: omittedAt,
    runTokscale: async () => ({ entries: [nativeRow('new', 2)] }), runGraph: async () => omitted,
    onAnchorComputed: value => { captured = value; }, onSourceArchiveComputed: value => { cached = value; } });
  assert.equal(absent.history.summary.totalTokens, 62);
  assert.ok(cached.unresolvedSessions.some(row => row.sessionId === 'a'));
  const archived = applySessionUsageArchive(absent, sessionArchive, { now: omittedAt });
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(absent[name].totalTokens, 62);
    assert.equal(absent[name].sessions['claude:a'].totalTokens, 10);
    assert.equal(absent[name].sessions['claude:a'].liveActivity, undefined);
    assert.equal(archived[name].totalTokens, 62, 'generic session retention must not replay the old a100 snapshot');
    assert.equal(captured.windowsPeriods[name].totalTokens, 2);
  }
  for (const sourceArchiveSnapshot of [cached, undefined, cached]) {
    const watch = await collectUsageOnce({ ...options, now: omittedAt, includeHistory: false, sourceArchiveSnapshot,
      todayOnlyAnchor: anchorFrom(captured, omittedAt), runTokscale: async () => ({ entries: [nativeRow('new', 2)] }) });
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(watch[name].totalTokens, 62);
      assert.equal(watch[name].sessions['claude:a'].totalTokens, 10);
    }
  }
});
