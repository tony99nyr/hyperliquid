export interface MigrationInventory {
  tables: Map<string, Set<string>>;
  functions: Set<string>;
}

const TABLE_START = /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w.]+)\s*\(/gi;
const ADD_COLUMN = /alter\s+table\s+(?:if\s+exists\s+)?([\w.]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?([\w]+)/gi;
const FUNCTION = /create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(/gi;
const COLUMN_LINE = /^\s*(?!constraint\b|primary\s+key\b|unique\b|check\b|foreign\s+key\b)([a-z_][\w]*)\s+/i;

function cleanIdentifier(value: string): string {
  return value.replaceAll('"', '').replaceAll('`', '').split('.').at(-1) ?? value;
}

function tableColumns(sql: string, start: number): Set<string> {
  const columns = new Set<string>();
  let depth = 1;
  let quote: string | null = null;
  let segment = '';
  for (let index = start; index < sql.length && depth > 0; index += 1) {
    const char = sql[index];
    if (quote) {
      segment += char;
      if (char === quote && sql[index - 1] !== '\\') quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      segment += char;
    } else if (char === '(') {
      depth += 1;
      segment += char;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        const match = COLUMN_LINE.exec(segment);
        if (match) columns.add(match[1].toLowerCase());
        segment = '';
      } else segment += char;
    } else if (char === ',' && depth === 1) {
      const match = COLUMN_LINE.exec(segment);
      if (match) columns.add(match[1].toLowerCase());
      segment = '';
    } else segment += char;
  }
  return columns;
}

const DROP_COLUMN = /alter\s+table\s+(?:if\s+exists\s+)?([\w.]+)\s+drop\s+column\s+(?:if\s+exists\s+)?([\w]+)/gi;
const RENAME_COLUMN = /alter\s+table\s+(?:if\s+exists\s+)?([\w.]+)\s+rename\s+column\s+([\w]+)\s+to\s+([\w]+)/gi;

/** Remove SQL comments so prose inside them is never read as a column name. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function parseMigrationSql(rawSql: string): MigrationInventory {
  const sql = stripComments(rawSql);
  const tables = new Map<string, Set<string>>();
  const functions = new Set<string>();
  for (const match of sql.matchAll(TABLE_START)) {
    const table = cleanIdentifier(match[1]).toLowerCase();
    tables.set(table, tableColumns(sql, (match.index ?? 0) + match[0].length));
  }
  for (const match of sql.matchAll(ADD_COLUMN)) {
    const table = cleanIdentifier(match[1]).toLowerCase();
    const columns = tables.get(table) ?? new Set<string>();
    columns.add(match[2].toLowerCase());
    tables.set(table, columns);
  }
  for (const match of sql.matchAll(DROP_COLUMN)) {
    tables.get(cleanIdentifier(match[1]).toLowerCase())?.delete(match[2].toLowerCase());
  }
  for (const match of sql.matchAll(RENAME_COLUMN)) {
    const columns = tables.get(cleanIdentifier(match[1]).toLowerCase());
    if (columns?.delete(match[2].toLowerCase())) columns.add(match[3].toLowerCase());
  }
  for (const match of sql.matchAll(FUNCTION)) functions.add(cleanIdentifier(match[1]).toLowerCase());
  return { tables, functions };
}

export function mergeMigrationInventories(inventories: MigrationInventory[]): MigrationInventory {
  const merged: MigrationInventory = { tables: new Map(), functions: new Set() };
  for (const inventory of inventories) {
    for (const [table, columns] of inventory.tables) {
      const existing = merged.tables.get(table) ?? new Set<string>();
      columns.forEach((column) => existing.add(column));
      merged.tables.set(table, existing);
    }
    inventory.functions.forEach((fn) => merged.functions.add(fn));
  }
  return merged;
}
