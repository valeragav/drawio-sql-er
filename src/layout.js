'use strict';

// Раскладка таблиц по столбцам — слоистая схема Sugiyama:
//
//   1. Разрыв циклов (жадный алгоритм Eades–Lin–Smyth): если таблицы ссылаются друг
//      на друга по кругу, «против течения» пойдёт как можно меньше связей.
//   2. Столбцы: таблица правее всех своих родителей (самый длинный путь), родитель
//      придвигается к ближайшему ребёнку.
//   3. Длинная связь (через несколько столбцов) получает в каждом промежуточном
//      столбце фиктивный узел — «окно», через которое она пройдёт между таблицами.
//   4. Порядок в столбцах: проходы слева направо и обратно, таблица встаёт по медиане
//      строк, с которыми связана (не по центру таблицы — связи идут от строк), затем
//      перестановки соседей (transpose), пока уменьшается число пересечений.
//      Из нескольких лучших порядков выбирается тот, где у проложенных линий
//      (с дорожками и коридорами) меньше всего пересечений.
//   5. Высота: столбцы заполняются сверху вниз; группа (рамка) — прямоугольный блок
//      на своих столбцах, соседние группы могут стоять рядом.
//   6. Таблицы без связей — сеткой под схемой (а не столбцом справа).

const { planLanes, gapWidth, routeLinks } = require('./routing');
const { computeGroups, FRAME_TOP, FRAME_BOTTOM, FRAME_SIDE } = require('./groups');

const V_GAP = 40;      // между таблицами в столбце
const BAND_GAP = 40;   // от рамки группы до соседей
const WINDOW_GAP = 20; // от таблицы до «окна» длинной связи
const WINDOW_STEP = 12; // между соседними «окнами»
const GRID_H_GAP = 60; // сетка таблиц без связей
const GRID_V_GAP = 40;
const MARGIN = 40;
const SWEEPS = 12;
const MAX_CANDIDATES = 4; // сколько порядков проверить настоящей трассировкой

// ------------------------------------------------------------ 1. циклы

// Порядок узлов, при котором «обратных» связей (из более позднего в более ранний) мало.
function acyclicOrder(names, edges) {
  const out = new Map(names.map(n => [n, new Set()]));
  const inn = new Map(names.map(n => [n, new Set()]));
  for (const [u, v] of edges) {
    if (u === v) continue;
    out.get(u).add(v);
    inn.get(v).add(u);
  }
  const alive = new Set(names);
  const remove = n => {
    alive.delete(n);
    for (const v of out.get(n)) inn.get(v).delete(n);
    for (const u of inn.get(n)) out.get(u).delete(n);
  };
  const left = [];
  const right = [];
  while (alive.size) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of names) {
        if (alive.has(n) && !out.get(n).size) { right.unshift(n); remove(n); changed = true; }
      }
      for (const n of names) {
        if (alive.has(n) && !inn.get(n).size) { left.push(n); remove(n); changed = true; }
      }
    }
    if (!alive.size) break;
    let best = null;
    for (const n of names) {
      if (!alive.has(n)) continue;
      const d = out.get(n).size - inn.get(n).size;
      if (best === null || d > best.d) best = { n, d };
    }
    left.push(best.n);
    remove(best.n);
  }
  return new Map(left.concat(right).map((n, i) => [n, i]));
}

// ------------------------------------------------------------ 2. столбцы

function computeLevels(names, relations) {
  const rank = acyclicOrder(names, relations.map(r => [r.parent, r.child]));
  // Связь «вперёд» — от родителя к ребёнку; попавшая в цикл — разворачивается.
  const parents = new Map(names.map(n => [n, new Set()]));
  const children = new Map(names.map(n => [n, new Set()]));
  for (const r of relations) {
    if (r.parent === r.child) continue;
    const [u, v] = rank.get(r.parent) < rank.get(r.child) ? [r.parent, r.child] : [r.child, r.parent];
    parents.get(v).add(u);
    children.get(u).add(v);
  }

  const level = new Map();
  const visit = n => {
    if (level.has(n)) return level.get(n);
    let lvl = 0;
    for (const p of parents.get(n)) lvl = Math.max(lvl, visit(p) + 1);
    level.set(n, lvl);
    return lvl;
  };
  names.forEach(visit);

  // Родитель придвигается к детям: встаёт в столбец прямо перед ближайшим ребёнком,
  // чтобы связи не перескакивали через столбцы (например, справочник, на который
  // ссылается только одна «далёкая» таблица).
  const byLevelDesc = names.slice().sort((a, b) => level.get(b) - level.get(a));
  for (const n of byLevelDesc) {
    const kids = [...children.get(n)];
    if (!kids.length) continue;
    const target = Math.min(...kids.map(c => level.get(c))) - 1;
    if (target > level.get(n)) level.set(n, target);
  }
  return level;
}

