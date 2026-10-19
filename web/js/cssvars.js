// Reading and editing CSS custom properties inside theme stylesheets.
//
// The styling toolbar never rewrites a theme wholesale: it only changes (or
// adds) `--name: value;` declarations in the theme's first `:root` block, so
// hand-written CSS is left untouched.

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

/** Parse every custom property declaration; later ones win. */
export function parseVars(css) {
  const vars = new Map();
  const clean = stripComments(css || "");
  const re = /(^|[{;\s])(--[\w-]+)\s*:\s*((?:"[^"]*"|'[^']*'|\([^)]*\)|[^;{}"'(])*)/g;
  let m;
  while ((m = re.exec(clean))) {
    vars.set(m[2], m[3].trim());
  }
  return vars;
}

/** Locate the body of the first `:root { ... }` block (outside comments). */
function findRootBlock(css) {
  const clean = stripComments(css);
  const match = /:root\s*\{/.exec(clean);
  if (!match) return null;
  const start = match.index + match[0].length;
  let depth = 1;
  for (let i = start; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}") {
      depth--;
      if (depth === 0) return { start, end: i };
    }
  }
  return null;
}

/** Set a variable in the theme's :root block, adding the block if needed. */
export function setVar(css, name, value) {
  css = css || "";
  const block = findRootBlock(css);
  if (!block) {
    const prefix = `:root {\n    ${name}: ${value};\n}\n`;
    return css.trim() ? `${prefix}\n${css}` : prefix;
  }
  const body = css.slice(block.start, block.end);
  const cleanBody = stripComments(body);
  const re = new RegExp(`(^|[;\\s])(${escapeRe(name)}\\s*:\\s*)((?:"[^"]*"|'[^']*'|\\([^)]*\\)|[^;}"'(])*)`);
  const m = re.exec(cleanBody);
  if (m) {
    const valueStart = block.start + m.index + m[1].length + m[2].length;
    const valueEnd = valueStart + m[3].length;
    return css.slice(0, valueStart) + value + css.slice(valueEnd);
  }
  // Insert before the closing brace, keeping indentation tidy.
  let insertAt = block.end;
  while (insertAt > block.start && /[ \t]/.test(css[insertAt - 1])) insertAt--;
  const needsNewline = css[insertAt - 1] !== "\n";
  const line = `${needsNewline ? "\n" : ""}    ${name}: ${value};\n`;
  return css.slice(0, insertAt) + line + css.slice(insertAt);
}

/** Remove a variable declaration from the theme's :root block. */
export function removeVar(css, name) {
  const block = findRootBlock(css || "");
  if (!block) return css;
  const body = css.slice(block.start, block.end);
  const re = new RegExp(`\\n?[ \\t]*${escapeRe(name)}\\s*:\\s*(?:"[^"]*"|'[^']*'|\\([^)]*\\)|[^;}"'(])*;?[ \\t]*(?:/\\*[^*]*\\*/)?`);
  const updated = body.replace(re, "");
  return css.slice(0, block.start) + updated + css.slice(block.end);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip surrounding quotes from a CSS string value. */
export function unquote(value) {
  const v = (value || "").trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

/** Quote text as a CSS string. */
export function quote(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
