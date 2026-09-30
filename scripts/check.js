'use strict';

// Проверка перед выпуском: все модули src/ попадают в сборку, dist/ собран из текущих
// исходников, тесты проходят.
//
//   npm run check

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { bundle, modules, target } = require('./build');

const root = path.join(__dirname, '..');
const problems = [];

const sources = fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
const missing = sources.filter(name => !modules.includes(name));
if (missing.length) problems.push(`Модули не входят в сборку (scripts/build.js): ${missing.join(', ')}`);

const normalize = s => s.split('\r\n').join('\n');
const built = fs.existsSync(target) ? normalize(fs.readFileSync(target, 'utf8')) : null;
if (built !== bundle()) problems.push('dist/sql-er-plugin.js устарел — выполните npm run build');

const tests = spawnSync(process.execPath, ['--test'], { cwd: root, stdio: 'inherit' });
if (tests.status !== 0) problems.push('Тесты не прошли');

if (problems.length) {
  console.error('\n✖ ' + problems.join('\n✖ '));
  process.exit(1);
}
console.log('\n✔ Сборка актуальна, тесты проходят');
