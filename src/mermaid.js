'use strict';

// Экспорт схемы в Mermaid (erDiagram) — чтобы вставлять диаграмму в Markdown (GitHub, GitLab, …).
//
//   users {
//       integer id PK
//       varchar(255) email UK "Логин"
//   }
//   users ||--o{ orders : "user_id"
//
// Mermaid принимает не любые имена и типы: имена — буквы, цифры, «_» и «-»; тип — одно
// «слово» (без пробелов и запятых), поэтому numeric(12,2) → numeric(12_2), billing.invoices →
// billing_invoices. ENUM и представлений в Mermaid нет — они идут комментариями %%.

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const TYPE_RE = /^[A-Za-z_][A-Za-z0-9_\-[\]()]*$/;

function mermaidName(name) {
  const s = String(name).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^([^A-Za-z_])/, '_$1');
  return NAME_RE.test(s) ? s : '_';
}

function mermaidType(type) {
  let t = String(type || '').trim().replace(/\s*([(),])\s*/g, '$1').replace(/\s+/g, '_').replace(/,/g, '_');
  if (!TYPE_RE.test(t)) t = t.replace(/\(.*$/, ''); // enum('a','b') → enum
  if (!TYPE_RE.test(t)) t = t.replace(/[^A-Za-z0-9_\-[\]()]/g, '');
  return TYPE_RE.test(t) ? t : 'text';
}

const quote = s => '"' + String(s).replace(/"/g, "'").replace(/\s+/g, ' ').trim() + '"';

// model — модель parser.js. opts.markdown — обернуть в ```mermaid для вставки в .md.
function toMermaid(model, opts = {}) {
  const out = ['erDiagram'];
  const names = new Map(model.tables.map(t => [t.name, mermaidName(t.name)]));

  for (const en of model.enums || []) {
    out.push(`    %% ENUM ${en.name}: ${en.values.join(', ')}`);
  }

  const fkColumns = new Map(); // таблица → колонки внешних ключей
  for (const r of model.relations) {
    if (!fkColumns.has(r.child)) fkColumns.set(r.child, new Set());
    fkColumns.get(r.child).add(r.childColumn);
    (r.extraColumns || []).forEach(p => fkColumns.get(r.child).add(p.childColumn));
  }

  for (const t of model.tables) {
    const kind = t.kind || 'table';
    if (kind !== 'table') out.push(`    %% ${names.get(t.name)} — ${kind === 'view' ? 'представление' : 'материализованное представление'}`);
    if (t.comment) out.push(`    %% ${names.get(t.name)}: ${String(t.comment).replace(/\s+/g, ' ')}`);
    out.push(`    ${names.get(t.name)} {`);
    for (const c of t.columns) {
      const keys = [];
      if (c.primaryKey) keys.push('PK');
      if ((fkColumns.get(t.name) || new Set()).has(c.name)) keys.push('FK');
      if (c.unique && !c.primaryKey) keys.push('UK');
      const type = kind === 'table' ? mermaidType(c.type) : 'column';
      let line = `        ${type} ${mermaidName(c.name)}`;
      if (keys.length) line += ' ' + keys.join(', ');
      if (c.comment) line += ' ' + quote(c.comment);
      out.push(line);
    }
    out.push('    }');
  }

  for (const r of model.relations) {
    const parent = names.get(r.parent);
    const child = names.get(r.child);
    if (!parent || !child) continue;
    const childTable = model.tables.find(t => t.name === r.child);
    const identifying = childTable && (childTable.primaryKey || []).includes(r.childColumn);
    const left = r.optional ? '|o' : '||';
    const right = r.oneToOne ? 'o|' : 'o{';
    out.push(`    ${parent} ${left}${identifying ? '--' : '..'}${right} ${child} : ${quote(r.childColumn)}`);
  }

  for (const d of model.viewDeps || []) {
    out.push(`    %% ${mermaidName(d.view)} читает из ${mermaidName(d.table)}`);
  }

  const text = out.join('\n') + '\n';
  return opts.markdown ? '```mermaid\n' + text + '```\n' : text;
}

module.exports = { toMermaid, mermaidName, mermaidType };
