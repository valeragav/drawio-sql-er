'use strict';

// Ортогональная трассировка связей между таблицами.
//
// Таблицы группируются в «столбцы» по фактическому расположению (пересекающиеся по X).
// Между соседними столбцами — свободный канал, в нём вертикальные «дорожки».
// Связь из строки родителя в строку ребёнка:
//   - выходит сбоку до своей дорожки в ближайшем канале;
//   - если таблицы в соседних столбцах — идёт по дорожке до строки ребёнка и входит сбоку;
//   - иначе идёт по горизонтальному «коридору» между таблицами промежуточных столбцов
//     до дорожки в канале у ребёнка, а оттуда — к его строке.
// Связи из одной строки (один источник) делят дорожку — «ствол» с ответвлениями,
// разные источники идут по разным дорожкам. Каналы и коридоры свободны от таблиц,
// поэтому линии не проходят сквозь таблицы.
//
// Работает и для только что построенной раскладки, и для таблиц, которые пользователь
// передвинул (команда «Перепроложить связи»).

const LANE_SPACING = 12;  // расстояние между соседними дорожками в канале
const GAP_PADDING = 36;   // от таблицы до крайней дорожки (место под значки связи)
const MIN_GAP = 100;
const TRACK_STEP = 10;    // шаг горизонтальных дорожек в коридоре
const CLEARANCE = 14;     // отступ коридора от таблиц
const LOOP_OFFSET = 30;   // петля «ссылка на себя» — слева от таблицы

// Столбцы по фактическому расположению: таблицы, пересекающиеся по X, — в одном столбце.
function deriveColumns(tables) {
  const sorted = tables.slice().sort((a, b) => a.x - b.x);
  const columns = [];
  for (const t of sorted) {
    const last = columns[columns.length - 1];
    if (last && t.x < last.right) {
      last.tables.push(t);
      last.right = Math.max(last.right, t.x + t.width);
    } else {
      columns.push({ left: t.x, right: t.x + t.width, tables: [t] });
    }
  }
  const columnOf = new Map();
  columns.forEach((c, i) => c.tables.forEach(t => columnOf.set(t.id, i)));
  return { columns, columnOf };
}

// Какие каналы использует связь: номер канала g — промежуток справа от столбца g.
function gapsOf(link, columnOf) {
  if (link.from === link.to) return [];
  const a = columnOf.get(link.from);
  const b = columnOf.get(link.to);
  if (a < b) return b - 1 === a ? [a] : [a, b - 1];
  if (a > b) return a - 1 === b ? [b] : [a - 1, b];
  return [a];
}

// Дорожки в каждом канале: ключ источника → номер дорожки.
// Порядок — по высоте строки-источника, чтобы стволы меньше пересекались.
function planLanes(links, columnOf) {
  const perGap = new Map();
  for (const link of links) {
    for (const g of gapsOf(link, columnOf)) {
      if (!perGap.has(g)) perGap.set(g, new Map());
      perGap.get(g).set(link.key, link.sy);
    }
  }
  const lanes = new Map();
  for (const [gap, keys] of perGap) {
    const ordered = [...keys].sort((p, q) => p[1] - q[1]).map(([k]) => k);
    lanes.set(gap, new Map(ordered.map((k, i) => [k, i])));
  }
  return lanes;
}

// Ширина канала под заданное число дорожек (для построения раскладки).
function gapWidth(lanes, gap) {
  const n = lanes.has(gap) ? lanes.get(gap).size : 0;
  return Math.max(MIN_GAP, GAP_PADDING * 2 + Math.max(0, n - 1) * LANE_SPACING);
}

// Свободные по вертикали интервалы, общие для набора таблиц.
function freeIntervals(obstacles) {
  const blocked = obstacles
    .map(b => [b.y - CLEARANCE, b.y + b.height + CLEARANCE])
    .sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const iv of blocked) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push(iv.slice());
  }
  const free = [];
  let lo = -Infinity;
  for (const [s, e] of merged) {
    free.push([lo, s]);
    lo = e;
  }
  free.push([lo, Infinity]);
  return free;
}

