'use strict';

const fs = require('node:fs');
const path = require('node:path');

function ownedSessionSourcePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
    && path.dirname(value) !== value ? value : '';
}

// Only a resolver's persisted, per-session file is evidence. Parser omissions,
// discovery roots and the contents of a transcript are never deletion proofs.
function classifySessionSourcePath(value, deps = {}) {
  const sourcePath = ownedSessionSourcePath(value);
  if (!sourcePath) return 'unknown';
  const lstat = deps.lstatSync || fs.lstatSync;
  const stat = deps.statSync || fs.statSync;
  const access = deps.accessSync || fs.accessSync;
  const readDirectory = deps.readdirSync || fs.readdirSync;
  try {
    const origin = lstat(sourcePath);
    // A dangling link is still an existing origin, not a deleted transcript.
    const target = origin.isSymbolicLink() ? stat(sourcePath) : origin;
    return target.isFile() ? 'present' : 'unknown';
  } catch (error) {
    if (error?.code !== 'ENOENT') return 'unknown';
    // A dangling link may throw ENOENT from stat rather than lstat.
    try { lstat(sourcePath); return 'unknown'; } catch (cause) {
      if (cause?.code !== 'ENOENT') return 'unknown';
    }
  }

  let ancestor = path.dirname(sourcePath);
  // The filesystem root alone cannot prove that an owned source is accessible.
  while (path.dirname(ancestor) !== ancestor) {
    let origin;
    try {
      origin = lstat(ancestor);
      const target = origin.isSymbolicLink() ? stat(ancestor) : origin;
      if (!target.isDirectory()) return 'unknown';
      access(ancestor, fs.constants.R_OK | fs.constants.X_OK);
      readDirectory(ancestor);
      // The source can return between the failed lookup and ancestor proof.
      try {
        const returned = lstat(sourcePath);
        if (!returned.isSymbolicLink()) return returned.isFile() ? 'present' : 'unknown';
        try { return stat(sourcePath).isFile() ? 'present' : 'unknown'; } catch (_) { return 'unknown'; }
      } catch (error) {
        return error?.code === 'ENOENT' ? 'missing' : 'unknown';
      }
    } catch (error) {
      // ENOENT through an existing ancestor link is an unavailable target,
      // not proof that the owned transcript origin was deleted.
      if (origin) return 'unknown';
      if (error?.code !== 'ENOENT') return 'unknown';
      ancestor = path.dirname(ancestor);
    }
  }
  return 'unknown';
}

module.exports = { classifySessionSourcePath, ownedSessionSourcePath };
