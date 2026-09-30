'use strict';

// Куда поставить новые таблицы при обновлении диаграммы, не двигая существующие.
//
// Новая таблица встаёт:
//   - справа от своего родителя (таблицы, на которую ссылается), если он уже на странице;
//   - иначе слева от своего ребёнка (таблицы, которая ссылается на неё);
//   - иначе под всей диаграммой.
// Если место занято — сдвигается вниз, пока не найдёт свободное.
// Сначала ставятся таблицы, у которых соседи уже на странице, — от них потом цепляются остальные.

const H_GAP = 120;
const V_GAP = 40;
const STEP = 20;
const MAX_STEPS = 400;

const overlaps = (a, b) =>
  a.x < b.x + b.width + V_GAP && b.x < a.x + a.width + V_GAP &&
  a.y < b.y + b.height + V_GAP && b.y < a.y + a.height + V_GAP;

// existing: [{ name, x, y, width, height }] — таблицы, которые остаются на месте;
// incoming: [{ name, width, height }] — новые таблицы;
// relations: [{ parent, child }] — связи по именам таблиц.
// Возвращает Map: имя новой таблицы → { x, y }.
function placeNewTables(existing, incoming, relations) {
  const placed = new Map(existing.map(t => [t.name, t]));
  const occupied = existing.slice();
  const result = new Map();

  const parentsOf = name => relations.filter(r => r.child === name && r.parent !== name).map(r => r.parent);
  const childrenOf = name => relations.filter(r => r.parent === name && r.child !== name).map(r => r.child);

  const bottom = () => occupied.length ? Math.max(...occupied.map(t => t.y + t.height)) : 0;
  const left = () => occupied.length ? Math.min(...occupied.map(t => t.x)) : 0;

  function freeSpot(box) {
    for (let k = 0; k < MAX_STEPS; k++) {
      const candidate = { ...box, y: box.y + k * STEP };
      if (!occupied.some(o => overlaps(candidate, o))) return candidate;
    }
    return { ...box, y: bottom() + V_GAP * 2 };
  }

  const pending = incoming.slice();
  while (pending.length) {
    // Таблица, у которой есть уже поставленный сосед; если таких нет — первая по порядку.
    let index = pending.findIndex(t =>
      parentsOf(t.name).some(p => placed.has(p)) || childrenOf(t.name).some(c => placed.has(c)));
    if (index < 0) index = 0;
    const table = pending.splice(index, 1)[0];

    const parent = parentsOf(table.name).map(p => placed.get(p)).find(Boolean);
    const child = childrenOf(table.name).map(c => placed.get(c)).find(Boolean);

    let start;
    if (parent) start = { x: parent.x + parent.width + H_GAP, y: parent.y };
    else if (child) start = { x: child.x - table.width - H_GAP, y: child.y };
    else start = { x: left(), y: bottom() + V_GAP * 2 };

    const spot = freeSpot({ name: table.name, x: start.x, y: start.y, width: table.width, height: table.height });
    placed.set(table.name, spot);
    occupied.push(spot);
    result.set(table.name, { x: spot.x, y: spot.y });
  }
  return result;
}

module.exports = { placeNewTables };
