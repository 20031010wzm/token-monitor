---
summary: "Pi (pi.dev) provider notes: where the agent stores session transcripts and how Session Detail reads them, while usage totals still come from tokscale."
ids: [pi]
read_when:
  - Changing or debugging Pi Session Detail
  - Investigating Pi usage that is missing from the widget
  - Touching providers/pi/paths.js or the pi branch of sessionFiles.js/sessionDetail.js
---

# Pi (pi.dev) provider

Pi is a tokscale-parsed tracked client: usage, sessions and costs come from the shared collector during the scan. Only Session Detail is read locally, because tokscale has no per-turn view to hand back.

| Data plane | Read by | Source |
| --- | --- | --- |
| Token usage (periods, dashboard, history) | the shared usage collector, through `tokscale` | Pi session transcripts, parsed by tokscale |
| Session Detail (per-turn breakdown, prompts) | `sessionDetail.js` with `providers/pi/paths.js`, on demand | the same transcripts, parsed locally |

## Where the data lives

Pi resolves its agent directory from `PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent`, and writes one transcript per session under a folder named after the working directory:

```
<agentDir>/sessions/<encoded-cwd>/<ISO-timestamp>_<sessionId>.jsonl
```

The session id is a **suffix** of the filename, not the basename, so `findPiSessionFiles` matches `_<sessionId>.jsonl` rather than `resolveSessionFile`'s basename walk used by Claude/Codex. An explicit secondary home (a WSL distro) passes `useEnvRoots: false` so the scoped home wins over the host `PI_CODING_AGENT_DIR`.

## Record shape

Each line is one entry `{type, id, parentId, timestamp, message}`; only `type: "message"` carries conversation. `message.role` is one of `system`, `user`, `assistant` or `toolResult`.

A user message is always a real prompt boundary: tool output arrives as its own `toolResult` role and compaction summaries as their own `compaction` entry, so neither is mistaken for a prompt. Each assistant message is one API response with its own `usage`, so — unlike Claude — nothing has to be de-duplicated across content blocks.

`usage` follows OpenAI's convention: `input`/`output`/`cacheRead`/`cacheWrite` sum to `totalTokens`, and `reasoning` is an informational subset of `output`. Pi also prices every reply in `usage.cost.total`, so Session Detail uses the reported per-turn cost instead of splitting the session subtotal; a provider that reports no price falls back to that split.

## Invariants and known gaps

- **`reasoning` is never added to the total.** It is a subset of `output`; `totalTokens` is `input + output + cacheRead + cacheWrite`. Adding it would double-count.
- **The session id is a filename suffix**, so the basename walk used for other clients cannot find a Pi transcript.
- Session titles and timestamps for Pi are not read here yet; the scan supplies what the Sessions list shows.

## Verification

```bash
node --test tests/shared/piSessionDetail.test.js tests/shared/sessionFiles.test.js
```
