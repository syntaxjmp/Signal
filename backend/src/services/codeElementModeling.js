/**
 * Regex-based code element extraction for MVP graph-like modeling.
 */

const ROUTE_PATTERN = /\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const MIDDLEWARE_PATTERN = /\.use\s*\(\s*([A-Za-z_$][\w$]*)/g;
const DB_CALL_PATTERN = /\.(query|execute|raw)\s*\(/g;
const AUTH_PATTERN = /\b(auth|authorize|permission|rbac|acl)\w*/gi;

function lineAt(content, idx) {
  return content.slice(0, idx).split(/\r?\n/).length;
}

export function extractCodeElementsFromFile({ filePath, content }) {
  if (!content || !filePath) return [];
  const out = [];
  let m;

  ROUTE_PATTERN.lastIndex = 0;
  while ((m = ROUTE_PATTERN.exec(content))) {
    out.push({
      elementType: 'route',
      filePath,
      lineStart: lineAt(content, m.index),
      identifier: `${m[1].toUpperCase()} ${m[2]}`,
      metadata: { method: m[1].toUpperCase(), route: m[2] },
    });
  }

  MIDDLEWARE_PATTERN.lastIndex = 0;
  while ((m = MIDDLEWARE_PATTERN.exec(content))) {
    out.push({
      elementType: 'middleware',
      filePath,
      lineStart: lineAt(content, m.index),
      identifier: m[1],
      metadata: { call: 'use' },
    });
  }

  DB_CALL_PATTERN.lastIndex = 0;
  while ((m = DB_CALL_PATTERN.exec(content))) {
    out.push({
      elementType: 'db_call',
      filePath,
      lineStart: lineAt(content, m.index),
      identifier: m[1],
      metadata: { call: m[1] },
    });
  }

  AUTH_PATTERN.lastIndex = 0;
  while ((m = AUTH_PATTERN.exec(content))) {
    out.push({
      elementType: 'auth_check',
      filePath,
      lineStart: lineAt(content, m.index),
      identifier: m[0],
      metadata: { token: m[0] },
    });
  }

  return out.slice(0, 400);
}
