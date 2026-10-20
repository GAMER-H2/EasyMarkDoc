// Markdown helpers for the page editor:
//  - serialising edited page HTML back to Markdown
//  - finding, parsing and rewriting image syntax with attributes
//  - structural edits (Enter, Backspace, merges) performed on Markdown text
//
// A private-use character (MARK) marks the caret position inside Markdown;
// the server renders it like any other character, so after a re-render the
// editor finds it in the page and puts the caret back exactly there.

export const MARK = "\uE000";
export const DROP = "\uE001";
/** Marks the far end of a selection (MARK is the start). */
export const MARK_END = "\uE002";

// ---------------------------------------------------------------------------
// Image attributes: {width=40% align=left wrap shadow=soft .class #id}
// ---------------------------------------------------------------------------

const ATTR_ORDER = [
  "width", "align", "wrap", "inline", "aspect", "zoom", "focus", "rotate", "flip",
  "border", "border-color", "border-style", "radius", "shadow", "opacity",
];
const FLAGS = new Set(["wrap", "inline"]);

/** Parse an attribute string (without braces) into an object. */
export function parseAttrs(raw) {
  const attrs = { classes: [], id: null, extra: [] };
  const tokens = (raw || "").match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const token of tokens) {
    if (token.startsWith(".")) attrs.classes.push(token.slice(1));
    else if (token.startsWith("#")) attrs.id = token.slice(1);
    else {
      const eq = token.indexOf("=");
      const key = (eq < 0 ? token : token.slice(0, eq)).toLowerCase();
      const value = eq < 0 ? true : token.slice(eq + 1).replace(/^"|"$/g, "");
      if (ATTR_ORDER.includes(key)) attrs[key] = value;
      else attrs.extra.push(token);
    }
  }
  return attrs;
}

/** Format attributes back into canonical `key=value` order. */
export function formatAttrs(attrs) {
  const out = [];
  for (const key of ATTR_ORDER) {
    const value = attrs[key];
    if (value === undefined || value === null || value === false || value === "") continue;
    if (FLAGS.has(key)) {
      if (value) out.push(key);
      continue;
    }
    const str = String(value);
    out.push(/\s/.test(str) ? `${key}="${str}"` : `${key}=${str}`);
  }
  for (const c of attrs.classes || []) out.push(`.${c}`);
  if (attrs.id) out.push(`#${attrs.id}`);
  out.push(...(attrs.extra || []));
  return out.join(" ");
}

/** Markdown for an image. */
export function formatImage({ alt = "", src, title = null, attrs = "" }) {
  const safeAlt = alt.replace(/([\[\]\\])/g, "\\$1");
  const dest = /[\s()<>]/.test(src) ? `<${src}>` : src;
  const t = title ? ` "${title.replace(/"/g, '\\"')}"` : "";
  const a = typeof attrs === "string" ? attrs : formatAttrs(attrs);
  return `![${safeAlt}](${dest}${t})${a ? `{${a}}` : ""}`;
}

function matchingBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const end = codeSpanEnd(text, i);
      if (end > 0) {
        i = end - 1;
        continue;
      }
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

function codeSpanEnd(text, i) {
  let run = 0;
  while (text[i + run] === "`") run++;
  let j = i + run;
  while (j < text.length) {
    if (text[j] === "`") {
      let close = 0;
      while (text[j + close] === "`") close++;
      if (close === run) return j + close;
      j += close;
    } else j++;
  }
  return -1;
}

/**
 * Find Markdown images in `text` in document order. Returns objects with
 * start/end offsets, alt, src, title and the raw attribute string.
 */
