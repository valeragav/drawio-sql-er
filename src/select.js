'use strict';

// Выбор части таблиц схемы (для больших схем, когда на страницу нужна только часть).

// Схема только с таблицами из names; связи — только между выбранными таблицами.
// Внешние ключи на невыбранные таблицы остаются в строках колонок (REFERENCES …), но без линий.
function selectTables(schema, names) {
  const keep = new Set(names);
  return Object.assign({}, schema, {
    tables: schema.tables.filter(t => keep.has(t.name)),
    relations: schema.relations.filter(r => keep.has(r.parent) && keep.has(r.child))
  });
}

// Выбранные таблицы + их непосредственные соседи (родители и дети).
function withRelated(schema, names) {
  const selected = new Set(names);
  const result = new Set(names);
  for (const r of schema.relations) {
    if (selected.has(r.parent)) result.add(r.child);
    if (selected.has(r.child)) result.add(r.parent);
  }
  return schema.tables.map(t => t.name).filter(n => result.has(n));
}

module.exports = { selectTables, withRelated };
