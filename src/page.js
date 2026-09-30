'use strict';

// Операции над таблицами и связями, уже стоящими на странице draw.io:
//   - «Перепроложить связи» — заново проложить линии по текущим положениям таблиц;
//   - «Обновить» — привести диаграмму к новой схеме, не двигая существующие таблицы.
// Таблицы плагина помечены в стиле sqlErTable=1 (и sqlErName=<имя>), связи — sqlErLink=1.

const { toGraphModelXml, sideStyle, schemaGraph, DEFAULTS } = require('./drawio');
const { routeLinks } = require('./routing');
const { placeNewTables } = require('./placement');
const { selectTables } = require('./select');
const { computeGroups, frameBounds, FRAME_STYLE } = require('./groups');

const hasFlag = (style, flag) => new RegExp('(^|;)' + flag + '=1(;|$)').test(style || '');

function styleValue(style, key) {
  const m = new RegExp('(?:^|;)' + key + '=([^;]*)').exec(style || '');
  return m ? m[1] : null;
}

function helpers(graph) {
  const model = graph.getModel();
  const isTable = c => model.isVertex(c) && hasFlag(model.getStyle(c), 'sqlErTable');
  const isLink = c => model.isEdge(c) && hasFlag(model.getStyle(c), 'sqlErLink');
  const tableOf = cell => {
    let c = cell;
    while (c && !isTable(c)) c = model.getParent(c);
    return c;
  };
  // Имя таблицы: из метки sqlErName, для старых диаграмм — из подписи.
  const nameOf = c => {
    const encoded = styleValue(model.getStyle(c), 'sqlErName');
    if (encoded) {
      try { return decodeURIComponent(encoded); } catch (e) { /* ниже — подпись */ }
    }
    return String(graph.convertValueToString(c) || '');
  };
  // Все связи плагина на странице. Связь, у которой оба конца в одной таблице (ссылка
  // на себя), draw.io кладёт внутрь этой таблицы — поэтому ищем по всем потомкам слоя.
  const linksOf = layer => model.getDescendants(layer).filter(isLink);
  // Начало координат ячейки-родителя относительно слоя (точки связи задаются в нём).
  const originOf = (cell, layer) => {
    let x = 0;
    let y = 0;
    for (let c = cell; c && c !== layer; c = model.getParent(c)) {
      const g = model.getGeometry(c);
      if (g && !g.relative) {
        x += g.x;
        y += g.y;
      }
    }
    return { x, y };
  };
  return { model, isTable, isLink, tableOf, nameOf, linksOf, originOf, geo: c => model.getGeometry(c) };
}

// -------------------------------------------------- «Перепроложить связи»

// Заново прокладывает все связи плагина на текущей странице. Возвращает число связей.
function reroute(ui) {
  const graph = ui.editor.graph;
  const layer = graph.getDefaultParent();
  const { model, isTable, tableOf, linksOf, originOf, geo } = helpers(graph);

  const tables = graph.getChildVertices(layer).filter(isTable)
    .map(c => ({ id: c.id, x: geo(c).x, y: geo(c).y, width: geo(c).width, height: geo(c).height }));

  // Y середины строки (или середины таблицы, если связь к самой таблице).
  const rowY = (row, table) => {
    const t = geo(table);
    if (row === table) return t.y + t.height / 2;
    const r = geo(row);
    return t.y + r.y + r.height / 2;
  };

  // Рамки групп — по текущим положениям таблиц (тем же способом, что и при вставке).
  const frame = graph.getChildVertices(layer).find(c => hasFlag(model.getStyle(c), 'sqlErGroup'));
  if (frame) refreshFrames(ui, styleValue(model.getStyle(frame), 'sqlErGroupBy') || 'prefix');

  const links = [];
  const edges = [];
  for (const e of linksOf(layer)) {
    const s = model.getTerminal(e, true);
    const t = model.getTerminal(e, false);
    const ts = tableOf(s);
    const tt = tableOf(t);
    if (!ts || !tt || model.getParent(ts) !== layer || model.getParent(tt) !== layer) continue;
    links.push({ from: ts.id, to: tt.id, key: s.id, sy: rowY(s, ts), ty: rowY(t, tt) });
    edges.push(e);
  }
  if (!links.length) return 0;

  const routes = routeLinks(links, tables);

  model.beginUpdate();
  try {
    edges.forEach((e, i) => {
      const route = routes[i];
      let style = model.getStyle(e);
      for (const pair of sideStyle(route).split(';').filter(Boolean)) {
        const [key, value] = pair.split('=');
        style = mxUtils.setStyle(style, key, value);
      }
      model.setStyle(e, style);
      const g = geo(e).clone();
      const o = originOf(model.getParent(e), layer);
      g.points = route.points.map(p => new mxPoint(p.x - o.x, p.y - o.y));
      model.setGeometry(e, g);
    });
  } finally {
    model.endUpdate();
  }
  return links.length;
}

