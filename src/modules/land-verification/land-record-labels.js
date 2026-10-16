/**
 * Human-readable labels for diff field paths, so the app can show changes
 * without knowing each state's record shape:
 *
 *   owners[name=Ram Singh].share   -> section "Owners",  label "Owners (Ram Singh) › Share"
 *   rows[2].area                   -> section "Rows",    label "Rows #3 › Area"
 *   owner_details.father_name      -> section "Owner details", label "Owner details › Father name"
 *   owners[]                       -> section "Owners",  label "Owners"
 *
 * `path` keeps the machine-readable parts for apps that want their own wording.
 */

const SEGMENT = /([^.[\]]+)|\[([^\]]*)\]/g;

const humanize = (name) => {
  const words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
};

/** @returns {{ section: string, label: string, path: Array<{ key?: string, match?: string, index?: number }> }} */
const describeField = (field) => {
  if (!field || field === '(root)') return { section: 'Record', label: 'Record', path: [] };
  const path = [];
  const parts = [];
  for (const [, name, bracket] of String(field).matchAll(SEGMENT)) {
    if (name !== undefined) {
      path.push({ key: name });
      parts.push(humanize(name));
    } else if (/^\d+$/.test(bracket)) {
      path.push({ index: Number(bracket) });
      parts[parts.length - 1] = `${parts[parts.length - 1] || 'Item'} #${Number(bracket) + 1}`;
    } else if (bracket) {
      // "[name=Ram]" (identity match) or "[Ram]" (whole item added/removed)
      const match = bracket.includes('=') ? bracket.slice(bracket.indexOf('=') + 1) : bracket;
      path.push({ match });
      parts[parts.length - 1] = `${parts[parts.length - 1] || 'Item'} (${match})`;
    }
  }
  return { section: humanize(path.find((part) => part.key)?.key || 'Record'), label: parts.filter(Boolean).join(' › ') || 'Record', path };
};

module.exports = { describeField, humanize };
