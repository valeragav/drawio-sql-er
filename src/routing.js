'use strict';

// Ортогональная трассировка связей между столбцами таблиц.
//
// Таблицы стоят столбцами; между соседними столбцами — промежуток («канал»).
// Связь из строки родителя (столбец a) к строке ребёнка (столбец b > a):
//   - выходит вправо до своей вертикальной «дорожки» в канале a;
//   - если b = a + 1 — спускается/поднимается до строки ребёнка и входит слева;
//   - иначе идёт по горизонтальному «коридору» между таблицами промежуточных
//     столбцов до дорожки в канале b − 1, а оттуда — к строке ребёнка.
// Связи из одной и той же строки (один источник) делят дорожку — получается
// «ствол» с ответвлениями; разные источники идут по разным дорожкам.

const LANE_SPACING = 12;  // расстояние между соседними дорожками в канале
const GAP_PADDING = 36;   // от таблицы до крайней дорожки (место под значки связи)
const MIN_GAP = 100;
const TRACK_STEP = 10;    // шаг горизонтальных дорожек в коридоре
const CLEARANCE = 14;     // отступ коридора от таблиц

const sourceKey = rel => rel.parent + '\u0000' + rel.parentColumn;

// Какие связи трассируем: только слева направо (родитель левее ребёнка).
// Остальные (циклы ссылок, ссылки внутри столбца, на себя) рисуются как раньше.
function isRoutable(rel, columnOf) {
  return rel.parent !== rel.child && columnOf.get(rel.parent) < columnOf.get(rel.child);
}

// Дорожки в каждом канале: ключ источника → номер дорожки.
// Порядок — по высоте строки-источника, чтобы стволы меньше пересекались.
function planLanes(relations, columnOf, rowCenter) {
  const perGap = new Map();
  const add = (gap, rel) => {
    if (!perGap.has(gap)) perGap.set(gap, new Map());
    perGap.get(gap).set(sourceKey(rel), rowCenter(rel.parent, rel.parentColumn));
  };
  for (const rel of relations) {
    if (!isRoutable(rel, columnOf)) continue;
    const a = columnOf.get(rel.parent);
    const b = columnOf.get(rel.child);
    add(a, rel);
    if (b - 1 !== a) add(b - 1, rel);
  }

  const lanes = new Map();
  for (const [gap, keys] of perGap) {
    const ordered = [...keys].sort((p, q) => p[1] - q[1]).map(([k]) => k);
    lanes.set(gap, new Map(ordered.map((k, i) => [k, i])));
  }
  return lanes;
}

function gapWidth(lanes, gap) {
  const n = lanes.has(gap) ? lanes.get(gap).size : 0;
  return Math.max(MIN_GAP, GAP_PADDING * 2 + Math.max(0, n - 1) * LANE_SPACING);
}

// Свободные по вертикали интервалы, общие для набора столбцов.
function freeIntervals(boxesInColumns) {
  const blocked = boxesInColumns
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

// columns: массив имён таблиц по столбцам; columnX/columnWidth — геометрия столбцов;
// boxes: имя → { x, y, width, height }; rowCenter(table, column) → абсолютный y строки.
// Возвращает Map: индекс связи → массив точек [{x, y}] (или отсутствует — не трассируется).
function routeRelations(relations, { columns, columnX, columnWidth, boxes, columnOf, rowCenter, lanes }) {
  const laneX = (gap, key) => columnX[gap] + columnWidth[gap] + GAP_PADDING + lanes.get(gap).get(key) * LANE_SPACING;

  const horizontals = []; // занятые горизонтальные отрезки коридоров: { y, x1, x2, key }
  const conflicts = (y, x1, x2, key) => horizontals.some(h =>
    h.key !== key && Math.abs(h.y - y) < TRACK_STEP - 1 && h.x1 < x2 && x1 < h.x2);

  // Сначала короткие связи — им достаются коридоры ближе к прямой линии.
  const order = relations
    .map((rel, i) => i)
    .filter(i => isRoutable(relations[i], columnOf))
    .sort((i, j) => {
      const span = k => columnOf.get(relations[k].child) - columnOf.get(relations[k].parent);
      return span(i) - span(j) || i - j;
    });

  const routes = new Map();
  for (const i of order) {
    const rel = relations[i];
    const key = sourceKey(rel);
    const a = columnOf.get(rel.parent);
    const b = columnOf.get(rel.child);
    const sy = rowCenter(rel.parent, rel.parentColumn);
    const ty = rowCenter(rel.child, rel.childColumn);
    const x1 = laneX(a, key);

    if (b === a + 1) {
      routes.set(i, sy === ty ? [] : [{ x: x1, y: sy }, { x: x1, y: ty }]);
      continue;
    }

    const x2 = laneX(b - 1, key);
    const middle = [];
    for (let c = a + 1; c < b; c++) middle.push(...columns[c].map(n => boxes.get(n)));

    const target = (sy + ty) / 2;
    const tracks = candidateTracks(freeIntervals(middle))
      .sort((p, q) => Math.abs(p - target) - Math.abs(q - target));
    const y = tracks.find(t => !conflicts(t, x1, x2, key));
    const track = y === undefined ? tracks[0] : y;
    horizontals.push({ y: track, x1, x2, key });

    routes.set(i, [{ x: x1, y: sy }, { x: x1, y: track }, { x: x2, y: track }, { x: x2, y: ty }]);
  }
  return routes;
}

module.exports = { planLanes, gapWidth, routeRelations, isRoutable };
