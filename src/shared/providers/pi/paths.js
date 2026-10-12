'use strict';

const path = require('node:path');

function nonBlank(value) {
  const text = String(value ?? '').trim();
  return text || '';
}

// Pi (pi.dev) resolves its agent directory from PI_CODING_AGENT_DIR, falling
// back to ~/.pi/agent, and writes one JSONL transcript per session under
// `<agentDir>/sessions/<encoded-cwd>/<ISO-timestamp>_<sessionId>.jsonl`.
// `useEnvRoots: false` is used for an explicit secondary home such as a WSL
// distro, where the scoped home must win over the host process environment.
function resolvePiAgentDir({ env, homeDir = '', useEnvRoots = true } = {}) {
  const configured = useEnvRoots ? nonBlank((env || process.env).PI_CODING_AGENT_DIR) : '';
  return configured ? path.resolve(configured) : path.join(homeDir, '.pi', 'agent');
}

function resolvePiSessionsDir(options = {}) {
  return path.join(resolvePiAgentDir(options), 'sessions');
}

module.exports = { resolvePiAgentDir, resolvePiSessionsDir };
