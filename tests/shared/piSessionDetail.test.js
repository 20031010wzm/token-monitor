'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parsePiTranscript, readSessionDetail } = require('../../src/shared/sessionDetail');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-pi-home-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

// Pi writes `<agentDir>/sessions/<encoded-cwd>/<ISO-timestamp>_<sessionId>.jsonl`.
function writePiSession(home, sessionId, lines) {
  const dir = path.join(home, '.pi', 'agent', 'sessions', '--D--project--');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-12T02-27-31-079Z_${sessionId}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function assistant(usage, content = [], timestamp = '2026-10-12T02:28:43.068Z') {
  return JSON.stringify({ type: 'message', id: 'm1', parentId: 'p1', timestamp, message: { role: 'assistant', content, usage } });
}

function user(text, timestamp = '2026-10-12T02:28:41.508Z') {
  return JSON.stringify({ type: 'message', id: 'm0', parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text }] } });
}

test('parsePiTranscript yields prompts and turns with exact tokens, tools and cost', () => {
  const lines = [
    // Session headers and companion records are not conversation.
    JSON.stringify({ type: 'session', id: 'ignored', cwd: 'D:\\project' }),
    JSON.stringify({ type: 'model_change', provider: 'deepseek', modelId: 'deepseek-v4-pro' }),
    user('怎么调整默认模型为ds-flash'),
    assistant(
      { input: 1691, output: 203, cacheRead: 0, cacheWrite: 0, reasoning: 28, totalTokens: 1894, cost: { input: 0.0005073, output: 0.0002436, cacheRead: 0, cacheWrite: 0, total: 0.0007509 } },
      [
        { type: 'thinking', thinking: 'reasoning text' },
        { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
        { type: 'text', text: 'ok' }
      ]
    ),
    // Tool output is a separate role, not a user prompt boundary.
    JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-10-12T02:28:44.000Z', message: { role: 'toolResult', toolCallId: 'call_1', content: 'output' } }),
    assistant(
      { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, reasoning: 5, totalTokens: 360, cost: { input: 0.00003, output: 0.00006, cacheRead: 0.0000021, cacheWrite: 0.0000005, total: 0.002 } },
      [{ type: 'text', text: 'done' }],
      '2026-10-12T02:28:45.000Z'
    ),
    JSON.stringify({ type: 'compaction', timestamp: '2026-10-12T02:28:46.000Z', summary: 'compacted' }),
    '{bad json'
  ];

  const events = parsePiTranscript(lines.join('\n'));

  assert.equal(events.length, 3);
  assert.equal(events[0].kind, 'prompt');
  assert.equal(events[0].text, '怎么调整默认模型为ds-flash');
  assert.equal(events[1].kind, 'turn');
  // totalTokens excludes reasoning, which is a subset of output (OpenAI convention).
  assert.equal(events[1].tokens.total, 1894);
  assert.equal(events[1].tokens.reasoning, 28);
  assert.deepEqual(events[1].tools, ['bash']);
  assert.equal(events[1].cost, 0.0007509);
  assert.equal(events[2].tokens.total, 360);
  assert.equal(events[2].tokens.cacheWrite, 10);
});

test('parsePiTranscript keeps an [image] marker for an image-only prompt', () => {
  const lines = [
    JSON.stringify({ type: 'message', timestamp: '2026-10-12T02:28:41.508Z', message: { role: 'user', content: [{ type: 'image', data: 'x' }] } }),
    JSON.stringify({ type: 'message', timestamp: '2026-10-12T02:28:42.000Z', message: { role: 'user', content: [{ type: 'text', text: '   ' }] } })
  ];
  const prompts = parsePiTranscript(lines.join('\n')).filter((event) => event.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, '[image]');
});

test('readSessionDetail reads a pi transcript and uses the reported per-turn cost', () => {
  const home = tmpHome();
  try {
    writePiSession(home, 'pi-session-1', [
      user('重构 collector'),
      assistant(
        { input: 1691, output: 203, cacheRead: 0, cacheWrite: 0, reasoning: 28, totalTokens: 1894, cost: { total: 0.0007509 } },
        [{ type: 'toolCall', name: 'Read' }, { type: 'toolCall', name: 'Read' }]
      ),
      assistant(
        { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, reasoning: 5, totalTokens: 360, cost: { total: 0.002 } },
        [{ type: 'text', text: 'done' }],
        '2026-10-12T02:28:45.000Z'
      )
    ]);

    // sessionCost is what tokscale would report; Pi prices each reply itself, so
    // the detail prefers the summed reported cost over the session subtotal.
    const detail = readSessionDetail({ client: 'pi', sessionId: 'pi-session-1', sessionCost: 99, home });

    assert.equal(detail.found, true);
    assert.equal(detail.client, 'pi');
    assert.equal(detail.exchanges.length, 1);
    assert.equal(detail.exchanges[0].promptPreview, '重构 collector');
    assert.equal(detail.exchanges[0].turns.length, 2);
    assert.deepEqual(detail.exchanges[0].tools, ['Read']);
    assert.equal(detail.totals.totalTokens, 2254);
    assert.equal(detail.totals.turnCount, 2);
    assert.ok(Math.abs(detail.totals.costUsd - 0.0027509) < 1e-9);
    assert.equal(detail.exchanges[0].costEstimate, detail.totals.costUsd);
  } finally { cleanup(home); }
});

test('readSessionDetail splits the session cost when Pi reports no price', () => {
  const home = tmpHome();
  try {
    writePiSession(home, 'pi-session-2', [
      user('no pricing'),
      assistant({ input: 100, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 200, cost: { total: 0 } }, [{ type: 'text', text: 'a' }]),
      assistant({ input: 300, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 400, cost: { total: 0 } }, [{ type: 'text', text: 'b' }], '2026-10-12T02:28:45.000Z')
    ]);

    const detail = readSessionDetail({ client: 'pi', sessionId: 'pi-session-2', sessionCost: 6, home });

    assert.equal(detail.totals.costUsd, 6);
    // 200 / 600 and 400 / 600.
    assert.equal(detail.exchanges[0].turns[0].costEstimate, 2);
    assert.equal(detail.exchanges[0].turns[1].costEstimate, 4);
  } finally { cleanup(home); }
});

test('readSessionDetail filters pi exchanges by period', () => {
  const home = tmpHome();
  try {
    // Local-time stamps, not UTC literals: 'today' cuts on the host's day boundary,
    // so a fixed UTC pair falls on different days east of UTC+12.
    const base = new Date();
    const at = (dayOffset, second) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, 1, 0, second).toISOString();
    writePiSession(home, 'pi-session-3', [
      user('today', at(0, 0)),
      assistant({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 20, cost: { total: 0.1 } }, [], at(0, 1)),
      user('yesterday', at(-1, 0)),
      assistant({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 20, cost: { total: 0.2 } }, [], at(-1, 1))
    ]);

    const now = () => new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12, 0, 0);
    const today = readSessionDetail({ client: 'pi', sessionId: 'pi-session-3', period: 'today', home, deps: { now } });
    assert.equal(today.exchanges.length, 1);
    assert.equal(today.exchanges[0].promptPreview, 'today');
    assert.ok(Math.abs(today.totals.costUsd - 0.1) < 1e-9);

    const total = readSessionDetail({ client: 'pi', sessionId: 'pi-session-3', home, deps: { now } });
    assert.equal(total.exchanges.length, 2);
    assert.ok(Math.abs(total.totals.costUsd - 0.3) < 1e-9);
  } finally { cleanup(home); }
});