export function findImages(text) {
  const images = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const end = codeSpanEnd(text, i);
      if (end > 0) i = end - 1;
      else while (text[i + 1] === "`") i++;
      continue;
    }
    if (c !== "!" || text[i + 1] !== "[") continue;
    const close = matchingBracket(text, i + 1);
    if (close < 0) continue;
    const alt = text.slice(i + 2, close);
    let j = close + 1;
    let src = null;
    let title = null;
    if (text[j] === "(") {
      j++;
      while (/\s/.test(text[j] || "")) j++;
      if (text[j] === "<") {
        const end = text.indexOf(">", j);
        if (end < 0) continue;
        src = text.slice(j + 1, end);
        j = end + 1;
      } else {
        let depth = 0;
        const s = j;
        while (j < text.length && !/\s/.test(text[j])) {
          if (text[j] === "(") depth++;
          else if (text[j] === ")") {
            if (depth === 0) break;
            depth--;
          }
          j++;
        }
        src = text.slice(s, j);
      }
      while (/\s/.test(text[j] || "")) j++;
      const q = text[j];
      if (q === '"' || q === "'" || q === "(") {
        const endQ = q === "(" ? ")" : q;
        let k = j + 1;
        while (k < text.length && !(text[k] === endQ && text[k - 1] !== "\\")) k++;
        title = text.slice(j + 1, k).replace(/\\"/g, '"');
        j = k + 1;
        while (/\s/.test(text[j] || "")) j++;
      }
      if (text[j] !== ")") continue;
      j++;
    } else if (text[j] === "[") {
      const end = text.indexOf("]", j);
      if (end < 0) continue;
      src = null; // reference image; destination lives elsewhere
      j = end + 1;
    } else {
      continue;
    }
    let attrs = null;
    if (text[j] === "{") {
      const end = text.indexOf("}", j);
      if (end > 0 && !text.slice(j, end).includes("\n")) {
        attrs = text.slice(j + 1, end);
        j = end + 1;
      }
    }
    images.push({ start: i, end: j, alt, src, title, attrs });
    i = j - 1;
  }
  return images;
}

// ---------------------------------------------------------------------------
// DOM → Markdown
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  "P", "DIV", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "HR", "H1", "H2", "H3", "H4", "H5", "H6",
  "NAV", "SECTION", "FIGURE",
]);

function escapeText(text, ctx) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const prev = text[i - 1];
    const next = text[i + 1];
    switch (c) {
      case "\\":
      case "*":
      case "`":
      case "[":
        out += "\\" + c;
        break;
      case "_":
        out += /[\p{L}\p{N}]/u.test(prev || "") && /[\p{L}\p{N}]/u.test(next || "") ? c : "\\_";
        break;
      case "<":
        out += /[A-Za-z/!?]/.test(next || "") ? "\\<" : c;
        break;
      case "!":
        out += next === "[" ? "\\!" : c;
        break;
      case "~":
      case "=":
        out += next === c || prev === c ? "\\" + c : c;
        break;
      case "|":
        out += ctx.inTable ? "\\|" : c;
        break;
      case "&":
        out += /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(text.slice(i)) ? "\\&" : c;
        break;
      case "{":
        out += ctx.afterImage && i === 0 ? "\\{" : c;
        break;
      default:
        out += c;
    }
  }
  return out;
}