// ------------------------------------------------------------ раскладка

// graph: { nodes, relations } из schemaGraph; sizes: имя → { width, height }.
// Возвращает boxes (имя → { node, rows, width, height, x, y }), группы и «окна»
// длинных связей: via — связь → Y её прохода через промежуточные столбцы
// (по порядку от родителя к ребёнку).
function layout(graph, sizes, opts) {
  const { nodes, relations } = graph;
  const names = nodes.map(n => n.name);

  const boxes = new Map();
  for (const n of nodes) {
    const { width, height } = sizes.get(n.name);
    boxes.set(n.name, { node: n, rows: n.rows, width, height, x: 0, y: 0 });
  }

  const linked = new Set();
  for (const r of relations) { linked.add(r.parent); linked.add(r.child); }

  const groups = computeGroups(nodes.filter(n => n.kind !== 'enum').map(n => n.name), opts.groupBy);
  const groupOf = new Map();
  for (const [g, members] of groups) members.forEach(n => groupOf.set(n, g));

  // --- столбцы
  const level = computeLevels(names.filter(n => linked.has(n)), relations);
  const levels = [...new Set(level.values())].sort((a, b) => a - b);
  const colOfLevel = new Map(levels.map((l, i) => [l, i]));
  const order = levels.map(() => []);
  const columnOf = new Map();
  for (const n of names) {
    if (!linked.has(n)) continue;
    const c = colOfLevel.get(level.get(n));
    order[c].push(n);
    columnOf.set(n, c);
  }

  // Таблица без связей из группы, у которой есть связанные таблицы, — в столбец группы;
  // остальные — в сетку под схемой.
  const grid = [];
  for (const n of names) {
    if (linked.has(n)) continue;
    const g = groupOf.get(n);
    const cols = g ? groups.get(g).filter(m => columnOf.has(m)).map(m => columnOf.get(m)) : [];
    if (cols.length) {
      const c = Math.max(...cols);
      order[c].push(n);
      columnOf.set(n, c);
    } else {
      grid.push(n);
    }
  }

  // --- «окна» длинных связей
  const items = new Map(); // все узлы столбцов: таблицы и окна
  for (const n of columnOf.keys()) items.set(n, { name: n, box: boxes.get(n), height: boxes.get(n).height, y: 0 });
  const windows = new Map(); // связь → [имена окон от родителя к ребёнку]
  relations.forEach((r, i) => {
    if (r.parent === r.child) return;
    const a = columnOf.get(r.parent);
    const b = columnOf.get(r.child);
    if (Math.abs(a - b) < 2) return;
    const step = a < b ? 1 : -1;
    const list = [];
    // Связь внутри группы идёт через окна этой же группы (не выходит из рамки).
    const g = groupOf.get(r.parent) && groupOf.get(r.parent) === groupOf.get(r.child) ? groupOf.get(r.parent) : null;
    for (let c = a + step; c !== b; c += step) {
      const name = `\u0001${i}:${c}`;
      items.set(name, { name, window: true, height: 0, y: 0 });
      if (g) groupOf.set(name, g);
      order[c].push(name);
      columnOf.set(name, c);
      list.push(name);
    }
    windows.set(r, list);
  });

  // --- отрезки между соседними столбцами (для порядка и подсчёта пересечений)
  // Конец отрезка: узел и колонка-строка (у окна — нет).
  const segments = order.map(() => []); // segments[c] — между столбцами c и c + 1
  relations.forEach(r => {
    if (r.parent === r.child) return;
    const chain = [{ n: r.parent, col: r.parentColumn }]
      .concat((windows.get(r) || []).map(n => ({ n, col: null })))
      .concat([{ n: r.child, col: r.childColumn }]);
    for (let k = 1; k < chain.length; k++) {
      let [p, q] = [chain[k - 1], chain[k]];
      if (columnOf.get(p.n) === columnOf.get(q.n)) continue;
      if (columnOf.get(p.n) > columnOf.get(q.n)) [p, q] = [q, p];
      segments[columnOf.get(p.n)].push({ left: p, right: q });
    }
  });

  const rowIndex = new Map(); // "имя\0колонка" → номер строки
  const rowOffset = new Map(); // "имя\0колонка" → Y середины строки от верха таблицы
  for (const box of boxes.values()) {
    box.rows.forEach((row, i) => {
      if (!row.column) return;
      rowIndex.set(box.node.name + '\u0000' + row.column, i);
      rowOffset.set(box.node.name + '\u0000' + row.column, row.y + row.height / 2);
    });
  }
  const portY = end => {
    const it = items.get(end.n);
    const off = end.col == null ? null : rowOffset.get(end.n + '\u0000' + end.col);
    return it.y + (off == null ? it.height / 2 : off);
  };

  // --- 5. высота: столбцы сверху вниз, группа — блок на своих столбцах
  const unitOf = n => (groupOf.has(n) ? 'g\u0000' + groupOf.get(n) : n);

  function gapBetween(last, next) {
    if (!last) return 0;
    if (last === 'window' && next === 'window') return WINDOW_STEP;
    if (last === 'window' || next === 'window') return WINDOW_GAP;
    if (last === 'frame' || next === 'frame') return BAND_GAP;
    return V_GAP;
  }

  function placeY(cols) {
    const top = opts.y + MARGIN;
    const state = cols.map(() => ({ bottom: top, last: null }));
    const queues = cols.map(c => c.slice());
    const members = new Map(); // блок → { cols: [c...] }
    cols.forEach((col, c) => col.forEach(n => {
      const u = unitOf(n);
      if (!members.has(u)) members.set(u, new Set());
      members.get(u).add(c);
    }));

    const ready = u => [...members.get(u)].every(c => unitOf(queues[c][0]) === u);
    const kind = n => (items.get(n).window ? 'window' : 'table');

    const placeUnit = u => {
      const colsOf = [...members.get(u)];
      if (!u.startsWith('g\u0000')) {
        const c = colsOf[0];
        const n = queues[c].shift();
        const s = state[c];
        const it = items.get(n);
        it.y = s.bottom + gapBetween(s.last, kind(n));
        s.bottom = it.y + it.height;
        s.last = kind(n);
        return;
      }
      // Группа: рамка на столбцах от первого до последнего своего.
      const lo = Math.min(...colsOf);
      const hi = Math.max(...colsOf);
      let frameTop = -Infinity;
      for (let c = lo; c <= hi; c++) frameTop = Math.max(frameTop, state[c].bottom + gapBetween(state[c].last, 'frame'));
      let bottom = frameTop + FRAME_TOP;
      for (const c of colsOf) {
        let y = frameTop + FRAME_TOP;
        let last = null;
        queues[c] = queues[c].filter(n => {
          if (unitOf(n) !== u) return true;
          const it = items.get(n);
          it.y = y + gapBetween(last, kind(n));
          y = it.y + it.height;
          last = kind(n);
          return false;
        });
        bottom = Math.max(bottom, y);
      }
      for (let c = lo; c <= hi; c++) state[c] = { bottom: bottom + FRAME_BOTTOM, last: 'frame' };
    };

    const placed = new Set();
    while (placed.size < members.size) {
      // Из готовых блоков — тот, что встанет выше всех (заполняет «дыры»).
      let pick = null;
      let pickTop = Infinity;
      for (let c = 0; c < queues.length; c++) {
        const head = queues[c][0];
        if (head === undefined || !ready(unitOf(head))) continue;
        const u = unitOf(head);
        const cs = [...members.get(u)];
        const t = Math.max(...cs.map(k => state[k].bottom));
        if (t < pickTop) { pick = u; pickTop = t; }
      }
      if (!pick) {
        // Порядки столбцов противоречат друг другу — ставим блок первого столбца.
        const c = queues.findIndex(q => q.length);
        pick = unitOf(queues[c][0]);
        for (const k of members.get(pick)) {
          const rest = queues[k].filter(n => unitOf(n) !== pick);
          queues[k] = queues[k].filter(n => unitOf(n) === pick).concat(rest);
        }
      }
      placeUnit(pick);
      placed.add(pick);
    }
  }

  // --- 4. порядок в столбцах
  const median = values => {
    if (!values.length) return null;
    const v = values.slice().sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };

  // Отрезки у каждого узла: к соседям слева и справа.
  const toLeft = new Map();
  const toRight = new Map();
  for (const n of items.keys()) { toLeft.set(n, []); toRight.set(n, []); }
  segments.flat().forEach(seg => { toLeft.get(seg.right.n).push(seg); toRight.get(seg.left.n).push(seg); });

  // Сортировка столбца по медиане соседей; блок группы остаётся непрерывным.
  function sortColumn(c, forward) {
    const key = new Map();
    for (const n of order[c]) {
      const ys = forward
        ? toLeft.get(n).map(seg => portY(seg.left))
        : toRight.get(n).map(seg => portY(seg.right));
      const m = median(ys);
      key.set(n, m === null ? items.get(n).y + items.get(n).height / 2 : m);
    }
    const unitKey = new Map();
    for (const n of order[c]) {
      const u = unitOf(n);
      if (!unitKey.has(u)) unitKey.set(u, []);
      unitKey.get(u).push(key.get(n));
    }
    const avg = u => unitKey.get(u).reduce((a, b) => a + b, 0) / unitKey.get(u).length;
    order[c].sort((a, b) => (avg(unitOf(a)) - avg(unitOf(b))) ||
      (unitOf(a) < unitOf(b) ? -1 : unitOf(a) > unitOf(b) ? 1 : 0) || (key.get(a) - key.get(b)));
  }

  // Пересечения отрезков между столбцами c и c + 1 (по порядку узлов и строк).
  const position = new Map();
  const refreshPositions = c => order[c].forEach((n, i) => position.set(n, i));
  order.forEach((_, c) => refreshPositions(c));
  const endRank = end => {
    const row = end.col == null ? null : rowIndex.get(end.n + '\u0000' + end.col);
    return position.get(end.n) * 1000 + (row == null ? 500 : row);
  };
  // Число пересечений = число «инверсий»: отрезки упорядочены по левому концу,
  // считаем пары, у которых правые концы идут в обратном порядке (сортировка слиянием).
  function crossings(c) {
    const segs = (segments[c] || []).map(seg => [endRank(seg.left), endRank(seg.right)])
      .sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let count = 0;
    const sortCount = arr => {
      if (arr.length < 2) return arr;
      const mid = arr.length >> 1;
      const a = sortCount(arr.slice(0, mid));
      const b = sortCount(arr.slice(mid));
      const out = [];
      let i = 0, j = 0;
      while (i < a.length && j < b.length) {
        if (b[j][1] < a[i][1] && b[j][0] !== a[i][0]) {
          // b[j] правее всех оставшихся в a — пересекается с каждым (кроме общего левого конца)
          let k = i;
          while (k < a.length) { if (a[k][0] !== b[j][0]) count++; k++; }
          out.push(b[j++]);
        } else if (b[j][1] < a[i][1]) {
          out.push(b[j++]);
        } else {
          out.push(a[i++]);
        }
      }
      return out.concat(a.slice(i), b.slice(j));
    };
    sortCount(segs);
    return count;
  }

  // Пересечения только между отрезками узлов a и b (для перестановки соседей).
  function pairCrossings(a, b) {
    let count = 0;
    const side = (sa, sb, far) => {
      for (const p of sa) for (const q of sb) {
        const fp = endRank(p[far]);
        const fq = endRank(q[far]);
        if (fp > fq) count++; // a выше b, а их соседи — наоборот
      }
    };
    side(toLeft.get(a), toLeft.get(b), 'left');
    side(toRight.get(a), toRight.get(b), 'right');
    return count;
  }
  const totalCrossings = () => order.reduce((sum, _, c) => sum + crossings(c), 0);
  const verticalLength = () => segments.flat().reduce((sum, s) => sum + Math.abs(portY(s.left) - portY(s.right)), 0);

  // Перестановка соседей в столбце, если так меньше пересечений.
  function transpose() {
    let improved = true;
    for (let pass = 0; improved && pass < 6; pass++) {
      improved = false;
      for (let c = 0; c < order.length; c++) {
        for (let i = 0; i + 1 < order[c].length; i++) {
          const a = order[c][i];
          const b = order[c][i + 1];
          const ga = groupOf.get(a) || null;
          const gb = groupOf.get(b) || null;
          if (ga !== gb) continue; // группа остаётся непрерывной
          if (pairCrossings(b, a) < pairCrossings(a, b)) {
            order[c][i] = b;
            order[c][i + 1] = a;
            position.set(a, i + 1);
            position.set(b, i);
            improved = true;
          }
        }
      }
    }
  }

  placeY(order);
  const snapshot = () => order.map(c => c.slice());
  const score = () => [totalCrossings(), verticalLength()];
  const better = (p, q) => p[0] < q[0] || (p[0] === q[0] && p[1] < q[1] - 0.5);

  // Кандидаты — порядок после каждого прохода; лучший по оценке пересечений
  // между столбцами и ещё несколько последних проверяются настоящей трассировкой.
  const candidates = new Map([[JSON.stringify(order), snapshot()]]);
  let best = snapshot();
  let bestScore = score();
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const forward = sweep % 2 === 0;
    for (let k = 0; k < order.length; k++) {
      const c = forward ? k : order.length - 1 - k;
      sortColumn(c, forward);
      refreshPositions(c);
      placeY(order);
    }
    transpose();
    placeY(order);
    candidates.set(JSON.stringify(order), snapshot());
    const s = score();
    if (better(s, bestScore)) {
      bestScore = s;
      best = snapshot();
    }
  }
  // Для проверки трассировкой — лучший по оценке и последние проходы (не больше MAX_CANDIDATES).
  const checked = [best].concat([...candidates.values()].reverse()).filter((c, i, all) =>
    all.findIndex(o => JSON.stringify(o) === JSON.stringify(c)) === i).slice(0, MAX_CANDIDATES);

  const rowCenter = (table, column) => {
    const box = boxes.get(table);
    const off = column == null ? null : rowOffset.get(table + '\u0000' + column);
    return box.y + (off == null ? box.height / 2 : off);
  };
  const tableColumn = new Map([...columnOf].filter(([n]) => boxes.has(n)));

  // Применить порядок: Y, «окна» длинных связей, ширина каналов под дорожки и X столбцов.
  function realize(cols) {
    cols.forEach((col, c) => { order[c] = col.slice(); refreshPositions(c); });
    placeY(order);
    for (const it of items.values()) if (it.box) it.box.y = it.y;
    const via = new Map();
    for (const [r, list] of windows) via.set(r, list.map(n => items.get(n).y));
    const lanes = planLanes(buildLinks(relations, rowCenter, via), tableColumn);
    const columnWidth = order.map(col => Math.max(0, ...col.filter(n => boxes.has(n)).map(n => boxes.get(n).width)));
    let x = opts.x + MARGIN;
    order.forEach((col, c) => {
      col.forEach(n => { if (boxes.has(n)) boxes.get(n).x = x; });
      x += columnWidth[c] + (c + 1 < order.length ? gapWidth(lanes, c) : 0);
    });
    return { via, right: x };
  }

  let chosen = null;
  for (const cols of checked) {
    const { via } = realize(cols);
    const links = buildLinks(relations, rowCenter, via);
    const tables = [...tableColumn.keys()].map(n => {
      const b = boxes.get(n);
      return { id: n, x: b.x, y: b.y, width: b.width, height: b.height };
    });
    const drawn = routeScore(links, routeLinks(links, tables), boxes);
    if (!chosen || better(drawn, chosen.score)) chosen = { cols, score: drawn };
  }
  const { via, right } = realize(chosen ? chosen.cols : best);

  // --- 6. сетка таблиц без связей под схемой
  if (grid.length) placeGrid(grid, boxes, groupOf, groups, opts, order.length ? right - opts.x - MARGIN : 0);

  return { boxes, rowCenter, groups, via };
}