// Пересоздаёт рамки групп на странице: старые рамки плагина удаляются, новые строятся
// вокруг текущих положений таблиц. groupBy: 'none' — рамок нет.
function refreshFrames(ui, groupBy) {
  const graph = ui.editor.graph;
  const layer = graph.getDefaultParent();
  const { model, isTable, nameOf, geo } = helpers(graph);

  const tables = graph.getChildVertices(layer).filter(c => isTable(c) && !nameOf(c).startsWith('enum:'));
  const byName = new Map(tables.map(c => [nameOf(c), c]));
  const groups = computeGroups([...byName.keys()], groupBy);

  model.beginUpdate();
  try {
    for (const c of graph.getChildVertices(layer)) {
      if (hasFlag(model.getStyle(c), 'sqlErGroup')) model.remove(c);
    }
    for (const [name, members] of groups) {
      const f = frameBounds(members.map(n => {
        const g = geo(byName.get(n));
        return { x: g.x, y: g.y, width: g.width, height: g.height };
      }));
      const style = FRAME_STYLE + `sqlErGroupBy=${groupBy};sqlErName=${encodeURIComponent('group:' + name)};`;
      const cell = new mxCell(name, new mxGeometry(f.x, f.y, f.width, f.height), style);
      cell.setVertex(true);
      model.add(layer, cell, 0); // позади таблиц
    }
  } finally {
    model.endUpdate();
  }
  return groups.size;
}

// ------------------------------------------------------------- «Обновить»

