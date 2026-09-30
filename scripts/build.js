'use strict';

// Собирает src/*.js в один файл плагина dist/sql-er-plugin.js.
// draw.io загружает плагин одним скриптом, поэтому модули оборачиваются
// в функции и связываются маленьким require() внутри IIFE.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const modules = ['parser', 'routing', 'placement', 'drawio', 'page', 'plugin'];
const entry = 'plugin';

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let out = `/*! ${pkg.name} ${pkg.version} — ${pkg.description} */\n`;
out += '(function () {\n';
out += '  var defs = {}, cache = {};\n';
out += '  function require(name) {\n';
out += "    var key = name.replace(/^\\.\\//, '');\n";
out += '    if (!cache[key]) {\n';
out += '      var module = cache[key] = { exports: {} };\n';
out += '      defs[key](module, module.exports, require);\n';
out += '    }\n';
out += '    return cache[key].exports;\n';
out += '  }\n';

for (const name of modules) {
  const source = fs.readFileSync(path.join(root, 'src', name + '.js'), 'utf8');
  out += `\n  defs[${JSON.stringify(name)}] = function (module, exports, require) {\n${source}\n  };\n`;
}

out += `\n  require(${JSON.stringify(entry)});\n})();\n`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const target = path.join(root, 'dist', 'sql-er-plugin.js');
fs.writeFileSync(target, out);
console.log(`${path.relative(root, target)} (${(out.length / 1024).toFixed(1)} KB)`);