// Оценка проложенных линий: [пересечения, суммарная длина].
function routeScore(links, routes, boxes) {
  const segs = [];
  let length = 0;
  links.forEach((l, i) => {
    const r = routes[i];
    const s = boxes.get(l.from);
    const t = boxes.get(l.to);
    const line = [{ x: r.exit === 'right' ? s.x + s.width : s.x, y: l.sy }, ...r.points,
      { x: r.entry === 'right' ? t.x + t.width : t.x, y: l.ty }];
    for (let k = 1; k < line.length; k++) {
      const a = line[k - 1];
      const b = line[k];
      length += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (a.x !== b.x || a.y !== b.y) segs.push({ key: l.key, a, b });
    }
  });
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i];
      const q = segs[j];
      if (p.key === q.key) continue;
      const pv = p.a.x === p.b.x;
      if (pv === (q.a.x === q.b.x)) continue;
      const v = pv ? p : q;
      const h = pv ? q : p;
      if (v.a.x > Math.min(h.a.x, h.b.x) && v.a.x < Math.max(h.a.x, h.b.x) &&
          h.a.y > Math.min(v.a.y, v.b.y) && h.a.y < Math.max(v.a.y, v.b.y)) crossings++;
    }
  }
  return [crossings, length];
}

// Таблицы без связей — рядами слева направо под схемой; группа из таких таблиц —
// блок-рамка со своей маленькой сеткой.
function placeGrid(grid, boxes, groupOf, groups, opts, diagramWidth) {
  const area = grid.reduce((s, n) => s + (boxes.get(n).width + GRID_H_GAP) * (boxes.get(n).height + GRID_V_GAP), 0);
  const limit = Math.max(diagramWidth, Math.sqrt(area) * 1.6, 600);

  // Ряды фиксированной ширины; возвращает размер занятого места.
  function pack(list, width, x0, y0) {
    let x = x0, y = y0, rowH = 0, right = x0;
    for (const it of list) {
      if (x > x0 && x + it.width > x0 + width) {
        x = x0;
        y += rowH + GRID_V_GAP;
        rowH = 0;
      }
      it.place(x, y);
      x += it.width + GRID_H_GAP;
      rowH = Math.max(rowH, it.height);
      right = Math.max(right, x - GRID_H_GAP);
    }
    return { width: right - x0, height: y + rowH - y0 };
  }
  const table = n => ({
    width: boxes.get(n).width,
    height: boxes.get(n).height,
    place: (x, y) => { boxes.get(n).x = x; boxes.get(n).y = y; }
  });

  const list = [];
  const done = new Set();
  for (const n of grid) {
    if (done.has(n)) continue;
    const g = groupOf.get(n);
    if (!g) { list.push(table(n)); continue; }
    const members = groups.get(g).filter(m => grid.includes(m));
    members.forEach(m => done.add(m));
    const inner = members.map(table);
    const innerWidth = Math.max(...inner.map(t => t.width), Math.sqrt(inner.reduce((s, t) => s + (t.width + GRID_H_GAP) * (t.height + GRID_V_GAP), 0)) * 1.4);
    const size = pack(inner, innerWidth, 0, 0); // пробная раскладка — узнать размер
    list.push({
      width: size.width + 2 * FRAME_SIDE,
      height: size.height + FRAME_TOP + FRAME_BOTTOM,
      place: (x, y) => pack(inner, innerWidth, x + FRAME_SIDE, y + FRAME_TOP)
    });
  }

  const placedAbove = [...boxes.values()].filter(b => !grid.includes(b.node.name));
  const top = placedAbove.length
    ? Math.max(...placedAbove.map(b => b.y + b.height)) + BAND_GAP + V_GAP + FRAME_BOTTOM
    : opts.y + MARGIN;
  pack(list, limit, opts.x + MARGIN, top);
}