/** Escape characters at the start of lines that would start a new block. */
function escapeLineStarts(text) {
  return text
    .split("\n")
    .map((line) => {
      line = line.replace(/^[ \t]+/, "");
      return line.replace(
        /^(#{1,6}(?=\s|$)|>|[-+*](?=\s|$)|\d{1,9}(?=[.)](\s|$))|=+\s*$|-{3,}\s*$)/,
        (m) => (/^\d/.test(m) ? m.replace(/(\d+)$/, "$1\\") : "\\" + m),
      );
    })
    .join("\n");
}

function codeSpan(text) {
  const runs = text.match(/`+/g) || [];
  const len = Math.max(0, ...runs.map((r) => r.length)) + 1;
  const fence = "`".repeat(len);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return fence + pad + text + pad + fence;
}

const MARKS_RE = /[\uE000\uE002]/g;

function wrapDelim(inner, delim) {
  if (!inner.replace(MARKS_RE, "").trim()) return inner;
  const lead = inner.match(/^\s*/)[0];
  const trail = inner.match(/\s*$/)[0];
  const core = inner.slice(lead.length, inner.length - trail.length);
  return `${lead}${delim}${core}${delim}${trail}`;
}

const normLabel = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Character styles that survive as `<span style>` in the Markdown. */
export const TEXT_STYLE_PROPS = ["color", "background-color", "font-family", "font-size"];

function cssColorHex(value) {
  const m = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!m) return value;
  if (m[4] !== undefined && Number(m[4]) === 0) return "transparent";
  return "#" + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

/** The span's character styles as a compact `style` attribute value. */
function inlineStyle(el) {
  const parts = [];
  for (const prop of TEXT_STYLE_PROPS) {
    let value = el.style.getPropertyValue(prop).trim();
    if (!value) continue;
    if (prop.endsWith("color")) value = cssColorHex(value);
    // Single quotes only: the value sits inside a double-quoted attribute.
    parts.push(`${prop}: ${value.replace(/"/g, "'")}`);
  }
  return parts.join("; ");
}

/** Serialise inline content of `node` to Markdown. */
export function inlineMd(node, ctx = {}) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += escapeText(child.data.replace(/ /g, " "), { ...ctx, afterImage: /\)\}?$/.test(out) && out.endsWith(")") });
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child;
    const tag = el.tagName;
    if (el.classList.contains("emd-ui")) continue; // editor overlays
    switch (tag) {
      case "BR":
        if (el.nextSibling || el.previousSibling) out += "\\\n";
        break;
      case "STRONG":
      case "B": {
        // Avoid ambiguous runs like *** by switching to underscores.
        const inner = inlineMd(el, ctx);
        out += wrapDelim(inner, /^\s*\*|\*\s*$/.test(inner) ? "__" : "**");
        break;
      }
      case "EM":
      case "I": {
        const inner = inlineMd(el, ctx);
        out += wrapDelim(inner, /^\s*\*|\*\s*$/.test(inner) ? "_" : "*");
        break;
      }
      case "DEL":
      case "S":
      case "STRIKE":
        out += wrapDelim(inlineMd(el, ctx), "~~");
        break;
      case "MARK":
        out += wrapDelim(inlineMd(el, ctx), "==");
        break;
      case "U":
        out += `<u>${inlineMd(el, ctx)}</u>`;
        break;
      case "CODE":
        out += codeSpan(el.textContent.replace(/ /g, " "));
        break;
      case "A": {
        if (el.classList.contains("footnote-backref")) break;
        const href = el.getAttribute("href") || "";
        const inner = inlineMd(el, ctx);
        const plain = el.textContent;
        const ref = el.dataset.mdRef;
        if (ref != null) {
          // Reference link: keep it a reference so the definition still applies.
          const form = el.dataset.mdRefForm;
          const same = normLabel(plain) === normLabel(ref);
          if (form === "shortcut" && same) out += `[${inner}]`;
          else if (form !== "full" && same) out += `[${inner}][]`;
          else out += `[${inner}][${ref}]`;
        } else if (plain === href && /^[a-z][a-z0-9+.-]*:/i.test(href)) out += `<${href}>`;
        else if (`mailto:${plain}` === href) out += `<${plain}>`;
        else {
          const title = el.getAttribute("title");
          const dest = /[\s()]/.test(href) ? `<${href}>` : href;
          out += `[${inner}](${dest}${title ? ` "${title.replace(/"/g, '\\"')}"` : ""})`;
        }
        break;
      }
      case "SUP":
        if (el.classList.contains("footnote-ref")) out += `[^${el.dataset.label}]`;
        else out += `<sup>${inlineMd(el, ctx)}</sup>`;
        break;
      case "IMG":
        if (el.closest(".emd-image")) break;
        out += formatImage({
          alt: el.getAttribute("alt") || "",
          src: el.getAttribute("src") || "",
          title: el.getAttribute("title"),
          attrs: "",
        });
        break;
      case "INPUT":
        break;
      case "SPAN":
        if (el.classList.contains("emd-image")) {
          out += imageMd(el, ctx);
        } else if (el.classList.contains("emd-caption")) {
          // handled by imageMd
        } else {
          const style = inlineStyle(el);
          const inner = inlineMd(el, ctx);
          out += style && inner.replace(MARKS_RE, "") ? `<span style="${style}">${inner}</span>` : inner;
        }
        break;
      default:
        if (BLOCK_TAGS.has(tag)) {
          // Stray block inside inline content (from browser editing).
          const inner = inlineMd(el, ctx);
          if (inner) out += (out && !out.endsWith("\n") ? "\\\n" : "") + inner;
        } else {
          const name = tag.toLowerCase();
          out += `<${name}>${inlineMd(el, ctx)}</${name}>`;
        }
    }
  }
  return out;
}

function imageMd(el, ctx) {
  const img = el.querySelector("img");
  const caption = el.querySelector(".emd-caption");
  const title = caption ? inlineMd(caption, ctx).replace(/\n/g, " ").trim() : null;
  return formatImage({
    alt: img?.getAttribute("alt") || "",
    src: img?.getAttribute("src") || "",
    title: title || null,
    attrs: el.dataset.mdAttrs || "",
  });
}

