const fs = require('node:fs');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'dist');
const forbidden = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (/\.(?:test|spec)\.(?:js|cjs|mjs)(?:\.map)?$/.test(entry.name)) {
      forbidden.push(path.relative(dist, fullPath));
    }
  }
}

if (!fs.existsSync(dist)) throw new Error('dist directory is missing');
walk(dist);
if (forbidden.length > 0) {
  throw new Error(`Test artifacts must not ship in dist: ${forbidden.join(', ')}`);
}