// Линии для связей: основная — по первой паре колонок внешнего ключа;
// для составного ключа остальные пары — дополнительные (пунктир без значков).
// from/to — таблицы, key — строка-источник (общий «ствол»), sy/ty — Y строк,
// via — Y прохода через промежуточные столбцы (если раскладка оставила «окна»).
function buildLinks(relations, rowCenter, via) {
  const links = [];
  relations.forEach(rel => {
    const pairs = [{ parentColumn: rel.parentColumn, childColumn: rel.childColumn }]
      .concat(rel.extraColumns || []);
    pairs.forEach((pair, k) => links.push({
      rel,
      primary: k === 0,
      parentColumn: pair.parentColumn,
      childColumn: pair.childColumn,
      from: rel.parent,
      to: rel.child,
      kind: rel.kind || 'fk',
      key: rel.parent + '\u0000' + (pair.parentColumn == null ? '' : pair.parentColumn),
      sy: rowCenter(rel.parent, pair.parentColumn),
      ty: rowCenter(rel.child, pair.childColumn),
      // Окна — только для основной линии: пунктир составного ключа идёт своим коридором.
      via: k === 0 && via ? via.get(rel) : undefined
    }));
  });
  return links;
}

module.exports = { layout, buildLinks, acyclicOrder, computeLevels };