function paragraphText(el, ctx) {
  return escapeLineStarts(inlineMd(el, ctx)).replace(/\\\n$/, "").trim();
}

/**
 * Serialise the children of a container (list item, quote) as blocks.
 * In list items, blocks are separated the way people usually write them:
 * a blank line only between paragraphs or after a nested list/quote.
 */
function childBlocks(el, { listItem = false } = {}) {
  const parts = [];
  let inline = document.createElement("span");
  const flush = () => {
    const text = paragraphText(inline, {});
    if (text) parts.push({ text, kind: "para" });
    inline = document.createElement("span");
  };
  for (const child of [...el.childNodes]) {
    if (child.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has(child.tagName) && !child.classList.contains("emd-image")) {
      flush();
      if (child.classList.contains("alert-title")) continue;
      const md = blockMd(child);
      if (md === null || md === "") continue;
      const kind = child.tagName === "P" ? "para" : ["UL", "OL", "BLOCKQUOTE", "TABLE"].includes(child.tagName) ? "container" : "block";
      parts.push({ text: md, kind });
    } else {
      inline.append(child.cloneNode(true));
    }
  }
  flush();
  let out = "";
  parts.forEach((part, i) => {
    if (i > 0) {
      const prev = parts[i - 1];
      const blank = !listItem || (prev.kind === "para" && part.kind === "para") || prev.kind === "container";
      out += blank ? "\n\n" : "\n";
    }
    out += part.text;
  });
  return out;
}

function listMd(el) {
  const ordered = el.tagName === "OL";
  const start = parseInt(el.getAttribute("start") || "1", 10);
  const items = [...el.children].filter((c) => c.tagName === "LI");
  const loose = items.some((li) => [...li.children].some((c) => c.tagName === "P"));
  return items
    .map((li, idx) => {
      const marker = ordered ? `${start + idx}.` : "-";
      let prefix = `${marker} `;
      const box = li.querySelector(":scope > input[type=checkbox]");
      if (box) prefix += box.checked ? "[x] " : "[ ] ";
      const indent = " ".repeat(marker.length + 1);
      const content = childBlocks(li, { listItem: true });
      const lines = content.split("\n");
      return prefix + lines[0] + lines.slice(1).map((l) => "\n" + (l ? indent + l : "")).join("");
    })
    .join(loose ? "\n\n" : "\n");
}