function candidateTracks(free) {
  const ys = [];
  for (const [lo, hi] of free) {
    if (lo === -Infinity) {
      for (let k = 0; k < 40; k++) ys.push(hi - k * TRACK_STEP);
    } else if (hi === Infinity) {
      for (let k = 0; k < 40; k++) ys.push(lo + k * TRACK_STEP);
    } else {
      const mid = (lo + hi) / 2;
      ys.push(mid);
      for (let d = TRACK_STEP; mid - d >= lo || mid + d <= hi; d += TRACK_STEP) {
        if (mid - d >= lo) ys.push(mid - d);
        if (mid + d <= hi) ys.push(mid + d);
      }
    }
  }
  return ys;
}

// tables: [{ id, x, y, width, height }] — все таблицы (препятствия и столбцы);
// links:  [{ from, to, key, sy, ty }] — связи: таблица-родитель, таблица-ребёнок,
//         ключ источника (строка родителя) и абсолютные Y строк.
// Возвращает массив (по индексу связи): { points: [{x, y}], exit: 'left'|'right', entry: 'left'|'right' }.
function routeLinks(links, tables) {
  const { columns, columnOf } = deriveColumns(tables);
  const lanes = planLanes(links, columnOf);
  const byId = new Map(tables.map(t => [t.id, t]));

  // Дорожки размещаются в фактической ширине канала; если он узкий — плотнее.
  const laneX = (gap, key) => {
    const left = columns[gap].right;
    const right = gap + 1 < columns.length ? columns[gap + 1].left : left + gapWidth(lanes, gap);
    const width = right - left;
    const n = lanes.get(gap).size;
    const pad = Math.min(GAP_PADDING, width / 4);
    const spacing = n > 1 ? Math.min(LANE_SPACING, (width - 2 * pad) / (n - 1)) : 0;
    return left + pad + lanes.get(gap).get(key) * spacing;
  };

  const horizontals = []; // занятые горизонтальные отрезки коридоров
  const conflicts = (y, x1, x2, key) => horizontals.some(h =>
    h.key !== key && Math.abs(h.y - y) < TRACK_STEP - 1 &&
    Math.min(h.x1, h.x2) < Math.max(x1, x2) && Math.min(x1, x2) < Math.max(h.x1, h.x2));

  function corridor(fromCol, toCol, x1, x2, target, key) {
    const middle = [];
    for (let c = Math.min(fromCol, toCol) + 1; c < Math.max(fromCol, toCol); c++) middle.push(...columns[c].tables);
    const tracks = candidateTracks(freeIntervals(middle))
      .sort((p, q) => Math.abs(p - target) - Math.abs(q - target));
    const found = tracks.find(t => !conflicts(t, x1, x2, key));
    const y = found === undefined ? tracks[0] : found;
    horizontals.push({ y, x1, x2, key });
    return y;
  }

  // Сначала короткие связи — им достаются коридоры ближе к прямой линии.
  const span = l => l.from === l.to ? 0 : Math.abs(columnOf.get(l.to) - columnOf.get(l.from));
  const order = links.map((l, i) => i).sort((i, j) => span(links[i]) - span(links[j]) || i - j);

  const routes = [];
  for (const i of order) {
    const link = links[i];
    const { sy, ty, key } = link;

    if (link.from === link.to) {
      const px = byId.get(link.from).x - LOOP_OFFSET;
      routes[i] = { points: [{ x: px, y: sy }, { x: px, y: ty }], exit: 'left', entry: 'left' };
      continue;
    }

    const a = columnOf.get(link.from);
    const b = columnOf.get(link.to);

    if (a === b) {
      // Обе таблицы в одном столбце — по дорожке справа от столбца.
      const x = laneX(a, key);
      routes[i] = { points: [{ x, y: sy }, { x, y: ty }], exit: 'right', entry: 'right' };
      continue;
    }

    const forward = a < b;
    const firstGap = forward ? a : a - 1;
    const lastGap = forward ? b - 1 : b;
    const x1 = laneX(firstGap, key);
    const side = { exit: forward ? 'right' : 'left', entry: forward ? 'left' : 'right' };

    if (firstGap === lastGap) {
      routes[i] = { points: sy === ty ? [] : [{ x: x1, y: sy }, { x: x1, y: ty }], ...side };
      continue;
    }

    const x2 = laneX(lastGap, key);
    const y = corridor(a, b, x1, x2, (sy + ty) / 2, key);
    routes[i] = { points: [{ x: x1, y: sy }, { x: x1, y }, { x: x2, y }, { x: x2, y: ty }], ...side };
  }
  return routes;
}

module.exports = { routeLinks, planLanes, gapWidth, deriveColumns };
