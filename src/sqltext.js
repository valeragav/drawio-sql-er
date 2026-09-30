'use strict';

// Приведение SQL-выражений к привычному виду (общий код для моста к базе и сравнения схем).

// PostgreSQL хранит выражения в нормализованном виде — возвращаем их к тому,
// как их обычно пишут:
//   (status)::text = ANY ((ARRAY['a'::character varying, 'b'])::text[])  →  status IN ('a', 'b')
//   'draft'::text → 'draft',   (0)::numeric → 0,   CHECK ((x > 0)) → CHECK (x > 0)
const TEXT_TYPES = '(?:text|character varying|varchar|bpchar|character)';
const NUMERIC_TYPES = '(?:numeric|integer|bigint|smallint|real|double precision)';

function simplifyExpr(expr) {
  if (!expr) return expr;
  let s = expr;
  s = s.replace(new RegExp(`\\(\\(ARRAY\\[([^\\]]*)\\]\\)::${TEXT_TYPES}\\[\\]\\)`, 'g'), '(ARRAY[$1])');
  s = s.replace(new RegExp(`'((?:[^']|'')*)'::${TEXT_TYPES}(?![\\w\\[])`, 'g'), "'$1'");
  s = s.replace(new RegExp(`\\(([A-Za-z_][\\w$]*|"(?:[^"]|"")+")\\)::${TEXT_TYPES}(?![\\w\\[])`, 'g'), '$1');
  s = s.replace(new RegExp(`\\((-?\\d+(?:\\.\\d+)?)\\)::${NUMERIC_TYPES}\\b`, 'g'), '$1');
  s = s.replace(new RegExp(`(^|[^\\w.'])(\\d+(?:\\.\\d+)?)::${NUMERIC_TYPES}\\b`, 'g'), '$1$2');
  // «x = ANY (ARRAY[…])» и «x = ANY ((ARRAY[…]))» — скобки учитываем парами.
  const list = '(?:\\(ARRAY\\[([^\\]]*)\\]\\)|ARRAY\\[([^\\]]*)\\])';
  const ident = '([A-Za-z_][\\w$.]*|"(?:[^"]|"")+")';
  s = s.replace(new RegExp(`${ident}\\s*=\\s*ANY\\s*\\(\\s*${list}\\s*\\)`, 'g'),
    (m, col, a, b) => `${col} IN (${a !== undefined ? a : b})`);
  s = s.replace(new RegExp(`${ident}\\s*<>\\s*ALL\\s*\\(\\s*${list}\\s*\\)`, 'g'),
    (m, col, a, b) => `${col} NOT IN (${a !== undefined ? a : b})`);
  return stripOuterParens(s);
}

// «CHECK ((a > 0))» → «CHECK (a > 0)»; «((a > 0))» → «(a > 0)».
function stripOuterParens(s) {
  const m = /^(CHECK\s*)?\((.*)\)$/s.exec(s);
  if (!m) return s;
  let inner = m[2];
  while (inner.startsWith('(') && inner.endsWith(')') && balanced(inner.slice(1, -1))) inner = inner.slice(1, -1);
  return (m[1] ? m[1] : '') + '(' + inner + ')';
}

function balanced(s) {
  let depth = 0;
  let quote = false;
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (quote) continue;
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

module.exports = { simplifyExpr };
