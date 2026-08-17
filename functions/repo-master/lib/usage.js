'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function file(env = process.env) {
  return env.GIFT_REPO_MASTER_USAGE_FILE || path.join(os.homedir(), '.gift', 'repo-master-usage.json');
}

function read(env = process.env) {
  try {
    const value = JSON.parse(fs.readFileSync(file(env), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function sort(actions, counts = read()) {
  return [...actions].sort((left, right) => {
    const frequency = (Number(counts[right.id]) || 0) - (Number(counts[left.id]) || 0);
    return frequency || left.label.localeCompare(right.label);
  });
}

function record(id, env = process.env) {
  const target = file(env);
  const counts = read(env);
  counts[id] = (Number(counts[id]) || 0) + 1;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(counts, null, 4)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return counts;
}

module.exports = { read, record, sort };
