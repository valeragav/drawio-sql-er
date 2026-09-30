'use strict';

// Легенда в окне плагина: что значат обозначения на диаграмме.
// Раскрывающийся блок «Обозначения»; значки связей нарисованы так же, как на диаграмме
// (цвет — currentColor, чтобы было видно и в тёмной теме draw.io).

const line = (extra = '', dash = '') =>
  `<line x1="2" y1="8" x2="58" y2="8" stroke="currentColor" stroke-width="1.3"${dash ? ` stroke-dasharray="${dash}"` : ''}/>${extra}`;
const bar = x => `<line x1="${x}" y1="3" x2="${x}" y2="13" stroke="currentColor" stroke-width="1.3"/>`;
const circle = x => `<circle cx="${x}" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.3"/>`;
const crowsFoot = '<path d="M46 8 L58 3 M46 8 L58 13 M46 8 L58 8" fill="none" stroke="currentColor" stroke-width="1.3"/>';
const svg = body => `<svg width="60" height="16" viewBox="0 0 60 16" style="vertical-align:middle;flex:none">${body}</svg>`;

const ITEMS = [
  ['🔑 <b>id</b>', 'первичный ключ (жирным)'],
  ['<i>user_id</i>', 'внешний ключ (курсивом)'],
  ['💬', 'у колонки есть комментарий — наведите мышь на строку'],
  ['🔍', 'индекс (в нижнем блоке таблицы, вместе с ограничениями)'],
  ['<span style="border:1px solid currentColor;padding:0 4px">таблица</span>', 'обычная таблица'],
  ['<span style="border:1px dashed currentColor;padding:0 4px">имя (view)</span>', 'представление (VIEW, MATERIALIZED VIEW)'],
  ['<span style="border:1px solid currentColor;border-radius:4px;padding:0 4px"><i>«enum»</i></span>', 'перечисление (ENUM) со значениями'],
  ['<span style="border:1px dashed currentColor;opacity:.6;padding:0 4px">таблица</span>', 'таблицы нет в новой схеме (после «Обновить»)'],
  [svg(line(bar(8) + bar(12)) + ''), 'родитель обязателен (FK NOT NULL)'],
  [svg(line(bar(8) + circle(15))), 'родитель необязателен (FK допускает NULL)'],
  [svg(line(crowsFoot)), '«многие»: у родителя может быть много дочерних строк'],
  [svg(line(circle(47) + bar(54))), '«один к одному» (FK = PK или UNIQUE)'],
  [svg(line('', '4 3')), 'часть составного внешнего ключа'],
  [svg(line('', '2 3')), 'колонка → её ENUM'],
  [svg(line('<path d="M50 3 L58 8 L50 13" fill="none" stroke="currentColor" stroke-width="1.3"/>', '6 4')), 'таблица → представление, которое из неё читает'],
  [svg('<path d="M2 8 H24 A6 6 0 0 1 36 8 H58" fill="none" stroke="currentColor" stroke-width="1.3"/>'), 'линии пересекаются, но не соединены'],
  ['<span style="border:1px dashed currentColor;padding:0 4px;opacity:.7"><b>course</b></span>', 'рамка группы (по схеме или префиксу имени)'],
  ['<span style="border:2px solid #e53935;padding:0 4px">красная</span>', 'связи выбранной таблицы; при сравнении — расходится со схемой'],
  ['<span style="border:2px solid #43a047;padding:0 4px">зелёная</span>', 'при сравнении — есть только на диаграмме'],
  ['⋯ ещё N колонок', 'компактный режим: свёрнутые колонки (список — в подсказке)']
];

function legendNode() {
  const details = document.createElement('details');
  details.style.cssText = 'font-size:12px;';
  const summary = document.createElement('summary');
  summary.textContent = 'Обозначения на диаграмме';
  summary.style.cssText = 'cursor:pointer;opacity:0.85;';
  details.appendChild(summary);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 16px;margin-top:6px;' +
    'max-height:150px;overflow:auto;';
  for (const [sign, text] of ITEMS) {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;';
    const s = document.createElement('span');
    s.style.cssText = 'flex:none;min-width:64px;display:inline-flex;align-items:center;';
    s.innerHTML = sign; // статичная разметка из этого файла
    const t = document.createElement('span');
    t.textContent = text;
    t.style.opacity = '0.85';
    item.appendChild(s);
    item.appendChild(t);
    grid.appendChild(item);
  }
  details.appendChild(grid);
  return details;
}

module.exports = { legendNode };
