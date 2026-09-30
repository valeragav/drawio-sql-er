'use strict';

// Группы таблиц для рамок на диаграмме.
//   'schema' — по схеме (billing.invoices → billing; без схемы → public),
//              только если схем больше одной;
//   'prefix' — по первой части имени до «_»: course_modules, course_x → course.
//              Таблица без «_», совпадающая с префиксом или его множественным числом,
//              входит в ту же группу: courses → course, articles → article.
// Группа — минимум две таблицы. Перечисления (ENUM) в группы не входят.

function schemaOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? 'public' : name.slice(0, i);
}

function baseName(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? name : name.slice(i + 1);
}

// Map: имя группы → [имена таблиц] (в исходном порядке).
function computeGroups(names, mode) {
  const groups = new Map();
  const add = (group, name) => {
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(name);
  };

  if (mode === 'schema') {
    for (const name of names) add(schemaOf(name), name);
    if (groups.size < 2) return new Map();
  } else if (mode === 'prefix') {
    const prefixOf = new Map();
    for (const name of names) {
      const base = baseName(name);
      const i = base.indexOf('_');
      if (i > 0) prefixOf.set(name, schemaOf(name) === 'public' ? base.slice(0, i) : `${schemaOf(name)}.${base.slice(0, i)}`);
    }
    const prefixes = new Set(prefixOf.values());
    for (const name of names) {
      let group = prefixOf.get(name);
      if (!group) {
        // courses → course, classes → class, categories → category
        const base = baseName(name);
        const scoped = s => (schemaOf(name) === 'public' ? s : `${schemaOf(name)}.${s}`);
        const candidates = [base, base.replace(/s$/, ''), base.replace(/es$/, ''), base.replace(/ies$/, 'y')].map(scoped);
        group = candidates.find(c => prefixes.has(c));
      }
      if (group) add(group, name);
    }
  } else {
    return new Map();
  }

  for (const [group, members] of groups) if (members.length < 2) groups.delete(group);
  return groups;
}

// Рамка группы вокруг таблиц: место под название сверху, небольшие поля по бокам и снизу.
const FRAME_TOP = 34;
const FRAME_SIDE = 18;
const FRAME_BOTTOM = 18;

// Рамка — прямоугольник без заливки позади таблиц; pointerEvents=0 — клики внутри
// проходят к таблицам. sqlErGroup=1 — метка «рамка плагина» (для «Обновить» и
// «Перепроложить связи»), sqlErGroupBy — как группировали.
const FRAME_STYLE = 'rounded=1;arcSize=2;absoluteArcSize=1;html=1;whiteSpace=wrap;fillColor=none;' +
  'dashed=1;dashPattern=6 4;opacity=60;pointerEvents=0;connectable=0;' +
  'verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fontSize=13;sqlErGroup=1;';

function frameBounds(boxes) {
  const x1 = Math.min(...boxes.map(b => b.x));
  const y1 = Math.min(...boxes.map(b => b.y));
  const x2 = Math.max(...boxes.map(b => b.x + b.width));
  const y2 = Math.max(...boxes.map(b => b.y + b.height));
  return { x: x1 - FRAME_SIDE, y: y1 - FRAME_TOP, width: x2 - x1 + 2 * FRAME_SIDE, height: y2 - y1 + FRAME_TOP + FRAME_BOTTOM };
}

module.exports = { computeGroups, frameBounds, FRAME_STYLE, FRAME_TOP, FRAME_SIDE, FRAME_BOTTOM };
