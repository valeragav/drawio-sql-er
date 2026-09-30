'use strict';

// Выбор части таблиц схемы (для больших схем, когда на страницу нужна только часть).
// «Таблицы» здесь — и представления (VIEW): они в том же списке.

// Схема только с таблицами из names; связи — только между выбранными таблицами.
// Внешние ключи на невыбранные таблицы остаются в строках колонок (REFERENCES …), но без линий.
// Перечисления (ENUM) — те, что используют выбранные таблицы; если выбрано всё — все.
function selectTables(schema, names) {
  const keep = new Set(names);
  const all = schema.tables.every(t => keep.has(t.name));
  const enumLinks = (schema.enumLinks || []).filter(l => keep.has(l.table));
  const usedEnums = new Set(enumLinks.map(l => l.enum));
  return Object.assign({}, schema, {
    tables: schema.tables.filter(t => keep.has(t.name)),
    relations: schema.relations.filter(r => keep.has(r.parent) && keep.has(r.child)),
    enums: (schema.enums || []).filter(e => all || usedEnums.has(e.name)),
    enumLinks,
    viewDeps: (schema.viewDeps || []).filter(d => keep.has(d.table) && keep.has(d.view))
  });
}

// Выбранные таблицы + их непосредственные соседи: родители и дети по внешним ключам,
// таблицы из FROM/JOIN представлений и представления, построенные на таблицах.
function withRelated(schema, names) {
  const selected = new Set(names);
  const result = new Set(names);
  for (const r of schema.relations) {
    if (selected.has(r.parent)) result.add(r.child);
    if (selected.has(r.child)) result.add(r.parent);
  }
  for (const d of schema.viewDeps || []) {
    if (selected.has(d.table)) result.add(d.view);
    if (selected.has(d.view)) result.add(d.table);
  }
  return schema.tables.map(t => t.name).filter(n => result.has(n));
}

module.exports = { selectTables, withRelated };