function tableMd(el) {
  const rows = [...el.querySelectorAll("tr")];
  if (!rows.length) return "";
  const cellText = (cell) =>
    inlineMd(cell, { inTable: true }).replace(/\n/g, " ").replace(/\\\s/g, " ").trim() || " ";
  const header = [...rows[0].children];
  const aligns = header.map((c) => (c.getAttribute("style") || "").match(/text-align:\s*(\w+)/)?.[1] || "");
  const line = (cells) => `| ${cells.join(" | ")} |`;
  const delim = aligns.map((a) => (a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---"));
  const out = [line(header.map(cellText)), line(delim)];
  for (const row of rows.slice(1)) {
    const cells = [...row.children].map(cellText);
    while (cells.length < header.length) cells.push(" ");
    out.push(line(cells.slice(0, header.length)));
  }
  return out.join("\n");
}

/**
 * Serialise one block element to Markdown. Returns null for blocks that
 * can't be round-tripped (raw HTML), which callers must leave untouched.
 */
export function blockMd(el) {
  const tag = el.tagName;
  if (el.classList.contains("emd-raw") || el.classList.contains("footnotes")) return null;
  if (el.classList.contains("emd-toc-block") || el.classList.contains("toc")) return "[TOC]";
  if (el.classList.contains("page-break")) return "\\pagebreak";
  if (/^H[1-6]$/.test(tag)) {
    const level = Number(tag[1]);
    const text = inlineMd(el, {}).replace(/\\?\n/g, " ").trim();
    const id = el.dataset.customId ? ` {#${el.dataset.customId}}` : "";
    return `${"#".repeat(level)} ${text}${id}`;
  }
  switch (tag) {
    case "P":
      return paragraphText(el, {});
    case "UL":
    case "OL":
      return listMd(el);
    case "BLOCKQUOTE": {
      const alert = [...el.classList].find((c) => c.startsWith("alert-"));
      let inner = childBlocks(el);
      if (alert) inner = `[!${alert.slice(6).toUpperCase()}]\n${inner}`;
      return inner
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    }
    case "PRE": {
      let code = el.textContent.replace(/ /g, " ");
      if (code.endsWith("\n")) code = code.slice(0, -1);
      const runs = code.match(/`{3,}/g) || [];
      const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
      return `${fence}${el.dataset.lang || ""}\n${code}\n${fence}`;
    }
    case "TABLE":
      return tableMd(el);
    case "HR":
      return "---";
    default:
      return paragraphText(el, {});
  }
}

// ---------------------------------------------------------------------------
// paged.js fragments
// ---------------------------------------------------------------------------

/**
 * paged.js splits elements that cross a page boundary into fragments that
 * share a `data-ref`. Rebuild the whole element from its fragments.
 */
export function mergeFragments(fragments) {
  const base = fragments[0].cloneNode(true);
  for (const frag of fragments.slice(1)) appendMerged(base, frag.cloneNode(true));
  return base;
}

function appendMerged(target, source) {
  const children = [...source.childNodes];
  const lastEl = [...target.childNodes].reverse().find((n) => n.nodeType === 1 || n.data?.trim());
  const firstEl = children.find((n) => n.nodeType === 1 || n.data?.trim());
  if (
    lastEl?.nodeType === 1 &&
    firstEl?.nodeType === 1 &&
    lastEl.dataset.ref &&
    lastEl.dataset.ref === firstEl.dataset.ref
  ) {
    appendMerged(lastEl, firstEl);
    children.splice(children.indexOf(firstEl), 1);
  }
  target.append(...children);
}

// ---------------------------------------------------------------------------
// Structural edits on Markdown containing MARK
// ---------------------------------------------------------------------------

const PREFIX_RE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(#{1,6}[ \t]+|[-+*][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+(?:\[[ xX]\][ \t]+)?)?/;

function lineAround(md, i) {
  const start = md.lastIndexOf("\n", i - 1) + 1;
  let end = md.indexOf("\n", i);
  if (end < 0) end = md.length;
  return { start, end, line: md.slice(start, end), col: i - start };
}

/** Enter key: returns new Markdown (with MARK) or null to ignore. */
export function enterAt(md, blockTag, { shift = false } = {}) {
  const i = md.indexOf(MARK);
  if (i < 0) return null;
  const before = md.slice(0, i);
  const after = md.slice(i + 1);
  const { line } = lineAround(md, i);
  if (blockTag === "PRE") {
    const indent = line.match(/^[ \t]*/)[0];
    return `${before}\n${indent}${MARK}${after}`;
  }
  if (blockTag === "TABLE") return null;
  const m = PREFIX_RE.exec(line);
  const quote = m[1];
  const lead = m[2];
  const token = m[3] || "";
  const containerPrefix = quote + lead;

  if (/^#/.test(token)) {
    return `${before.replace(/[ \t]+$/, "")}\n\n${MARK}${after.replace(/^[ \t]+/, "")}`;
  }
  if (shift) {
    return `${before}\\\n${containerPrefix}${" ".repeat(token.length)}${MARK}${after}`;
  }
  if (token) {
    // List item.
    const itemText = line.slice(m[0].length).replace(MARK, "");
    if (!itemText.trim()) {
      // Empty item: leave the list.
      const lineStart = md.lastIndexOf("\n", i - 1) + 1;
      const head = md.slice(0, lineStart).replace(/\n+$/, "");
      const tail = after.replace(/^[^\n]*/, "");
      return `${head}\n\n${quote}${lead}${MARK}${tail}`;
    }
    const bullet = token.match(/^[-+*]/);
    const num = token.match(/^(\d+)([.)])/);
    const task = /\[[ xX]\]/.test(token) ? "[ ] " : "";
    const marker = bullet ? bullet[0] : `${Number(num[1]) + 1}${num[2]}`;
    return `${before.replace(/[ \t]+$/, "")}\n${containerPrefix}${marker} ${task}${MARK}${after.replace(/^[ \t]+/, "")}`;
  }
  // Paragraph (possibly inside a quote or list item).
  const blankLine = containerPrefix.replace(/[ \t]+$/, "");
  return `${before.replace(/[ \t]+$/, "")}\n${blankLine}\n${containerPrefix}${MARK}${after.replace(/^[ \t]+/, "")}`;
}

/**
 * Backspace with the caret at the start of a line. Returns
 *   { md }             – the edited Markdown
 *   { merge: "prev" }  – the caret is at the very start of the block
 *   null               – not a structural position; let the browser handle it
 */
export function backspaceAt(md) {
  const i = md.indexOf(MARK);
  if (i < 0) return null;
  const { start, end, line, col } = lineAround(md, i);
  const textBefore = line.slice(0, col);
  const m = PREFIX_RE.exec(textBefore);
  if (m[0].length !== textBefore.length) return null; // caret is inside text
  const rest = line.slice(col + 1);
  if (m[3]) {
    // Remove heading / list marker → plain paragraph text.
    const replaced = m[1] + m[2] + MARK + rest;
    return { md: md.slice(0, start) + replaced + md.slice(end) };
  }
  if (m[1]) {
    const replaced = m[1].replace(/>[ \t]?$/, "") + m[2] + MARK + rest;
    return { md: md.slice(0, start) + replaced + md.slice(end) };
  }
  if (start === 0) return { merge: "prev" };
  // Start of a paragraph inside the block (after a blank line): join it to
  // the previous paragraph.
  const head = md.slice(0, start - 1);
  if (/\n[ \t>]*$/.test(head) || head.trim() === "") {
    const prev = head.replace(/\n[ \t>]*$/, "").replace(/[ \t]+$/, "");
    return { md: prev + MARK + rest.replace(/^[ \t]+/, "") + md.slice(end) };
  }
  return null;
}

/**
 * Insert MARK at `start` and, for a selection, MARK_END at `end`. Returns
 * the text and whether each marker could be placed.
 */
export function insertMarkers(src, start, end = null) {
  let text = src;
  let endMarked = false;
  if (end != null && end > start) {
    const r = insertMarker(text, end, MARK_END);
    text = r.text;
    endMarked = r.marked;
  }
  const r = insertMarker(text, start);
  if (endMarked && r.marked && r.text.indexOf(MARK) > r.text.indexOf(MARK_END)) {
    // The start was nudged past the end: keep just the caret.
    return { text: r.text.replace(MARK_END, ""), marked: true, endMarked: false };
  }
  return { text: r.text, marked: r.marked, endMarked };
}

/** Insert MARK at a source index, nudged out of places it would break syntax. */
export function insertMarker(src, index, mark = MARK) {
  index = Math.max(0, Math.min(src.length, index));
  const { start, line, col: rawCol } = lineAround(src, index);
  let col = rawCol;
  const trimmed = line.trim();
  if (
    /^(```|~~~)/.test(trimmed) ||
    /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(trimmed) && trimmed.includes("-") && trimmed.includes("|") ||
    /^\[[^\]]+\]:/.test(trimmed) ||
    /^\\(pagebreak|newpage)$/.test(trimmed) ||
    /^\[toc\]$/i.test(trimmed) ||
    /^([-*_])(\s*\1){2,}$/.test(trimmed) ||
    /^(=+|-+)$/.test(trimmed) ||
    // HTML blocks (but not paragraphs that start with inline HTML such as a styled span)
    /^<(?!(span|a|b|i|em|strong|u|s|del|ins|mark|code|kbd|sup|sub|small|abbr|img|br)[\s>/])/i.test(trimmed)
  ) {
    return { text: src, marked: false };
  }
  const prefix = PREFIX_RE.exec(line)[0].length;
  if (col < prefix) col = prefix;
  // Not inside a link destination, attribute block or HTML tag.
  const constructs = [/\]\([^)]*\)(\{[^}\n]*\})?/g, /<[^>\n]*>/g, /\{#[^}]*\}\s*$/g];
  for (const re of constructs) {
    let m;
    while ((m = re.exec(line))) {
      if (col > m.index && col < m.index + m[0].length) col = m.index + m[0].length;
    }
  }
  // Don't split a delimiter run like ** or ~~.
  while (col > 0 && col < line.length && /[*_~=`]/.test(line[col]) && line[col - 1] === line[col]) col++;
  const at = start + col;
  return { text: src.slice(0, at) + mark + src.slice(at), marked: true };
}

/** Plain text of a Markdown line (for fuzzy matching). */
export function plainLine(text) {
  return text
    .replace(PREFIX_RE, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)(\{[^}]*\})?/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~=`]/g, "")
    .replace(/\\(.)/g, "$1")
    .trim();
}