// Приводит таблицы плагина на текущей странице к схеме model:
//   - существующие таблицы остаются на месте, у них заменяются строки (колонки,
//     ограничения, индексы); ручные правки стиля таблицы сохраняются;
//   - новые таблицы ставятся рядом со связанными;
//   - таблицы, которых нет в схеме, помечаются (пунктир, полупрозрачно), а не удаляются;
//   - связи пересобираются и перепрокладываются.
// selected — отмеченные в окне таблицы: какие новые добавить. Таблицы, уже стоящие
// на странице, обновляются всегда; неотмеченные таблицы схемы удалёнными не считаются.
// Всё — одна операция (один Ctrl+Z). Возвращает сводку или { error }.
function updatePage(ui, fullSchema, opts, selected) {
  const graph = ui.editor.graph;
  const layer = graph.getDefaultParent();
  const { model, isTable, nameOf, linksOf, geo } = helpers(graph);

  const pageTables = new Map();
  for (const c of graph.getChildVertices(layer)) {
    if (isTable(c)) pageTables.set(nameOf(c), c);
  }
  if (!pageTables.size) {
    return { error: 'На странице нет таблиц, вставленных плагином, — используйте «Вставить».' };
  }

  const inSchema = new Set(fullSchema.tables.map(t => t.name));
  const wanted = new Set(selected || inSchema);
  for (const name of pageTables.keys()) if (inSchema.has(name)) wanted.add(name);
  const schema = selectTables(fullSchema, [...wanted]);
  // Всё, что есть в схеме (таблицы, представления, ENUM). Узел на странице, которого
  // здесь нет, — удалён из схемы; есть, но скрыт галочками/выбором — не трогаем.
  const known = new Set([...inSchema, ...(fullSchema.enums || []).map(e => 'enum:' + e.name)]);

  // Свежая диаграмма по новой схеме — из неё берём строки, размеры и связи.
  const doc = mxUtils.parseXml(toGraphModelXml(schema, opts));
  const fresh = new mxGraphModel();
  new mxCodec(doc).decode(doc.documentElement, fresh);
  const freshLayer = fresh.getChildAt(fresh.getRoot(), 0);
  const freshCells = fresh.getChildren(freshLayer) || [];
  const freshTables = new Map();
  for (const c of freshCells) {
    if (fresh.isVertex(c) && hasFlag(fresh.getStyle(c), 'sqlErTable')) freshTables.set(decodeURIComponent(styleValue(fresh.getStyle(c), 'sqlErName')), c);
  }
  const freshEdges = freshCells.filter(c => fresh.isEdge(c));

  // Места для новых таблиц.
  const existing = [];
  for (const [name, cell] of pageTables) {
    if (freshTables.has(name)) {
      const g = geo(cell);
      existing.push({ name, x: g.x, y: g.y, width: g.width, height: g.height });
    }
  }
  const incoming = [...freshTables]
    .filter(([name]) => !pageTables.has(name))
    .map(([name, cell]) => ({ name, width: fresh.getGeometry(cell).width, height: fresh.getGeometry(cell).height }));
  // Места — по всем связям схемы: внешние ключи, колонка → ENUM, таблица → представление.
  const positions = placeNewTables(existing, incoming, schemaGraph(schema, Object.assign({}, DEFAULTS, opts)).relations);

  const summary = { updated: 0, added: 0, removed: 0, restored: 0, links: 0 };
  const result = new Map(); // имя → таблица на странице
  const addedCells = [];

  model.beginUpdate();
  try {
    // Старые связи плагина удаляем — ниже построим по новой схеме.
    for (const e of linksOf(layer)) model.remove(e);

    for (const [name, freshTable] of freshTables) {
      const rows = fresh.getChildren(freshTable) || [];
      const fg = fresh.getGeometry(freshTable);
      let table = pageTables.get(name);

      if (table) {
        // Существующая таблица: место и стиль те же, строки — новые.
        if (hasFlag(model.getStyle(table), 'sqlErRemoved')) {
          model.setStyle(table, unmarkRemoved(model.getStyle(table)));
          summary.restored++;
        }
        let style = model.getStyle(table);
        style = mxUtils.setStyle(style, 'sqlErTable', '1');
        style = mxUtils.setStyle(style, 'sqlErName', encodeURIComponent(name));
        model.setStyle(table, style);

        for (const child of (model.getChildren(table) || []).slice()) model.remove(child);
        const g = geo(table).clone();
        g.width = Math.max(g.width, fg.width);
        g.height = fg.height;
        model.setGeometry(table, g);
        rows.forEach((row, i) => model.add(table, cloneRow(row, g.width), i));
        summary.updated++;
      } else {
        // Новая таблица — рядом со связанными.
        table = freshTable.clone();
        const g = fg.clone();
        const pos = positions.get(name);
        g.x = pos.x;
        g.y = pos.y;
        table.setGeometry(g);
        model.add(layer, table);
        rows.forEach((row, i) => model.add(table, cloneRow(row, g.width), i));
        addedCells.push(table);
        summary.added++;
      }
      result.set(name, table);
    }

    // Таблицы, которых нет в новой схеме, — пометить, не удалять.
    for (const [name, table] of pageTables) {
      if (freshTables.has(name) || known.has(name) || hasFlag(model.getStyle(table), 'sqlErRemoved')) continue;
      model.setStyle(table, markRemoved(model.getStyle(table)));
      summary.removed++;
    }

    // Связи по новой схеме: строка на свежей диаграмме → та же строка (по порядку) на странице.
    const pageTerminal = freshCell => {
      const freshTable = fresh.isVertex(fresh.getParent(freshCell)) ? fresh.getParent(freshCell) : freshCell;
      const name = decodeURIComponent(styleValue(fresh.getStyle(freshTable), 'sqlErName'));
      const table = result.get(name);
      if (freshTable === freshCell) return table;
      return model.getChildAt(table, (fresh.getChildren(freshTable) || []).indexOf(freshCell));
    };
    for (const e of freshEdges) {
      const source = pageTerminal(fresh.getTerminal(e, true));
      const target = pageTerminal(fresh.getTerminal(e, false));
      if (!source || !target) continue;
      const edge = new mxCell('', new mxGeometry(), fresh.getStyle(e));
      edge.setEdge(true);
      edge.geometry.relative = true;
      model.add(layer, edge);
      model.setTerminal(edge, source, true);
      model.setTerminal(edge, target, false);
      summary.links++;
    }

    reroute(ui);
    refreshFrames(ui, opts.groupBy || 'none');
  } finally {
    model.endUpdate();
  }

  if (addedCells.length) graph.setSelectionCells(addedCells);
  return summary;
}

function cloneRow(row, width) {
  const copy = row.clone();
  const g = copy.getGeometry().clone();
  g.width = width;
  copy.setGeometry(g);
  return copy;
}

function markRemoved(style) {
  style = mxUtils.setStyle(style, 'dashed', '1');
  style = mxUtils.setStyle(style, 'opacity', '50');
  style = mxUtils.setStyle(style, 'textOpacity', '50');
  return mxUtils.setStyle(style, 'sqlErRemoved', '1');
}

function unmarkRemoved(style) {
  for (const key of ['dashed', 'opacity', 'textOpacity', 'sqlErRemoved']) style = mxUtils.setStyle(style, key, null);
  return style;
}

module.exports = { reroute, updatePage, refreshFrames };
