'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { collectUsageOnce } = require('../../src/shared/collector');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');
const { extractUsageFromTokscale } = require('../../src/shared/usage');
const { captureSessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');

// This checks the actual scanner/App contract without downloading a binary as
// part of npm test. Run it against a locally built v2 fork before pinning assets.
const binary = process.env.TOKEN_MONITOR_SOURCE_LEDGER_TEST_BINARY;
test('actual scanner preserves ownership, rejects partial corrections and advances exclusive legacy usage', { skip: !binary }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ledger-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = new Date();
  const config = path.join(home, '.config/tokscale');
  const cache = path.join(config, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const payload = JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), data: {} });
  for (const name of ['pricing-litellm.json', 'pricing-openrouter.json', 'pricing-models-dev.json']) {
    fs.writeFileSync(path.join(cache, name), payload);
  }
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ scanner: {
    bucketTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  } }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('TOKSCALE_') || key.startsWith('TOKEN_MONITOR_') || ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(key)) delete env[key];
  }
  Object.assign(env, { HOME: home, TOKSCALE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'), TOKSCALE_PRICING_CACHE_ONLY: '1' });
  const run = args => JSON.parse(execFileSync(binary, ['--home', home, ...args, '--no-spinner'], {
    env, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024
  }));
  const results = [];
  async function observe(client, phase, expected, offset, extra = {}) {
    const filter = client === 'mimo' ? 'micode,micode-desktop' : client;
    const source = run(['graph', '--client', filter, '--source-snapshots']).sourceUsage;
    assert.equal(source.version, 2);
    const summary = await collectUsageOnce({ clients: client, allTimeSince: '2026-01-01', deviceId: 'native-ledger',
      homeDir: home, env: {}, projectsEnabled: false, wslScanEnabled: false, codexLocalUsageEnabled: false,
      includeHistory: true, dailyHistoryArchiveEnabled: true, now: new Date(now.getTime() + offset),
      sessionUsageArchive: { version: 1, sessions: {} },
      dailyHistoryArchiveOptions: { path: path.join(home, `${client}-daily.json`) },
      sessionMetadataDeps: { resolveSessionMetadata: () => null },
      runTokscale: async ({ flags }) => run(['--json', '--client', filter, '--group-by', 'client,workspace,session,model', ...flags]),
      runGraph: async () => run(['graph', '--client', filter, '--source-snapshots']), ...extra });
    assert.equal(summary.allTime.totalTokens, expected, phase);
    assert.equal(summary.history.summary.totalTokens, expected, phase);
    assert.equal(Object.values(summary.allTime.sessions).reduce((sum, row) => sum + row.totalTokens, 0), expected, phase);
    const wire = serializeSyncPayload(summary).body;
    for (const privateValue of [home, 'sourceUsage', 'sha256:']) assert.equal(wire.includes(privateValue), false);
    results.push({ phase, tokens: summary.allTime.totalTokens, cost: summary.allTime.costUsd,
      scopes: source.scopes.map(({ readStatus, identityStatus }) => ({ readStatus, identityStatus })),
      ids: source.sessions.flatMap(row => row.events.map(event => event.id)) });
    return summary;
  }

  const mimoDirectory = path.join(home, '.local/share/mimocode');
  fs.mkdirSync(mimoDirectory, { recursive: true });
  const databasePath = path.join(mimoDirectory, 'mimocode.db');
  function writeMimo(desktop, tokens) {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec('CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT, version TEXT, time_created REAL); DELETE FROM message; DELETE FROM session;');
      const sessionId = desktop ? 'desktop-session' : 'cli-session';
      database.prepare('INSERT INTO session(id,directory,version,time_created) VALUES(?,?,?,?)')
        .run(sessionId, '/fixture', desktop ? 'desktop-test' : '1.2.3', now.getTime() - 60_000);
      database.prepare('INSERT INTO message(id,session_id,data) VALUES(?,?,?)').run('shared-response', sessionId, JSON.stringify({
        id: 'shared-response', role: 'assistant', modelID: 'fixture-model', providerID: 'mimo', cost: tokens / 100,
        tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now.getTime() - 1000 }
      }));
    } finally {
      database.close();
    }
  }
  writeMimo(false, 15);
  await observe('mimo', 'CLI15', 15, 0);
  writeMimo(true, 15);
  await observe('mimo', 'Desktop transfer15', 15, 1000);
  writeMimo(true, 5);
  await observe('mimo', 'Desktop correction5', 5, 2000);
  assert.equal(results[0].ids[0], results[1].ids[0]);
  assert.equal(results[1].ids[0], results[2].ids[0]);
  assert.deepEqual(results.slice(0, 3).map(row => row.cost), [0.15, 0.15, 0.05]);

  const codexDirectory = path.join(home, '.codex/sessions/2026/10/11');
  fs.mkdirSync(codexDirectory, { recursive: true });
  const sessionId = '01900000-0000-7000-8000-000000000001';
  const rollout = path.join(codexDirectory, `rollout-2026-10-11T00-00-00-${sessionId}.jsonl`);
  function writeCodex(tokens, failure) {
    const rows = [
      { timestamp: now.toISOString(), type: 'session_meta', payload: { id: sessionId, source: 'cli', model_provider: 'openai' } },
      { timestamp: now.toISOString(), type: 'turn_context', payload: { turn_id: 'stable-turn', model: 'gpt-5.4' } },
      { timestamp: now.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: tokens, cached_input_tokens: 0, output_tokens: 0 },
        last_token_usage: { input_tokens: tokens, cached_input_tokens: 0, output_tokens: 0 }
      } } }
    ];
    if (failure === 'schema') rows.push({ timestamp: now.toISOString(), type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: { input_tokens: 'not-a-number', cached_input_tokens: 0, output_tokens: 0 },
        last_token_usage: { input_tokens: 'not-a-number', cached_input_tokens: 0, output_tokens: 0 } }
    } });
    fs.writeFileSync(rollout, rows.map(JSON.stringify).join('\n') + '\n' + (failure === 'json' ? '{malformed-json\n' : ''));
  }
  writeCodex(45);
  await observe('codex', 'complete45', 45, 3000);
  writeCodex(15, 'json');
  await observe('codex', 'malformed15 retains45', 45, 4000);
  writeCodex(15, 'schema');
  await observe('codex', 'schema-invalid15 retains45', 45, 5000);
  writeCodex(15);
  await observe('codex', 'complete correction15', 15, 6000);
  assert.equal(results[3].ids[0], results[4].ids[0]);
  assert.equal(results[4].ids[0], results[5].ids[0]);
  assert.equal(results[5].ids[0], results[6].ids[0]);
  assert.equal(results[3].scopes[0].readStatus, 'complete');
  assert.equal(results[4].scopes[0].readStatus, 'partial');
  assert.equal(results[5].scopes[0].readStatus, 'partial');
  assert.equal(results[6].scopes[0].readStatus, 'complete');

  writeMimo(false, 45);
  await observe('mimo', 'complete MiMo45', 45, 7000);
  writeMimo(false, 15);
  const invalidDatabase = new DatabaseSync(databasePath);
  try {
    invalidDatabase.prepare("UPDATE message SET data=json_set(data,'$.tokens.input',-30,'$.tokens.output',15)").run();
  } finally {
    invalidDatabase.close();
  }
  await observe('mimo', 'negative input with valid output15 retains45', 45, 8000);
  assert.equal(results[8].scopes[0].readStatus, 'partial');
  assert.equal(results[8].cost, 0.45);
  writeMimo(false, 15);
  await observe('mimo', 'valid MiMo correction15', 15, 9000);
  assert.equal(results[9].scopes[0].readStatus, 'complete');
  assert.equal(results[9].cost, 0.15);
  assert.equal(results[7].ids[0], results[8].ids[0]);
  assert.equal(results[8].ids[0], results[9].ids[0]);

  const legacyPeriod = extractUsageFromTokscale({ entries: [{ client: 'codex', sessionId: 'unresolved-old-ID',
    model: 'fixture-model', input: 100, cost: 1 }] });
  const sessionUsageArchive = captureSessionUsageArchive({}, {
    today: legacyPeriod, month: legacyPeriod, allTime: legacyPeriod
  }, now);
  const legacy = await observe('codex', 'generic-only100 refuses unrelated exact15 migration', 100, 10000, {
    sessionUsageArchive, dailyHistoryArchiveOptions: { path: path.join(home, 'legacy-codex-daily.json') }
  });
  assert.equal(legacy.allTime.sessions['codex:unresolved-old-ID'].totalTokens, 100);
  assert.equal(legacy.allTime.sessions[`codex:${sessionId}`], undefined);
  assert.equal(sessionUsageArchive.sessions['codex:unresolved-old-ID'].periods.allTime.totalTokens, 100);
  for (const [tokens, offset] of [[150, 11000], [180, 12000]]) {
    writeCodex(tokens);
    const advanced = await observe('codex', `complete${tokens} advances exclusive legacy observation`, tokens, offset, {
      sessionUsageArchive, dailyHistoryArchiveOptions: { path: path.join(home, 'legacy-codex-daily.json') }
    });
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(advanced[period].totalTokens, tokens);
      assert.equal(Object.values(advanced[period].sessions).reduce((sum, row) => sum + row.totalTokens, 0), tokens);
      assert.equal(advanced[period].sessions['codex:unresolved-old-ID'], undefined);
    }
    assert.equal(sessionUsageArchive.sessions['codex:unresolved-old-ID'].periods.allTime.totalTokens, 100);
  }
  const fallback = await observe('codex', 'aggregate fallback retains one legacy180 after reload', 180, 13000, {
    sessionUsageArchive, dailyHistoryArchiveOptions: { path: path.join(home, 'legacy-codex-daily.json') },
    runGraph: async () => run(['graph', '--client', 'codex'])
  });
  assert.equal(fallback.allTime.sessions['codex:unresolved-old-ID'], undefined);
  t.diagnostic(JSON.stringify(results.map(({ phase, tokens, cost, scopes }) => ({ phase, tokens, cost, scopes }))));
});

