// Format bar: a Pages-style inspector laid out as a horizontal bar above the
// source and the pages. Tabs on the left switch between groups of sections:
//
//   Format  › Style | Layout              (text: paragraph styles, fonts, spacing)
//   Format  › Style | Image | Arrange     (when an image is selected)
//   Document› Document | Theme            (page setup, header/footer, theme)
//
// Text and document settings are CSS variables in the theme; image settings
// are attributes on the image's Markdown. With text selected on the page,
// the font, size and colour controls style just that text instead.

import { ICONS } from "./icons.js";
import { quote, unquote } from "./cssvars.js";
import { FONT_STACKS, MONO_STACKS, PAGE_SIZES, MARGIN_PRESETS, PRESETS, PRESET_VARS } from "./style-data.js";

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function toHex(value) {
  const v = (value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("").toLowerCase();
  const ctx = toHex.ctx || (toHex.ctx = document.createElement("canvas").getContext("2d"));
  ctx.fillStyle = "#000000";
  ctx.fillStyle = v;
  return /^#[0-9a-f]{6}$/i.test(ctx.fillStyle) ? ctx.fillStyle : "#000000";
}
const isNone = (v) => /^(transparent|none|rgba\([^)]*,\s*0\))$/i.test((v || "").trim());

/** Paragraph styles and the theme variables behind them. */
const STYLE_VARS = {
  body: { label: "Body", font: "--font-body", size: "--font-size-base", color: "--text-color", align: "--text-align" },
  h1: { label: "Heading 1", font: "--font-heading", size: "--h1-size", color: "--heading-color", weight: "--heading-weight", align: "--heading-align" },
  h2: { label: "Heading 2", font: "--font-heading", size: "--h2-size", color: "--heading-color", weight: "--heading-weight", align: "--heading-align" },
  h3: { label: "Heading 3", font: "--font-heading", size: "--h3-size", color: "--heading-color", weight: "--heading-weight", align: "--heading-align" },
  h4: { label: "Heading 4", font: "--font-heading", size: "--h4-size", color: "--heading-color", weight: "--heading-weight", align: "--heading-align" },
  quote: { label: "Quote", font: "--font-body", size: "--font-size-base", color: "--blockquote-color", align: "--text-align" },
  code: { label: "Code", font: "--font-mono", size: "--code-font-size", mono: true },
  table: { label: "Table", font: "--font-body", size: "--table-font-size", color: "--text-color" },
};
const HEADING_SCOPE = "all headings";

export class Inspector {
  /**
   * @param {HTMLElement} root
   * @param {object} app  callbacks: getVar, setVars, codeThemes, applyStyle,
   *   setList, formatText, image (update/preview/mask/delete/replace),
   *   themeCommand
   */
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.mode = "format";
    this.ctx = null;
    this.tab = {};
    this.bindings = [];
    this.lastField = null;

