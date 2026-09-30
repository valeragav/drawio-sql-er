'use strict';

// Подсветка связей выбранной таблицы: выделили таблицу (или любую её строку) —
// её связи и соседние таблицы обводятся красным. Это временная обводка поверх
// диаграммы (mxCellHighlight): диаграмму не меняет, в историю Ctrl+Z не попадает.
// Включается/выключается пунктом меню; состояние запоминается.

const COLOR = '#e53935';
const SETTING = 'sql-er-highlight';

const hasFlag = (style, flag) => new RegExp('(^|;)' + flag + '=1(;|$)').test(style || '');

function installHighlight(ui) {
  const graph = ui.editor.graph;
  const model = graph.getModel();
  if (ui.__sqlErHighlight) ui.__sqlErHighlight.dispose(); // повторная загрузка плагина

  let enabled = true;
  try {
    enabled = localStorage.getItem(SETTING) !== '0';
  } catch (e) { /* хранилище недоступно — по умолчанию включено */ }

  const isTable = c => model.isVertex(c) && hasFlag(model.getStyle(c), 'sqlErTable');
  const isLink = c => model.isEdge(c) && hasFlag(model.getStyle(c), 'sqlErLink');
  const tableOf = cell => {
    let c = cell;
    while (c && !isTable(c)) c = model.getParent(c);
    return c;
  };

  const marks = [];
  const clear = () => {
    marks.forEach(h => h.destroy());
    marks.length = 0;
  };
  const mark = (cell, width) => {
    const state = graph.view.getState(cell);
    if (!state) return;
    const h = new mxCellHighlight(graph, COLOR, width);
    h.highlight(state);
    marks.push(h);
  };

  function update() {
    clear();
    if (!enabled) return;
    const selected = graph.getSelectionCells();
    if (selected.length !== 1) return;
    const table = tableOf(selected[0]);
    if (!table) return;

    const neighbours = new Set();
    for (const e of model.getDescendants(graph.getDefaultParent())) {
      if (!isLink(e)) continue;
      const a = tableOf(model.getTerminal(e, true));
      const b = tableOf(model.getTerminal(e, false));
      if (a !== table && b !== table) continue;
      mark(e, 3);
      if (a && a !== table) neighbours.add(a);
      if (b && b !== table) neighbours.add(b);
    }
    neighbours.forEach(t => mark(t, 2));
  }

  const onSelection = () => update();
  const onModel = () => { if (marks.length) update(); }; // таблицу сдвинули / связи перестроили
  graph.getSelectionModel().addListener(mxEvent.CHANGE, onSelection);
  model.addListener(mxEvent.CHANGE, onModel);

  const api = {
    isEnabled: () => enabled,
    setEnabled(value) {
      enabled = value;
      try {
        localStorage.setItem(SETTING, value ? '1' : '0');
      } catch (e) { /* не страшно */ }
      update();
    },
    dispose() {
      clear();
      graph.getSelectionModel().removeListener(onSelection);
      model.removeListener(onModel);
    }
  };
  ui.__sqlErHighlight = api;
  update();
  return api;
}

module.exports = { installHighlight };