const crossDayCases = [
  { name: 'actual scanner retains cross-day legacy session allocation through reload and aggregate fallback',
    rows: [{ client: 'codex', sessionId: 'unresolved-old', model: 'gpt-5.4', input: 100, cost: 1 }] },
  { name: 'actual scanner retains three fractional-cost session allocations through model regrouping',
    rows: [0.1, 0.2, 0.4].map((cost, index) => ({ client: 'codex', sessionId: `priced-${index}`,
      model: `model${index % 2}`, input: 10, cost })) },
  { name: 'actual scanner retains eight fractional-cost session allocations through total regrouping',
    rows: [0.00252, 0.00088, 0.00577, 0.00223, 0.00376, 0.00026, 0.00447, 0.00118].map((cost, index) => ({
      client: 'codex', sessionId: `priced-${index}`, model: `model${index % 3}`, input: 10, cost })) },
  { name: 'actual scanner preserves unknown legacy components through dated projection', unknownComponents: true,
    rows: [{ client: 'codex', sessionId: 'unresolved-old', model: 'gpt-5.4', totalTokens: 100, cost: 1 }] }
];
for (const fixture of crossDayCases) test(fixture.name, { skip: !binary }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ledger-cross-day-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const sameMonth = localDate(now).slice(0, 7) === localDate(yesterday).slice(0, 7);
  const config = path.join(home, '.config/tokscale');
  const cache = path.join(config, 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const payload = JSON.stringify({ timestamp: Math.floor(now.getTime() / 1000), data: {} });
  for (const name of ['pricing-litellm.json', 'pricing-openrouter.json', 'pricing-models-dev.json']) fs.writeFileSync(path.join(cache, name), payload);
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ scanner: {
    bucketTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  } }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('TOKSCALE_') || key.startsWith('TOKEN_MONITOR_') || ['CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(key)) delete env[key];
  }
  Object.assign(env, { HOME: home, TOKSCALE_CONFIG_DIR: config, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'), TOKSCALE_PRICING_CACHE_ONLY: '1' });
  const run = args => JSON.parse(execFileSync(binary, ['--home', home, ...args, '--no-spinner'], {
    env, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024
  }));
  const directory = path.join(home, '.codex/sessions');
  fs.mkdirSync(directory, { recursive: true });
  const sessionId = '01900000-0000-7000-8000-000000000007';
  const rollout = path.join(directory, `rollout-${localDate(yesterday)}T12-00-00-${sessionId}.jsonl`);
  const tokenCount = (date, total, last) => ({ timestamp: date.toISOString(), type: 'event_msg', payload: {
    type: 'token_count', info: {
      total_token_usage: { input_tokens: total, output_tokens: 0, cached_input_tokens: 0 },
      last_token_usage: { input_tokens: last, output_tokens: 0, cached_input_tokens: 0 }
    }
  } });
  const rows = [
    { timestamp: yesterday.toISOString(), type: 'session_meta', payload: { id: sessionId, model_provider: 'openai' } },
    { timestamp: yesterday.toISOString(), type: 'turn_context', payload: { turn_id: 'yesterday-turn', model: 'gpt-5.4' } },
    tokenCount(yesterday, 20, 20)
  ];
  const legacy = extractUsageFromTokscale({ entries: fixture.rows });
  const legacyTokens = fixture.rows.reduce((sum, row) => sum + (row.input ?? row.totalTokens), 0);
  const legacyCost = fixture.rows.reduce((sum, row) => sum + row.cost, 0);
  const legacyKeys = new Set(fixture.rows.map(row => `${row.client}:${row.sessionId}`));
  const fractionalCosts = fixture.rows.some(row => !Number.isInteger(row.cost));
  const assertCost = (actual, expected, message) => {
    if (!fractionalCosts) return assert.equal(actual, expected, message);
    assert.ok(Math.abs(actual - expected) <= 8 * Number.EPSILON
      * Math.max(1, Math.abs(actual), Math.abs(expected)), message);
  };
  const sessionUsageArchive = captureSessionUsageArchive({}, { today: legacy, month: legacy, allTime: legacy }, yesterday);
  const dailyPath = path.join(home, 'daily.json');
  const evidence = [];
  let anchor;
  let projection;
  for (const phase of ['yesterday20', 'today5', 'fallback-reload']) {
    if (phase === 'today5') rows.push(
      { timestamp: now.toISOString(), type: 'turn_context', payload: { turn_id: 'today-turn', model: 'gpt-5.4' } },
      tokenCount(now, 25, 5)
    );
    fs.writeFileSync(rollout, rows.map(JSON.stringify).join('\n') + '\n');
    const graph = run(['graph', '--client', 'codex', '--source-snapshots']);
    assert.equal(graph.sourceUsage.scopes[0].readStatus, 'complete');
    assert.equal(graph.sourceUsage.scopes[0].identityStatus, 'exact');
    assert.deepEqual(graph.contributions.map(day => [day.date, day.totals.tokens]), phase === 'yesterday20'
      ? [[localDate(yesterday), 20]] : [[localDate(yesterday), 20], [localDate(now), 5]]);
    const result = await collectUsageOnce({ clients: 'codex', allTimeSince: `${yesterday.getFullYear() - 1}-01-01`,
      deviceId: 'cross-day-fixture', homeDir: home, env: {}, projectsEnabled: false, wslScanEnabled: false,
      codexLocalUsageEnabled: false, includeHistory: true, dailyHistoryArchiveEnabled: true, now,
      sessionUsageArchive, dailyHistoryArchiveOptions: { path: dailyPath },
      sessionMetadataDeps: { resolveSessionMetadata: () => null },
      onAnchorComputed: value => { anchor = value; },
      onSourceArchiveComputed: value => { projection = value; },
      runTokscale: async ({ flags }) => run(['--json', '--client', 'codex', '--group-by', 'client,workspace,session,model', ...flags]),
      runGraph: async () => phase === 'fallback-reload' ? run(['graph', '--client', 'codex']) : graph });
    const withToday = phase !== 'yesterday20';
    const expected = { today: withToday ? 5 : 0, month: (sameMonth ? legacyTokens : 0) + (withToday ? 5 : 0), allTime: legacyTokens + (withToday ? 5 : 0) };
    for (const [name, tokens] of Object.entries(expected)) {
      assert.equal(result[name].totalTokens, tokens, `${phase}: ${name}`);
      assert.equal(Object.values(result[name].sessions).reduce((sum, row) => sum + row.totalTokens, 0), tokens, `${phase}: ${name} session allocation`);
      assertCost(Object.values(result[name].sessions).reduce((sum, row) => sum + row.costUsd, 0), result[name].costUsd, `${phase}: ${name} session cost`);
      if (fixture.unknownComponents && (name === 'allTime' || name === 'month' && sameMonth)) {
        assert.equal(result[name].capabilities.tokenComponents, false, `${phase}: ${name} unknown component provenance`);
        assert.ok(result[name].unclassifiedTokens >= legacyTokens, `${phase}: ${name} unknown remainder`);
        assert.ok(result[name].clientUnclassifiedTokens.codex >= legacyTokens, `${phase}: ${name} client unknown remainder`);
        assert.ok(result[name].modelUnclassifiedTokens['gpt-5.4'] >= legacyTokens, `${phase}: ${name} model unknown remainder`);
      }
    }
    assertCost(result.allTime.costUsd, legacyCost, `${phase}: retained whole cost`);
    for (const row of fixture.rows) {
      const session = result.allTime.sessions[`codex:${row.sessionId}`];
      assert.equal(session.totalTokens, row.input ?? row.totalTokens);
      assertCost(session.costUsd, row.cost, `${phase}: ${row.sessionId} known cost`);
      if (fixture.unknownComponents) assert.equal(session.inputTokens, 0, 'unknown tokens cannot gain input provenance');
    }
    const current = Object.entries(result.allTime.sessions).filter(([key]) => !legacyKeys.has(key)).map(([, row]) => row);
    assert.equal(current.length, withToday ? 1 : 0);
    if (withToday) assert.equal(current[0].totalTokens, 5);
    assert.equal(result.history.summary.totalTokens, expected.allTime);
    const stored = JSON.parse(fs.readFileSync(dailyPath));
    assert.equal(Object.values(stored.sourceLedger.scopes)[0].mode, 'legacy');
    assert.equal(Object.keys(Object.values(stored.sourceLedger.scopes)[0].events).length, 0);
    for (const row of fixture.rows) assert.equal(sessionUsageArchive.sessions[`codex:${row.sessionId}`].periods.allTime.totalTokens, row.input ?? row.totalTokens);
    const wire = serializeSyncPayload(result).body;
    for (const privateValue of [home, 'sourceUsage', 'legacyDays', 'sha256:']) assert.equal(wire.includes(privateValue), false);
    evidence.push({ phase, periods: Object.fromEntries(Object.entries(expected).map(([name]) => [name, {
      tokens: result[name].totalTokens, cost: result[name].costUsd,
      sessionSum: Object.values(result[name].sessions).reduce((sum, row) => sum + row.totalTokens, 0)
    }])) });
    if (phase === 'today5') {
      const persisted = fs.readFileSync(dailyPath, 'utf8');
      rows[rows.length - 1] = tokenCount(now, 27, 7);
      fs.writeFileSync(rollout, rows.map(JSON.stringify).join('\n') + '\n');
      const watch = await collectUsageOnce({ clients: 'codex', allTimeSince: `${yesterday.getFullYear() - 1}-01-01`,
        deviceId: 'cross-day-fixture', homeDir: home, env: {}, projectsEnabled: false, wslScanEnabled: false,
        codexLocalUsageEnabled: false, includeHistory: false, dailyHistoryArchiveEnabled: true, now,
        sourceArchiveSnapshot: projection, dailyHistoryArchiveOptions: { path: dailyPath },
        todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: localDate(now), todayPartitions: anchor.todayPartitions,
          nativeRawPresence: anchor.nativeRawPresence },
        getSessionUsageArchive: () => { throw new Error('watch cannot acquire migration evidence'); },
        sessionMetadataDeps: { resolveSessionMetadata: () => null },
        runTokscale: async ({ flags }) => {
          assert.deepEqual(flags, ['--today']);
          return run(['--json', '--client', 'codex', '--group-by', 'client,workspace,session,model', ...flags]);
        },
        runGraph: async () => { throw new Error('watch cannot scan full History'); } });
      for (const [name, tokens] of Object.entries({ today: 7, month: (sameMonth ? legacyTokens : 0) + 7, allTime: legacyTokens + 7 })) {
        assert.equal(watch[name].totalTokens, tokens, `watch7: ${name}`);
        assert.equal(Object.values(watch[name].sessions).reduce((sum, row) => sum + row.totalTokens, 0), tokens, `watch7: ${name} session allocation`);
      }
      assertCost(watch.allTime.costUsd, legacyCost, 'watch preserves retained costs');
      if (fixture.unknownComponents) {
        assert.equal(watch.allTime.capabilities.tokenComponents, false);
        assert.ok(watch.allTime.unclassifiedTokens >= legacyTokens);
      }
      assert.equal(fs.readFileSync(dailyPath, 'utf8'), persisted, 'watch does not persist a complete observation');
      evidence.push({ phase: 'watch7', allTime: watch.allTime.totalTokens,
        sessionSum: Object.values(watch.allTime.sessions).reduce((sum, row) => sum + row.totalTokens, 0) });
      // Reload/fallback must still use the accepted full Today5 observation.
      rows[rows.length - 1] = tokenCount(now, 25, 5);
    }
  }
  t.diagnostic(JSON.stringify(evidence));
});