    this.tabsEl = el("div", { class: "insp-tabs", role: "tablist", "aria-orientation": "vertical" });
    this.body = el("div", { class: "insp-body" });
    root.append(this.tabsEl, this.body);
    // The bar scrolls sideways; let a normal mouse wheel do that.
    this.body.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || this.body.scrollWidth <= this.body.clientWidth) return;
        if (e.target.closest("select, input[type=range], input[type=number]:focus")) return;
        this.body.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );

    this.panels = {
      "text:style": this.textStylePanel(),
      "text:layout": this.textLayoutPanel(),
      "image:style": this.imageStylePanel(),
      "image:image": this.imageImagePanel(),
      "image:arrange": this.imageArrangePanel(),
      "document:document": this.documentPanel(),
      "document:theme": this.themePanel(),
    };
    for (const panel of Object.values(this.panels)) {
      panel.hidden = true;
      this.body.append(panel);
    }
    this.render();
  }

  // ------------------------------------------------------------ structure

  setMode(mode) {
    this.mode = mode;
    this.render();
  }

  setContext(ctx) {
    this.ctx = ctx;
    if (this.mode === "format") this.render();
    else this.refresh();
  }

  group() {
    if (this.mode === "document") return { key: "document", tabs: [["document", "Document"], ["theme", "Theme"]] };
    if (this.ctx?.kind === "image") return { key: "image", tabs: [["style", "Style"], ["image", "Image"], ["arrange", "Arrange"]] };
    return { key: "text", tabs: [["style", "Style"], ["layout", "Layout"]] };
  }

  render() {
    const { key, tabs } = this.group();
    const active = this.tab[key] && tabs.some(([id]) => id === this.tab[key]) ? this.tab[key] : tabs[0][0];
    this.tabsEl.replaceChildren(
      ...tabs.map(([id, label]) =>
        el("button", {
          type: "button",
          class: `insp-tab${id === active ? " active" : ""}`,
          role: "tab",
          "aria-selected": String(id === active),
          text: label,
          onmousedown: (e) => e.preventDefault(),
          onclick: () => {
            this.tab[key] = id;
            this.render();
            this.body.scrollLeft = 0;
          },
        }),
      ),
    );
    const name = `${key}:${active}`;
    if (this.shown !== name) this.body.scrollLeft = 0;
    this.shown = name;
    for (const [id, panel] of Object.entries(this.panels)) panel.hidden = id !== name;
    this.refresh();
  }

  /** Re-read every control's value. */
  refresh() {
    for (const b of this.bindings) b();
    this.alignLabels();
  }

  /** Line up the controls in each column of the visible sections. */
  alignLabels() {
    const panel = this.panels[this.shown];
    if (!panel || panel.hidden || !this.root.offsetParent) return;
    for (const body of panel.querySelectorAll(".insp-section-body")) {
      const labels = [...body.querySelectorAll(":scope > .insp-row > .insp-label")].filter((l) => l.offsetParent);
      const columns = new Map();
      for (const label of labels) {
        label.style.minWidth = "";
        const x = Math.round(label.parentElement.offsetLeft);
        columns.set(x, [...(columns.get(x) || []), label]);
      }
      for (const group of columns.values()) {
        const width = Math.max(...group.map((l) => l.getBoundingClientRect().width));
        for (const l of group) l.style.minWidth = `${Math.ceil(width)}px`;
      }
    }
  }

  bind(fn) {
    this.bindings.push(fn);
  }

  styleVars() {
    return STYLE_VARS[this.ctx?.kind === "text" ? normaliseStyle(this.ctx.style) : "body"];
  }

  // -------------------------------------------------------------- widgets

  /**
   * A group of controls with its name underneath. Rows fill a column three
   * high, then continue in the next column.
   */
  section(title, ...rows) {
    const heading = el("h3", { text: title || "" });
    const node = el("section", { class: "insp-section" }, el("div", { class: "insp-section-body" }, ...rows), heading);
    node.heading = heading;
    return node;
  }

  row(label, ...controls) {
    return el("div", { class: "insp-row" }, label ? el("label", { class: "insp-label", text: label }) : null, el("div", { class: "insp-controls" }, ...controls));
  }

  /** Several controls side by side in one row. */
  line(...controls) {
    return el("div", { class: "insp-row insp-line" }, ...controls);
  }

  popup(options, onChange, { wide = false } = {}) {
    const select = el("select", { class: `insp-popup${wide ? " wide" : ""}` });
    for (const [value, label] of options) select.append(el("option", { value, text: label }));
    select.addEventListener("change", () => onChange(select.value, select));
    return select;
  }

  setPopup(select, value, label = value) {
    const known = [...select.options].some((o) => o.value === value && !o.hasAttribute("data-current"));
    select.querySelector("option[data-current]")?.remove();
    if (!known) select.prepend(el("option", { value, text: label, "data-current": true }));
    select.value = value;
  }

  stepper({ min = 0, max = 999, step = 1, unit = "" }, onChange) {
    const input = el("input", { type: "number", class: "insp-number", min, max, step });
    const commit = () => input.value !== "" && onChange(Number(input.value));
    input.addEventListener("change", commit);
    const nudge = (dir) => {
      const v = Math.min(max, Math.max(min, Number(input.value || 0) + dir * step));
      input.value = String(Math.round(v * 1000) / 1000);
      commit();
    };
    const wrap = el(
      "span",
      { class: "insp-stepper" },
      input,
      unit ? el("span", { class: "insp-unit", text: unit }) : null,
      el(
        "span",
        { class: "insp-arrows" },
        el("button", { type: "button", tabindex: -1, text: "▴", onclick: () => nudge(1) }),
        el("button", { type: "button", tabindex: -1, text: "▾", onclick: () => nudge(-1) }),
      ),
    );
    wrap.input = input;
    return wrap;
  }

  colorWell(onChange, { allowNone = false, live = true } = {}) {
    const input = el("input", { type: "color", class: "insp-color" });
    if (live) input.addEventListener("input", () => onChange(input.value, true));
    input.addEventListener("change", () => onChange(input.value, false));
    const wrap = el("span", { class: "insp-well" }, input);
    if (allowNone) {
      wrap.append(el("button", { type: "button", class: "insp-none", title: "None", text: "⌀", onclick: () => onChange("transparent", false) }));
    }
    wrap.set = (value) => {
      const none = isNone(value);
      input.value = none ? "#ffffff" : toHex(value);
      wrap.classList.toggle("is-none", none);
    };
    return wrap;
  }

  segmented(items, onChange, { small = false } = {}) {
    const wrap = el("div", { class: `insp-segmented${small ? " small" : ""}`, role: "group" });
    const buttons = items.map(([value, content, title]) => {
      const b = el("button", { type: "button", title, "aria-label": title, html: content, onclick: () => onChange(value) });
      b.dataset.value = value;
      wrap.append(b);
      return b;
    });
    wrap.set = (value) => buttons.forEach((b) => b.classList.toggle("active", b.dataset.value === String(value)));
    return wrap;
  }

  checkbox(label, onChange) {
    const input = el("input", { type: "checkbox" });
    input.addEventListener("change", () => onChange(input.checked));
    const wrap = el("label", { class: "insp-check" }, input, el("span", { text: label }));
    wrap.input = input;
    return wrap;
  }

  slider({ min, max, step, format = (v) => v }, onInput, onChange) {
    const range = el("input", { type: "range", class: "insp-slider", min, max, step });
    const out = el("span", { class: "insp-slider-value" });
    range.addEventListener("input", () => {
      out.textContent = format(Number(range.value));
      onInput?.(Number(range.value));
    });
    range.addEventListener("change", () => onChange(Number(range.value)));
    const wrap = el("span", { class: "insp-slider-wrap" }, range, out);
    wrap.set = (v) => {
      range.value = String(v);
      out.textContent = format(Number(v));
    };
    return wrap;
  }

  textField(placeholder, onChange) {
    const input = el("input", { type: "text", class: "insp-text", placeholder });
    input.addEventListener("change", () => onChange(input.value));
    return input;
  }

  button(label, onClick, cls = "") {
    return el("button", { type: "button", class: `insp-button ${cls}`, html: label, onclick: onClick });
  }

  hint(text) {
    return el("p", { class: "insp-hint", text });
  }

  // CSS variable helpers --------------------------------------------------

  varPopup(name, options, opts) {
    const select = this.popup(options, (v) => this.app.setVars({ [name]: v }), opts);
    this.bind(() => this.setPopup(select, this.app.getVar(name)));
    return select;
  }

  /**
   * Font popup bound to a theme variable. With `selection`, it shows and
   * sets the font of the selected text while there is a selection.
   */
  varFont(nameFn, stacksFn, { selection = false } = {}) {
    const select = el("select", { class: "insp-popup font" });
    const forSelection = () => selection && this.ctx?.kind === "text" && this.ctx.selection;
    const fill = () => {
      const stacks = stacksFn();
      const kind = String(stacks === MONO_STACKS);
      if (select.dataset.kind === kind) return;
      select.dataset.kind = kind;
      select.replaceChildren(
        ...stacks.map(([n, s, names]) => {
          const ok = fontAvailable(names || s);
          return el("option", {
            value: s,
            text: ok ? n : `${n} (not installed)`,
            style: `font-family:${s}`,
            class: ok ? null : "missing",
          });
        }),
        el("option", { value: "__custom", text: "Other Font…" }),
      );
    };
    select.addEventListener("change", () => {
      let value = select.value;
      if (value === "__custom") {
        const name = prompt("Font name (as installed on this computer), or a CSS font stack:", "");
        if (!name?.trim()) return this.refresh();
        value = name.includes(",") ? name.trim() : `${quoteFamily(name.trim())}, ${stacksFn() === MONO_STACKS ? "monospace" : "sans-serif"}`;
        if (!fontAvailable(value) && !confirm(`“${name.trim()}” doesn't seem to be installed, so a fallback font will be used. Use it anyway?`)) {
          return this.refresh();
        }
      }
      if (forSelection()) this.app.textStyle({ "font-family": value });
      else this.app.setVars({ [nameFn()]: value });
    });
    this.bind(() => {
      fill();
      const value = forSelection() ? this.ctx.text?.font || "" : this.app.getVar(nameFn());
      const norm = (v) => v.replace(/\s+/g, " ").replace(/'/g, '"').replace(/\s*,\s*/g, ",").trim().toLowerCase();
      const first = (v) => norm(v).split(",")[0].replace(/"/g, "");
      const options = [...select.options].filter((o) => !o.hasAttribute("data-current"));
      // Exact stack first; for selected text, match on the first family.
      const match = options.find((o) => norm(o.value) === norm(value)) || (forSelection() ? options.find((o) => o.value !== "__custom" && first(o.value) === first(value)) : null);
      if (match) {
        select.querySelector("option[data-current]")?.remove();
        select.value = match.value;
      } else this.setPopup(select, value, value.split(",")[0].replace(/["']/g, "").trim() || "Default");
    });
    return select;
  }

  varLength(nameFn, { unit, step, min, max, selection = null }) {
    const name = typeof nameFn === "function" ? nameFn : () => nameFn;
    const forSelection = () => selection && this.ctx?.kind === "text" && this.ctx.selection;
    const s = this.stepper({ min, max, step, unit }, (v) => {
      if (forSelection()) return this.app.textStyle({ [selection]: `${v}${unit}` });
      this.app.setVars({ [name()]: unit && unit !== "×" ? `${v}${unit}` : String(v) });
    });
    this.bind(() => {
      const n = forSelection() ? this.ctx.text?.size : parseFloat(this.app.getVar(name()));
      if (document.activeElement !== s.input) s.input.value = Number.isFinite(n) ? String(n) : "0";
    });
    return s;
  }

  varColor(nameFn, opts = {}) {
    const name = typeof nameFn === "function" ? nameFn : () => nameFn;
    const forSelection = () => opts.selection && this.ctx?.kind === "text" && this.ctx.selection;
    const well = this.colorWell((v, live) => {
      if (forSelection()) return this.app.textStyle({ [opts.selection]: v });
      this.app.setVars({ [name()]: v }, { live });
    }, opts);
    this.bind(() => {
      if (forSelection()) return well.set(this.ctx.text?.color || "#000000");
      const n = name();
      if (n) well.set(this.app.getVar(n));
    });
    return well;
  }

  varAlign(nameFn, withJustify = true) {
    const name = typeof nameFn === "function" ? nameFn : () => nameFn;
    const items = [
      ["left", ICONS.alignLeft, "Align Left"],
      ["center", ICONS.alignCenter, "Center"],
      ["right", ICONS.alignRight, "Align Right"],
    ];
    if (withJustify) items.push(["justify", ICONS.alignJustify, "Justify"]);
    const seg = this.segmented(items, (v) => this.app.setVars({ [name()]: v }));
    this.bind(() => name() && seg.set(this.app.getVar(name()).trim()));
    return seg;
  }

  varToggle(name, label, on = "on", off = "off") {
    const box = this.checkbox(label, (checked) => this.app.setVars({ [name]: checked ? on : off }));
    this.bind(() => (box.input.checked = this.app.getVar(name).trim() === on));
    return box;
  }

  varText(name, placeholder) {
    const input = this.textField(placeholder, (v) => this.app.setVars({ [name]: quote(v) }));
    input.addEventListener("focus", () => (this.lastField = { input, name }));
    this.bind(() => {
      if (document.activeElement !== input) input.value = unquote(this.app.getVar(name));
    });
    return input;
  }

  // ---------------------------------------------------------- text panels

  textStylePanel() {
    const styleSelect = this.popup(
      [
        ["body", "Body"],
        ["h1", "Heading 1"],
        ["h2", "Heading 2"],
        ["h3", "Heading 3"],
        ["h4", "Heading 4"],
        ["quote", "Quote"],
        ["code", "Code Block"],
      ],
      (v) => this.app.applyStyle(v),
    );
    styleSelect.classList.add("style-popup");
    const scope = el("p", { class: "insp-hint clamp" });
    this.bind(() => {
      const style = this.ctx?.kind === "text" ? normaliseStyle(this.ctx.style) : "body";
      this.setPopup(styleSelect, style === "table" ? "body" : style, STYLE_VARS[style].label);
      scope.textContent = this.ctx?.selection
        ? "Font, size and colour change the selected text."
        : /^h/.test(style)
          ? `Font and colour apply to all headings; size to every ${STYLE_VARS[style].label}.`
          : `Changes apply to all ${STYLE_VARS[style].label.toLowerCase()} text.`;
    });
    const paragraph = this.section("Paragraph Style", styleSelect, scope);
    scope.classList.add("span2");

    const font = this.varFont(
      () => this.styleVars().font,
      () => (this.styleVars().mono ? MONO_STACKS : FONT_STACKS),
      { selection: true },
    );
    const weight = this.popup(
      [["300", "Light"], ["400", "Regular"], ["500", "Medium"], ["600", "Semibold"], ["700", "Bold"], ["800", "Heavy"]],
      (v) => this.app.setVars({ "--heading-weight": v }),
    );
    weight.title = "Heading weight";
    this.bind(() => {
      weight.hidden = !this.styleVars().weight || !!this.ctx?.selection;
      this.setPopup(weight, this.app.getVar("--heading-weight").trim());
    });
    const size = this.varLength(() => this.styleVars().size, { unit: "pt", step: 0.5, min: 5, max: 96, selection: "font-size" });
    size.title = "Size";
    const color = this.varColor(() => this.styleVars().color, { selection: "color" });
    color.title = "Colour";
    this.bind(() => (color.hidden = !this.ctx?.selection && !this.styleVars().color));
    const fontSection = this.section("Font", font, this.line(size, weight), this.line(el("span", { class: "insp-label short", text: "Colour" }), color));
    this.bind(() => {
      fontSection.heading.textContent = this.ctx?.selection ? "Font · Selected Text" : "Font";
      fontSection.classList.toggle("for-selection", !!this.ctx?.selection);
    });

    const charButton = ([cmd, icon, title]) => {
      const b = el("button", { type: "button", title, "aria-label": title, html: icon, onmousedown: (e) => e.preventDefault(), onclick: () => this.app.formatText(cmd) });
      b.dataset.cmd = cmd;
      return b;
    };
    const charButtons = [
      ["bold", ICONS.bold, "Bold (⌘B)"],
      ["italic", ICONS.italic, "Italic (⌘I)"],
      ["strike", ICONS.strike, "Strikethrough"],
      ["mark", ICONS.highlight, "Highlight"],
      ["code", ICONS.code, "Inline Code"],
      ["link", ICONS.link, "Link (⌘K)"],
    ].map(charButton);
    const clear = el("button", {
      type: "button",
      title: "Remove font, size and colour changes from the selected text",
      "aria-label": "Clear text style",
      html: ICONS.clearStyle,
      onmousedown: (e) => e.preventDefault(),
      onclick: () => this.app.clearTextStyle(),
    });
    this.bind(() => {
      for (const b of charButtons) b.classList.toggle("active", !!this.ctx?.[b.dataset.cmd]);
      clear.disabled = !this.ctx?.styled && !this.ctx?.selection;
    });
    const chars = el("div", { class: "insp-charstyles" }, ...charButtons.slice(0, 4));
    const chars2 = el("div", { class: "insp-charstyles" }, ...charButtons.slice(4), clear);

    const align = this.varAlign(() => this.styleVars().align);
    const alignSection = this.section("Alignment", align);
    this.bind(() => (alignSection.hidden = !this.styleVars().align));

    const lists = this.popup(
      [["none", "None"], ["bullet", "• Bullets"], ["number", "1. Numbered"], ["task", "☐ Checklist"]],
      (v) => this.app.setList(v),
    );
    this.bind(() => this.setPopup(lists, this.ctx?.list || "none"));

    return el(
      "div",
      { class: "insp-panel" },
      paragraph,
      fontSection,
      this.section("Character", chars, chars2),
      alignSection,
      this.section("Bullets & Lists", lists),
    );
  }

  textLayoutPanel() {
    const quoteSection = this.section(
      "Quote",
      this.row("Bar", this.varColor("--blockquote-border-color")),
      this.row("Fill", this.varColor("--blockquote-background", { allowNone: true })),
      this.row("Text", this.varColor("--blockquote-color")),
    );
    const codeSection = this.section(
      "Code",
      this.row("Theme", this.varPopup("--code-theme", this.app.codeThemes)),
      this.row("Size", this.varLength("--code-font-size", { unit: "pt", step: 0.5, min: 5, max: 24 })),
      this.row("Corners", this.varLength("--code-radius", { unit: "px", step: 1, min: 0, max: 30 })),
    );
    const tableSection = this.tableSection();
    const headingSection = this.section(
      "Headings",
      this.row("Space before", this.varLength("--heading-space-before", { unit: "em", step: 0.1, min: 0, max: 5 })),
      this.row("Numbering", this.varPopup("--heading-numbering", [["off", "None"], ["h1", "1, 1.1, 1.1.1…"], ["h2", "From Heading 2"]])),
      this.row("H1 rule", this.varColor("--h1-border-color", { allowNone: true })),
      this.row("H2 rule", this.varColor("--h2-border-color", { allowNone: true })),
    );
    this.bind(() => {
      const style = this.ctx?.kind === "text" ? normaliseStyle(this.ctx.style) : "body";
      quoteSection.hidden = style !== "quote";
      codeSection.hidden = style !== "code";
      tableSection.hidden = style !== "table";
      headingSection.hidden = !/^h/.test(style);
    });
    return el(
      "div",
      { class: "insp-panel" },
      this.section(
        "Spacing",
        this.row("Line spacing", this.varLength("--line-height", { unit: "×", step: 0.05, min: 0.8, max: 3 })),
        this.row("After paragraph", this.varLength("--paragraph-spacing", { unit: "em", step: 0.1, min: 0, max: 4 })),
        this.row("First-line indent", this.varLength("--paragraph-indent", { unit: "em", step: 0.5, min: 0, max: 6 })),
      ),
      headingSection,
      quoteSection,
      codeSection,
      tableSection,
    );
  }

  tableSection() {
    return this.section(
      "Table",
      this.row("Header fill", this.varColor("--table-header-background", { allowNone: true })),
      this.row("Header text", this.varColor("--table-header-color")),
      this.row("Stripes", this.varColor("--table-stripe-background", { allowNone: true })),
      this.row("Borders", this.varColor("--table-border-color")),
      this.row("Text size", this.varLength("--table-font-size", { unit: "pt", step: 0.5, min: 5, max: 24 })),
    );
  }

  // --------------------------------------------------------- image panels

  imgAttrs() {
    return this.ctx?.kind === "image" ? this.ctx.attrs : {};
  }

  setImage(mutate) {
    this.app.image.update(mutate);
  }

  imageStylePanel() {
    const presets = [
      ["", "None"],
      ["img-framed", "Framed"],
      ["img-polaroid", "Polaroid"],
      ["img-rounded", "Rounded"],
      ["img-circle", "Circle"],
      ["img-outline", "Outline"],
    ];
    const grid = el("div", { class: "insp-image-presets" });
    const tiles = presets.map(([cls, label]) => {
      const tile = el(
        "button",
        {
          type: "button",
          class: `preset-tile ${cls}`,
          title: label,
          onclick: () =>
            this.setImage((img) => {
              img.attrs.classes = (img.attrs.classes || []).filter((c) => !c.startsWith("img-"));
              if (cls) img.attrs.classes.push(cls);
              delete img.attrs.border;
              delete img.attrs.radius;
            }),
        },
        el("span", { class: "preset-frame" }, el("img", { alt: "" })),
        el("span", { class: "preset-label", text: label }),
      );
      tile.dataset.cls = cls;
      grid.append(tile);
      return tile;
    });
    this.bind(() => {
      if (this.ctx?.kind !== "image") return;
      const current = (this.imgAttrs().classes || []).find((c) => c.startsWith("img-")) || "";
      for (const t of tiles) {
        t.classList.toggle("active", t.dataset.cls === current);
        const img = t.querySelector("img");
        if (img.dataset.src !== this.ctx.resolvedSrc) {
          img.dataset.src = this.ctx.resolvedSrc || "";
          img.src = this.ctx.resolvedSrc || "";
        }
      }
    });

    const borderKind = this.popup([["none", "No Border"], ["line", "Line"]], (v) =>
      this.setImage((img) => {
        if (v === "none") {
          delete img.attrs.border;
          delete img.attrs["border-style"];
          delete img.attrs["border-color"];
        } else img.attrs.border = img.attrs.border || "2";
      }),
    );
    const borderStyle = this.popup([["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"], ["double", "Double"]], (v) =>
      this.setImage((img) => (img.attrs["border-style"] = v)),
    );
    const borderWidth = this.stepper({ min: 0, max: 50, step: 1, unit: "pt" }, (v) => this.setImage((img) => (img.attrs.border = String(v))));
    const borderColor = this.colorWell((v, live) => !live && this.setImage((img) => (img.attrs["border-color"] = v)), { live: false });
    const borderRows = [this.row("Style", borderStyle), this.row("Width", borderWidth), this.row("Colour", borderColor)];
    this.bind(() => {
      const a = this.imgAttrs();
      const has = a.border !== undefined;
      borderKind.value = has ? "line" : "none";
      for (const r of borderRows) r.hidden = !has;
      borderStyle.value = a["border-style"] || "solid";
      borderWidth.input.value = a.border || "2";
      borderColor.set(a["border-color"] || "#1f2328");
    });

    const shadow = this.popup(
      [["", "None"], ["soft", "Soft"], ["medium", "Medium"], ["hard", "Hard"], ["float", "Floating"]],
      (v) => this.setImage((img) => (v ? (img.attrs.shadow = v) : delete img.attrs.shadow)),
    );
    this.bind(() => (shadow.value = this.imgAttrs().shadow || ""));

    const corners = this.stepper({ min: 0, max: 200, step: 1, unit: "px" }, (v) =>
      this.setImage((img) => (v ? (img.attrs.radius = String(v)) : delete img.attrs.radius)),
    );
    this.bind(() => (corners.input.value = parseFloat(this.imgAttrs().radius || "0") || 0));

    const opacity = this.slider(
      { min: 0, max: 100, step: 1, format: (v) => `${v}%` },
      (v) => this.app.image.preview("opacity", v / 100),
      (v) => this.setImage((img) => (v >= 100 ? delete img.attrs.opacity : (img.attrs.opacity = String(v / 100)))),
    );
    this.bind(() => opacity.set(Math.round(Number(this.imgAttrs().opacity ?? 1) * 100)));

    grid.classList.add("span3");
    return el(
      "div",
      { class: "insp-panel" },
      this.section("Style", grid),
      this.section("Border", this.row(null, borderKind), ...borderRows),
      this.section("Effects", this.row("Shadow", shadow), this.row("Corners", corners), this.row("Opacity", opacity)),
    );
  }

  imageImagePanel() {
    const aspect = this.popup(
      [["", "Original"], ["1:1", "Square"], ["4:3", "4 : 3"], ["3:2", "3 : 2"], ["16:9", "16 : 9"], ["3:4", "3 : 4"], ["2:3", "2 : 3"]],
      (v) =>
        this.setImage((img) => {
          if (v) {
            img.attrs.aspect = v;
            img.attrs.focus = img.attrs.focus || "50,50";
          } else {
            delete img.attrs.aspect;
            delete img.attrs.zoom;
            delete img.attrs.focus;
          }
        }),
    );
    const zoom = this.slider(
      { min: 1, max: 5, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      (v) => this.app.image.preview("zoom", v),
      (v) => this.setImage((img) => (v <= 1 ? delete img.attrs.zoom : (img.attrs.zoom = String(Math.round(v * 100) / 100)))),
    );
    const editMask = this.button("Edit Mask", () => this.app.image.toggleMask());
    const resetMask = this.button("Reset", () =>
      this.setImage((img) => {
        delete img.attrs.aspect;
        delete img.attrs.zoom;
        delete img.attrs.focus;
      }),
    );
    this.bind(() => {
      const a = this.imgAttrs();
      aspect.value = a.aspect && [...aspect.options].some((o) => o.value === a.aspect) ? a.aspect : "";
      if (a.aspect && aspect.value !== a.aspect) this.setPopup(aspect, a.aspect, a.aspect.replace(":", " : "));
      zoom.set(Number(a.zoom || 1));
      editMask.textContent = this.ctx?.masking ? "Done" : "Edit Mask";
      editMask.classList.toggle("primary", !!this.ctx?.masking);
    });

    const rotation = this.stepper({ min: -360, max: 360, step: 1, unit: "°" }, (v) =>
      this.setImage((img) => (v % 360 ? (img.attrs.rotate = String(v % 360)) : delete img.attrs.rotate)),
    );
    this.bind(() => (rotation.input.value = String(Number(this.imgAttrs().rotate || 0))));
    const turn = (deg) => this.setImage((img) => {
      const r = (Number(img.attrs.rotate || 0) + deg) % 360;
      if (r) img.attrs.rotate = String(r);
      else delete img.attrs.rotate;
    });
    const flip = (axis) =>
      this.setImage((img) => {
        const cur = new Set((img.attrs.flip || "").split(""));
        cur.has(axis) ? cur.delete(axis) : cur.add(axis);
        const value = ["h", "v"].filter((x) => cur.has(x)).join("");
        if (value) img.attrs.flip = value;
        else delete img.attrs.flip;
      });

    const caption = this.checkbox("Caption", (on) =>
      this.setImage((img) => {
        img.title = on ? img.title || "Caption" : null;
        if (on && !img.attrs.align && !img.attrs.inline) img.attrs.align = "center";
      }),
    );
    const captionText = this.textField("Caption text", (v) => this.setImage((img) => (img.title = v || null)));
    const alt = this.textField("Describe the image", (v) => this.setImage((img) => (img.alt = v)));
    alt.title = "Alternative text, used for accessibility";
    this.bind(() => {
      caption.input.checked = !!this.ctx?.title;
      captionText.hidden = !this.ctx?.title;
      if (document.activeElement !== captionText) captionText.value = this.ctx?.title || "";
      if (document.activeElement !== alt) alt.value = this.ctx?.alt || "";
    });

    return el(
      "div",
      { class: "insp-panel" },
      this.section("Mask", this.row("Shape", aspect), this.row("Zoom", zoom), el("div", { class: "insp-buttons" }, editMask, resetMask)),
      this.section(
        "Rotate",
        this.row("Angle", rotation),
        el(
          "div",
          { class: "insp-buttons icons" },
          this.button(ICONS.rotateLeft, () => turn(-90)),
          this.button(ICONS.rotateRight, () => turn(90)),
          this.button(ICONS.flipH, () => flip("h")),
          this.button(ICONS.flipV, () => flip("v")),
        ),
      ),
      this.section("Caption", caption, captionText),
      this.section("Description", alt, el("div", { class: "insp-buttons" }, this.button("Replace Image…", () => this.app.image.replace()))),
    );
  }

  imageArrangePanel() {
    const width = this.slider(
      { min: 5, max: 100, step: 1, format: (v) => `${v}%` },
      (v) => this.app.image.preview("width", `${v}%`),
      (v) => this.setImage((img) => (img.attrs.width = `${v}%`)),
    );
    this.bind(() => {
      const w = this.imgAttrs().width;
      width.set(w && w.endsWith("%") ? parseFloat(w) : 100);
    });
    const natural = this.button("Original Size", () => this.setImage((img) => delete img.attrs.width));

    const wrap = this.segmented(
      [
        ["inline", ICONS.wrapInline, "Inline with Text"],
        ["block", ICONS.wrapBlock, "Above and Below"],
        ["around", ICONS.wrapAround, "Around (text wraps)"],
      ],
      (v) =>
        this.setImage((img) => {
          img.attrs.inline = v === "inline";
          img.attrs.wrap = v === "around";
          if (v === "around" && (!img.attrs.align || img.attrs.align === "center")) img.attrs.align = "left";
          if (v === "inline") delete img.attrs.align;
        }),
    );
    const wrapLabel = el("p", { class: "insp-hint" });
    const align = this.segmented(
      [
        ["left", ICONS.alignLeft, "Left"],
        ["center", ICONS.alignCenter, "Centre"],
        ["right", ICONS.alignRight, "Right"],
      ],
      (v) =>
        this.setImage((img) => {
          img.attrs.align = v;
          img.attrs.inline = false;
          if (v === "center") img.attrs.wrap = false;
        }),
    );
    this.bind(() => {
      const a = this.imgAttrs();
      const mode = a.inline ? "inline" : a.wrap ? "around" : "block";
      wrap.set(mode);
      wrapLabel.textContent = { inline: "Inline with Text", block: "Above and Below", around: "Text wraps around the image" }[mode];
      align.set(a.inline ? "" : a.align || "center");
      align.classList.toggle("disabled", !!a.inline);
    });

    return el(
      "div",
      { class: "insp-panel" },
      this.section("Size", this.row("Width", width), el("div", { class: "insp-buttons" }, natural)),
      this.section("Text Wrap", wrap, wrapLabel),
      this.section("Position", align, this.hint("Drag the image on the page to move it in the text.")),
      this.section("Image", el("div", { class: "insp-buttons" }, this.button(`${ICONS.trash} Delete`, () => this.app.image.remove(), "danger"))),
    );
  }

  // ------------------------------------------------------- document panels

  documentPanel() {
    const orientation = this.segmented(
      [
        ["portrait", ICONS.portrait, "Portrait"],
        ["landscape", ICONS.landscape, "Landscape"],
      ],
      (v) => this.app.setVars({ "--page-orientation": v }),
    );
    this.bind(() => orientation.set(this.app.getVar("--page-orientation").trim()));

    const marginPreset = this.popup(
      [["", "Presets…"], ...Object.entries(MARGIN_PRESETS).map(([id, [name]]) => [id, name])],
      (v, select) => {
        select.value = "";
        const m = MARGIN_PRESETS[v]?.[1];
        if (!m) return;
        this.app.setVars({
          "--page-margin-top": `${m.top}mm`,
          "--page-margin-right": `${m.right}mm`,
          "--page-margin-bottom": `${m.bottom}mm`,
          "--page-margin-left": `${m.left}mm`,
        });
      },
    );
    const margin = (name) => this.varLength(name, { unit: "mm", step: 1, min: 0, max: 100 });

    const tokens = el(
      "div",
      { class: "insp-tokens" },
      ...[
        ["{page}", "Page Number"],
        ["{pages}", "Page Count"],
        ["{title}", "Title"],
        ["{date}", "Date"],
      ].map(([token, label]) =>
        el("button", {
          type: "button",
          class: "insp-chip",
          text: label,
          onmousedown: (e) => e.preventDefault(),
          onclick: () => {
            const target = this.lastField;
            if (!target) return alert("Click in a header or footer field first.");
            const { input, name } = target;
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? start;
            input.value = input.value.slice(0, start) + token + input.value.slice(end);
            input.focus();
            input.setSelectionRange(start + token.length, start + token.length);
            this.app.setVars({ [name]: quote(input.value) });
          },
        }),
      ),
    );
    const hf = (prefix) =>
      el(
        "div",
        { class: "insp-hf" },
        this.varText(`--${prefix}-left`, "Left"),
        this.varText(`--${prefix}-center`, "Centre"),
        this.varText(`--${prefix}-right`, "Right"),
      );
    const fields = el("div", { class: "insp-row" }, el("span", { class: "insp-label", text: "Insert" }), tokens);

    return el(
      "div",
      { class: "insp-panel" },
      this.section(
        "Paper",
        this.row(null, this.varPopup("--page-size", PAGE_SIZES, { wide: true })),
        this.row("Orientation", orientation),
        this.row("Page colour", this.varColor("--page-background")),
      ),
      this.section(
        "Document Margins",
        this.row(null, marginPreset),
        this.row("Top", margin("--page-margin-top")),
        this.row("Bottom", margin("--page-margin-bottom")),
        this.row("Left", margin("--page-margin-left")),
        this.row("Right", margin("--page-margin-right")),
      ),
      this.section("Header & Footer", this.row("Header", hf("header")), this.row("Footer", hf("footer")), fields),
      this.section(
        "Header & Footer Text",
        this.row("Size", this.varLength("--header-footer-font-size", { unit: "pt", step: 0.5, min: 5, max: 20 })),
        this.row("Colour", this.varColor("--header-footer-color")),
        this.varToggle("--first-page-header-footer", "Hide on first page", "hide", "show"),
      ),
      this.section(
        "Headings",
        this.row("Numbering", this.varPopup("--heading-numbering", [["off", "None"], ["h1", "1, 1.1, 1.1.1…"], ["h2", "From Heading 2"]])),
      ),
    );
  }

  themePanel() {
    const gallery = el("div", { class: "insp-presets" });
    for (const preset of PRESETS) {
      const s = preset.sample;
      gallery.append(
        el(
          "button",
          {
            type: "button",
            class: "style-set",
            title: `Apply the ${preset.name} style set`,
            onclick: () => {
              const changes = {};
              for (const name of PRESET_VARS) changes[name] = null;
              Object.assign(changes, preset.vars);
              this.app.setVars(changes);
            },
          },
          el(
            "span",
            { class: "style-set-page" },
            el("span", { class: "ss-title", text: "Title", style: `font-family:${s.heading};color:${s.color}` }),
            el("span", { class: "ss-rule", style: `background:${s.accent}` }),
            el("span", { class: "ss-line", style: `font-family:${s.body}`, text: "Body text that" }),
            el("span", { class: "ss-line", style: `font-family:${s.body}`, text: "flows nicely." }),
          ),
          el("span", { class: "style-set-name", text: preset.name }),
        ),
      );
    }

    gallery.classList.add("span3");
    const cmd = (label, id) => this.button(label, () => this.app.themeCommand(id));
    return el(
      "div",
      { class: "insp-panel" },
      this.section("Style Sets", gallery),
      this.section(
        "Fonts",
        this.row("Body", this.varFont(() => "--font-body", () => FONT_STACKS)),
        this.row("Headings", this.varFont(() => "--font-heading", () => FONT_STACKS)),
        this.row("Code", this.varFont(() => "--font-mono", () => MONO_STACKS)),
      ),
      this.section(
        "Colours",
        this.row("Text", this.varColor("--text-color")),
        this.row("Headings", this.varColor("--heading-color")),
        this.row("Accent", this.varColor("--accent-color")),
        this.row("Links", this.varColor("--link-color"), this.button("Use Accent", () => this.app.setVars({ "--link-color": null }), "small")),
        this.row("Link style", this.varPopup("--link-decoration", [["underline", "Underlined"], ["none", "No underline"]])),
        this.varToggle("--show-link-urls", "Print link addresses"),
      ),
      this.section(
        "Code",
        this.row("Theme", this.varPopup("--code-theme", this.app.codeThemes)),
        this.row("Size", this.varLength("--code-font-size", { unit: "pt", step: 0.5, min: 5, max: 24 })),
        this.row("Inline", this.varColor("--inline-code-color"), this.varColor("--inline-code-background", { allowNone: true })),
      ),
      this.tableSection(),
      this.section(
        "Quotes",
        this.row("Bar", this.varColor("--blockquote-border-color")),
        this.row("Fill", this.varColor("--blockquote-background", { allowNone: true })),
        this.row("Text", this.varColor("--blockquote-color")),
      ),
      this.section("Captions", this.varAlign("--caption-align", false)),
      this.section(
        "Theme File",
        el(
          "div",
          { class: "insp-buttons wrap span3" },
          cmd("Load…", "upload-css"),
          cmd("Open…", "open-css-disk"),
          cmd("Save…", "save-css"),
          cmd("Download", "download-css"),
          cmd("Edit CSS", "show-css"),
          cmd("Reset", "reset-css"),
        ),
      ),
    );
  }
}

function normaliseStyle(style) {
  if (style === "h5" || style === "h6") return "h4";
  return STYLE_VARS[style] ? style : "body";
}

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "math", "emoji", "fangsong"]);
const fontCache = new Map();

/** Split a CSS font stack into family names (quotes removed). */
function families(stack) {
  return (stack.match(/"[^"]*"|'[^']*'|[^,]+/g) || []).map((f) => f.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

function quoteFamily(name) {
  return /^[\w-]+$/.test(name) && !/^\d/.test(name) ? name : `"${name.replace(/"/g, "")}"`;
}

/** Is a font family available to the browser (and so to the PDF engine)? */
function familyAvailable(family) {
  if (GENERIC_FAMILIES.has(family.toLowerCase())) return true;
  if (/^roboto$/i.test(family)) return true; // bundled with EasyMarkDoc
  if (fontCache.has(family)) return fontCache.get(family);
  // Measure real text: canvas doesn't understand keywords like -apple-system.
  const probe = (familyAvailable.probe ||= Object.assign(document.createElement("span"), {
    textContent: "mmmmmmmmmmlliWW@#1i",
    style: "position:absolute;left:-9999px;top:0;font-size:72px;white-space:nowrap;visibility:hidden",
  }));
  if (!probe.isConnected) document.body.append(probe);
  const name = /^(-apple-system|BlinkMacSystemFont|system-ui|ui-[a-z-]+)$/i.test(family) ? family : `"${family}"`;
  const differs = (fallback) => {
    probe.style.fontFamily = fallback;
    const base = probe.getBoundingClientRect().width;
    probe.style.fontFamily = `${name}, ${fallback}`;
    return probe.getBoundingClientRect().width !== base;
  };
  const ok = differs("monospace") || differs("serif");
  fontCache.set(family, ok);
  return ok;
}

/**
 * Is a font installed? Takes a list of the names it may be installed under,
 * or a CSS font stack (then its first family must be installed).
 */
export function fontAvailable(names) {
  const list = Array.isArray(names) ? names : families(names || "").slice(0, 1);
  return !list.length || list.some(familyAvailable);
}
