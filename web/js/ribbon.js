// Word-style ribbon. Styling controls are bound to CSS custom properties in
// the theme; formatting buttons run Markdown editing actions.

import { quote, unquote } from "./cssvars.js";

const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  bold: `<b style="font-size:15px">B</b>`,
  italic: `<i style="font-family:Georgia,serif;font-size:16px">I</i>`,
  strike: `<s style="font-size:15px">S</s>`,
  highlight: svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
  code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>'),
  bullets: svg('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  numbers: svg('<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>'),
  tasks: svg('<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
  quote: svg('<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.76-2.02-2-2H4c-1.25 0-2 .75-2 1.97V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .01-1 1.03V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.76-2.02-2-2h-4c-1.25 0-2 .75-2 1.97V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/>'),
  codeblock: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m10 9-3 3 3 3"/><path d="m14 15 3-3-3-3"/>'),
  table: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/>'),
  hr: svg('<line x1="3" y1="12" x2="21" y2="12"/>'),
  pagebreak: svg('<path d="M4 3v5h16V3"/><path d="M4 21v-5h16v5"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="9" y1="12" x2="11" y2="12"/><line x1="15" y1="12" x2="17" y2="12"/><line x1="21" y1="12" x2="22" y2="12"/>'),
  toc: svg('<path d="M3 6h12"/><path d="M7 12h10"/><path d="M7 18h10"/><path d="M19 6h2"/><path d="M19 12h2"/><path d="M19 18h2"/>'),
  footnote: svg('<path d="M4 7h10"/><path d="M4 12h10"/><path d="M4 17h6"/><path d="M18 4v6"/><path d="M16 6l2-2"/>'),
  alignLeft: svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/>'),
  alignCenter: svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/>'),
  alignRight: svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="6" y1="18" x2="21" y2="18"/>'),
  alignJustify: svg('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>'),
  undo: svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>'),
  redo: svg('<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>'),
};

export const FONT_STACKS = [
  ["Georgia", 'Georgia, "Times New Roman", serif'],
  ["Times New Roman", '"Times New Roman", Times, serif'],
  ["Palatino", '"Palatino Linotype", Palatino, "Book Antiqua", serif'],
  ["Garamond", 'Garamond, "EB Garamond", "Times New Roman", serif'],
  ["Baskerville", 'Baskerville, "Baskerville Old Face", Georgia, serif'],
  ["Charter", 'Charter, "Bitstream Charter", Georgia, serif'],
  ["Helvetica", '"Helvetica Neue", Helvetica, Arial, sans-serif'],
  ["Arial", "Arial, Helvetica, sans-serif"],
  ["Roboto (bundled)", "Roboto, Arial, sans-serif"],
  ["Calibri", "Calibri, Carlito, Arial, sans-serif"],
  ["Segoe / System UI", 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'],
  ["Verdana", "Verdana, Geneva, sans-serif"],
  ["Trebuchet", '"Trebuchet MS", Helvetica, sans-serif'],
  ["Avenir", '"Avenir Next", Avenir, "Segoe UI", sans-serif'],
  ["Gill Sans", '"Gill Sans", "Gill Sans MT", Calibri, sans-serif'],
  ["Optima", "Optima, Candara, sans-serif"],
  ["Didot", 'Didot, "Bodoni MT", "Times New Roman", serif'],
];

export const MONO_STACKS = [
  ["JetBrains Mono / Menlo", '"JetBrains Mono", "SF Mono", Menlo, Consolas, "Courier New", monospace'],
  ["SF Mono", '"SF Mono", Menlo, monospace'],
  ["Menlo", "Menlo, Monaco, monospace"],
  ["Consolas", "Consolas, Menlo, monospace"],
  ["Fira Code", '"Fira Code", Menlo, monospace'],
  ["Source Code Pro", '"Source Code Pro", Menlo, monospace'],
  ["Courier New", '"Courier New", Courier, monospace'],
];

const PAGE_SIZES = [
  ["A4", "A4 (210 × 297 mm)"],
  ["Letter", "Letter (8.5 × 11 in)"],
  ["Legal", "Legal (8.5 × 14 in)"],
  ["A5", "A5 (148 × 210 mm)"],
  ["A3", "A3 (297 × 420 mm)"],
  ["B5", "B5 (176 × 250 mm)"],
];

const MARGIN_PRESETS = {
  normal: ["Normal", { top: 25.4, right: 25.4, bottom: 25.4, left: 25.4 }],
  standard: ["Standard", { top: 20, right: 18, bottom: 20, left: 18 }],
  narrow: ["Narrow", { top: 12.7, right: 12.7, bottom: 12.7, left: 12.7 }],
  moderate: ["Moderate", { top: 25.4, right: 19.1, bottom: 25.4, left: 19.1 }],
  wide: ["Wide", { top: 25.4, right: 50.8, bottom: 25.4, left: 50.8 }],
};

/** Style presets ("style sets"). Values not listed revert to the defaults. */
export const PRESETS = [
  {
    id: "default",
    name: "Default",
    sample: { body: "Georgia, serif", heading: "Helvetica, Arial, sans-serif", color: "#111827", accent: "#0b5cad" },
    vars: {},
  },
  {
    id: "modern",
    name: "Modern",
    sample: { body: "'Avenir Next', 'Segoe UI', sans-serif", heading: "'Avenir Next', 'Segoe UI', sans-serif", color: "#0f172a", accent: "#4f46e5" },
    vars: {
      "--font-body": '"Avenir Next", Avenir, "Segoe UI", sans-serif',
      "--font-heading": '"Avenir Next", Avenir, "Segoe UI", sans-serif',
      "--heading-color": "#0f172a",
      "--accent-color": "#4f46e5",
      "--link-color": "#4f46e5",
      "--h2-border-color": "transparent",
      "--blockquote-border-color": "#4f46e5",
      "--blockquote-background": "#eef2ff",
      "--table-header-background": "#eef2ff",
      "--code-theme": "ocean-dark",
      "--line-height": "1.6",
    },
  },
  {
    id: "academic",
    name: "Academic",
    sample: { body: "'Times New Roman', serif", heading: "'Times New Roman', serif", color: "#000", accent: "#000" },
    vars: {
      "--font-body": '"Times New Roman", Times, serif',
      "--font-heading": '"Times New Roman", Times, serif',
      "--font-size-base": "12pt",
      "--line-height": "1.6",
      "--text-align": "justify",
      "--text-color": "#000000",
      "--heading-color": "#000000",
      "--h1-size": "20pt",
      "--h2-size": "14pt",
      "--h3-size": "12pt",
      "--h2-border-color": "transparent",
      "--heading-numbering": "h2",
      "--link-color": "#000000",
      "--page-margin-top": "25.4mm",
      "--page-margin-right": "25.4mm",
      "--page-margin-bottom": "25.4mm",
      "--page-margin-left": "25.4mm",
      "--code-theme": "github",
      "--inline-code-color": "#000000",
      "--footer-center": '"{page}"',
      "--first-page-header-footer": "hide",
    },
  },
  {
    id: "report",
    name: "Report",
    sample: { body: "Calibri, Carlito, Arial, sans-serif", heading: "Calibri, Carlito, Arial, sans-serif", color: "#1f4e79", accent: "#2e74b5" },
    vars: {
      "--font-body": "Calibri, Carlito, Arial, sans-serif",
      "--font-heading": "Calibri, Carlito, Arial, sans-serif",
      "--font-size-base": "11pt",
      "--heading-color": "#1f4e79",
      "--accent-color": "#2e74b5",
      "--link-color": "#2e74b5",
      "--heading-weight": "600",
      "--h1-border-color": "#2e74b5",
      "--h2-border-color": "transparent",
      "--table-header-background": "#2e74b5",
      "--table-header-color": "#ffffff",
      "--table-stripe-background": "#ddebf7",
      "--table-border-color": "#9dc3e6",
      "--blockquote-border-color": "#2e74b5",
      "--header-right": '"{title}"',
      "--footer-center": '"Page {page} of {pages}"',
      "--code-theme": "github",
    },
  },
  {
    id: "technical",
    name: "Technical",
    sample: { body: "Roboto, Arial, sans-serif", heading: "Roboto, Arial, sans-serif", color: "#24292f", accent: "#0969da" },
    vars: {
      "--font-body": "Roboto, Arial, sans-serif",
      "--font-heading": "Roboto, Arial, sans-serif",
      "--font-size-base": "10.5pt",
      "--heading-color": "#24292f",
      "--accent-color": "#0969da",
      "--link-color": "#0969da",
      "--code-theme": "github",
      "--inline-code-color": "#24292f",
      "--inline-code-background": "#eff1f3",
      "--heading-numbering": "h2",
      "--page-margin-left": "15mm",
      "--page-margin-right": "15mm",
    },
  },
  {
    id: "elegant",
    name: "Elegant",
    sample: { body: "Palatino, 'Book Antiqua', serif", heading: "Didot, 'Bodoni MT', serif", color: "#3b0d11", accent: "#8c1c2c" },
    vars: {
      "--font-body": '"Palatino Linotype", Palatino, "Book Antiqua", serif',
      "--font-heading": 'Didot, "Bodoni MT", "Times New Roman", serif',
      "--heading-weight": "400",
      "--heading-color": "#3b0d11",
      "--heading-align": "center",
      "--h1-size": "30pt",
      "--h2-border-color": "transparent",
      "--accent-color": "#8c1c2c",
      "--link-color": "#8c1c2c",
      "--blockquote-border-color": "#8c1c2c",
      "--text-align": "justify",
      "--paragraph-indent": "1.5em",
      "--paragraph-spacing": "0.4em",
      "--code-theme": "solarized-light",
      "--footer-center": '"— {page} —"',
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    sample: { body: "system-ui, sans-serif", heading: "system-ui, sans-serif", color: "#374151", accent: "#6b7280" },
    vars: {
      "--font-body": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      "--font-heading": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      "--heading-weight": "600",
      "--text-color": "#374151",
      "--heading-color": "#111827",
      "--h1-size": "20pt",
      "--h2-size": "14pt",
      "--h3-size": "12pt",
      "--h2-border-color": "transparent",
      "--link-color": "#374151",
      "--table-header-background": "transparent",
      "--table-stripe-background": "transparent",
      "--code-theme": "github",
      "--footer-center": '""',
      "--footer-right": '"{page}"',
    },
  },
];

/** Every variable a preset may set; applying a preset resets these first. */
export const PRESET_VARS = [...new Set(PRESETS.flatMap((p) => Object.keys(p.vars)))];

const align = (name) => ({
  type: "segmented",
  var: name,
  options: [
    ["left", ICONS.alignLeft, "Align left"],
    ["center", ICONS.alignCenter, "Center"],
    ["right", ICONS.alignRight, "Align right"],
    ["justify", ICONS.alignJustify, "Justify"],
  ],
});

/** The ribbon layout: tabs → groups → controls. */
export function ribbonTabs(codeThemes) {
  const action = (id, icon, title) => ({ type: "action", action: id, icon, title });
  return [
    {
      id: "home",
      label: "Home",
      groups: [
        {
          label: "History",
          controls: [action("undo", ICONS.undo, "Undo (Ctrl+Z)"), action("redo", ICONS.redo, "Redo (Ctrl+Shift+Z)")],
        },
        {
          label: "Format",
          controls: [
            action("bold", ICONS.bold, "Bold (Ctrl+B)"),
            action("italic", ICONS.italic, "Italic (Ctrl+I)"),
            action("strike", ICONS.strike, "Strikethrough"),
            action("highlight", ICONS.highlight, "Highlight"),
            action("code", ICONS.code, "Inline code"),
            action("link", ICONS.link, "Link (Ctrl+K)"),
            action("image", ICONS.image, "Image"),
          ],
        },
        {
          label: "Paragraph",
          controls: [
            {
              type: "action-select",
              action: "style",
              title: "Paragraph style",
              options: [
                ["0", "Normal text"],
                ["1", "Heading 1"],
                ["2", "Heading 2"],
                ["3", "Heading 3"],
                ["4", "Heading 4"],
              ],
            },
            action("bullets", ICONS.bullets, "Bulleted list"),
            action("numbers", ICONS.numbers, "Numbered list"),
            action("tasks", ICONS.tasks, "Checklist"),
            action("quote", ICONS.quote, "Quote"),
          ],
        },
        {
          label: "Insert",
          controls: [
            action("codeblock", ICONS.codeblock, "Code block"),
            action("table", ICONS.table, "Table"),
            action("hr", ICONS.hr, "Horizontal line"),
            action("pagebreak", ICONS.pagebreak, "Page break"),
            action("toc", ICONS.toc, "Table of contents"),
            action("footnote", ICONS.footnote, "Footnote"),
          ],
        },
        {
          label: "Document font",
          controls: [
            { type: "font", var: "--font-body", title: "Body font", stacks: FONT_STACKS },
            { type: "length", var: "--font-size-base", unit: "pt", step: 0.5, min: 6, max: 32, title: "Font size" },
            { type: "color", var: "--text-color", title: "Text colour" },
          ],
        },
        {
          label: "Alignment",
          controls: [align("--text-align")],
        },
      ],
    },
    {
      id: "design",
      label: "Design",
      groups: [
        { label: "Style sets", controls: [{ type: "presets" }] },
        {
          label: "Colours",
          controls: [
            { type: "color", var: "--accent-color", label: "Accent" },
            { type: "color", var: "--link-color", label: "Links" },
            { type: "color", var: "--heading-color", label: "Headings" },
            { type: "color", var: "--text-color", label: "Text" },
          ],
        },
        {
          label: "Code",
          controls: [
            { type: "select", var: "--code-theme", label: "Theme", options: codeThemes },
            { type: "font", var: "--font-mono", label: "Font", stacks: MONO_STACKS },
            { type: "length", var: "--code-font-size", unit: "pt", step: 0.5, min: 6, max: 20, label: "Size" },
          ],
        },
        {
          label: "Options",
          controls: [
            {
              type: "select",
              var: "--heading-numbering",
              label: "Numbering",
              options: [
                ["off", "No heading numbers"],
                ["h1", "Number from Heading 1"],
                ["h2", "Number from Heading 2"],
              ],
            },
            {
              type: "select",
              var: "--link-decoration",
              label: "Links",
              options: [
                ["underline", "Underlined"],
                ["none", "Not underlined"],
              ],
            },
            { type: "toggle", var: "--show-link-urls", on: "on", off: "off", label: "Print link URLs" },
          ],
        },
      ],
    },
    {
      id: "layout",
      label: "Layout",
      groups: [
        {
          label: "Page setup",
          controls: [
            { type: "select", var: "--page-size", label: "Size", options: PAGE_SIZES, allowCustom: true },
            {
              type: "select",
              var: "--page-orientation",
              label: "Orientation",
              options: [
                ["portrait", "Portrait"],
                ["landscape", "Landscape"],
              ],
            },
            { type: "color", var: "--page-background", label: "Page colour" },
          ],
        },
        {
          label: "Margins",
          controls: [
            { type: "margin-presets", presets: MARGIN_PRESETS },
            { type: "length", var: "--page-margin-top", unit: "mm", step: 1, min: 0, max: 100, label: "Top" },
            { type: "length", var: "--page-margin-bottom", unit: "mm", step: 1, min: 0, max: 100, label: "Bottom" },
            { type: "length", var: "--page-margin-left", unit: "mm", step: 1, min: 0, max: 100, label: "Left" },
            { type: "length", var: "--page-margin-right", unit: "mm", step: 1, min: 0, max: 100, label: "Right" },
          ],
        },
        {
          label: "Paragraph",
          controls: [
            { type: "number", var: "--line-height", step: 0.05, min: 0.8, max: 3, label: "Line spacing" },
            { type: "length", var: "--paragraph-spacing", unit: "em", step: 0.1, min: 0, max: 4, label: "Spacing after" },
            { type: "length", var: "--paragraph-indent", unit: "em", step: 0.5, min: 0, max: 6, label: "First-line indent" },
          ],
        },
      ],
    },
    {
      id: "headings",
      label: "Headings",
      groups: [
        {
          label: "Font",
          controls: [
            { type: "font", var: "--font-heading", label: "Font", stacks: FONT_STACKS },
            {
              type: "select",
              var: "--heading-weight",
              label: "Weight",
              options: [
                ["300", "Light"],
                ["400", "Regular"],
                ["500", "Medium"],
                ["600", "Semibold"],
                ["700", "Bold"],
                ["800", "Extra bold"],
              ],
            },
            { type: "color", var: "--heading-color", label: "Colour" },
          ],
        },
        {
          label: "Sizes",
          controls: [
            { type: "length", var: "--h1-size", unit: "pt", step: 1, min: 8, max: 72, label: "Heading 1" },
            { type: "length", var: "--h2-size", unit: "pt", step: 1, min: 8, max: 72, label: "Heading 2" },
            { type: "length", var: "--h3-size", unit: "pt", step: 0.5, min: 8, max: 72, label: "Heading 3" },
            { type: "length", var: "--h4-size", unit: "pt", step: 0.5, min: 8, max: 72, label: "Heading 4" },
          ],
        },
        {
          label: "Decoration",
          controls: [
            { type: "color", var: "--h1-border-color", label: "H1 underline", allowNone: true },
            { type: "color", var: "--h2-border-color", label: "H2 underline", allowNone: true },
            { type: "length", var: "--heading-space-before", unit: "em", step: 0.1, min: 0, max: 5, label: "Space before" },
          ],
        },
        { label: "Alignment", controls: [align("--heading-align")] },
      ],
    },
    {
      id: "headerfooter",
      label: "Header & Footer",
      groups: [
        {
          label: "Header",
          controls: [
            { type: "text", var: "--header-left", label: "Left", placeholder: "e.g. {title}" },
            { type: "text", var: "--header-center", label: "Centre" },
            { type: "text", var: "--header-right", label: "Right" },
          ],
        },
        {
          label: "Footer",
          controls: [
            { type: "text", var: "--footer-left", label: "Left" },
            { type: "text", var: "--footer-center", label: "Centre", placeholder: "e.g. Page {page} of {pages}" },
            { type: "text", var: "--footer-right", label: "Right" },
          ],
        },
        {
          label: "Insert field",
          controls: [
            { type: "token", token: "{page}", label: "Page number" },
            { type: "token", token: "{pages}", label: "Page count" },
            { type: "token", token: "{title}", label: "Title" },
            { type: "token", token: "{date}", label: "Date" },
          ],
        },
        {
          label: "Style",
          controls: [
            { type: "length", var: "--header-footer-font-size", unit: "pt", step: 0.5, min: 5, max: 20, label: "Size" },
            { type: "color", var: "--header-footer-color", label: "Colour" },
            { type: "toggle", var: "--first-page-header-footer", on: "hide", off: "show", label: "Hide on first page" },
          ],
        },
      ],
    },
    {
      id: "elements",
      label: "Tables & More",
      groups: [
        {
          label: "Tables",
          controls: [
            { type: "color", var: "--table-header-background", label: "Header fill", allowNone: true },
            { type: "color", var: "--table-header-color", label: "Header text" },
            { type: "color", var: "--table-stripe-background", label: "Stripes", allowNone: true },
            { type: "color", var: "--table-border-color", label: "Borders" },
            { type: "length", var: "--table-font-size", unit: "pt", step: 0.5, min: 6, max: 20, label: "Size" },
          ],
        },
        {
          label: "Quotes",
          controls: [
            { type: "color", var: "--blockquote-border-color", label: "Bar" },
            { type: "color", var: "--blockquote-background", label: "Fill", allowNone: true },
            { type: "color", var: "--blockquote-color", label: "Text" },
          ],
        },
        {
          label: "Inline code",
          controls: [
            { type: "color", var: "--inline-code-background", label: "Fill", allowNone: true },
            { type: "color", var: "--inline-code-color", label: "Text" },
          ],
        },
        {
          label: "Images",
          controls: [
            {
              type: "select",
              var: "--image-align",
              label: "Captioned",
              options: [
                ["left", "Left"],
                ["center", "Centre"],
                ["right", "Right"],
              ],
            },
            { type: "length", var: "--image-max-width", unit: "%", step: 5, min: 10, max: 100, label: "Max width" },
          ],
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------

/** Convert any CSS colour to #rrggbb for <input type=color>. */
function toHex(value) {
  const v = (value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return "#" + [...v.slice(1)].map((c) => c + c).join("").toLowerCase();
  const ctx = toHex.ctx || (toHex.ctx = document.createElement("canvas").getContext("2d"));
  ctx.fillStyle = "#000000";
  ctx.fillStyle = v;
  const out = ctx.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(out) ? out : "#000000";
}

const isTransparent = (v) => /^(transparent|none|rgba\([^)]*,\s*0\))$/i.test((v || "").trim());

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

/**
 * Build the ribbon UI.
 * @param {object} opts
 * @param {HTMLElement} opts.tabsEl
 * @param {HTMLElement} opts.panelEl
 * @param {(name: string) => string} opts.getVar   effective value of a variable
 * @param {(changes: Record<string,string|null>) => void} opts.setVars  null removes
 * @param {(id: string, arg?: string) => void} opts.runAction
 * @param {Array} opts.codeThemes
 */
export class Ribbon {
  constructor({ tabsEl, panelEl, getVar, setVars, runAction, codeThemes }) {
    this.getVar = getVar;
    this.setVars = setVars;
    this.runAction = runAction;
    this.bindings = []; // { var, sync(value) }
    this.lastTextField = null;
    this.tabs = ribbonTabs(codeThemes);
    this.panels = new Map();

    for (const tab of this.tabs) {
      const button = el("button", { class: "ribbon-tab", type: "button", role: "tab", "data-tab": tab.id }, tab.label);
      button.addEventListener("click", () => this.select(tab.id));
      tabsEl.append(button);
      const panel = el("div", { class: "ribbon-panel", role: "tabpanel", "data-tab": tab.id });
      for (const group of tab.groups) {
        const body = el("div", { class: "ribbon-group-body" });
        for (const control of group.controls) body.append(this.control(control));
        panel.append(el("div", { class: "ribbon-group" }, body, el("div", { class: "ribbon-group-label" }, group.label)));
      }
      panelEl.append(panel);
      this.panels.set(tab.id, { button, panel });
    }
    this.select(localStorage.getItem("emd.ribbonTab") || "home");
  }

  select(id) {
    if (!this.panels.has(id)) id = "home";
    for (const [tabId, { button, panel }] of this.panels) {
      const active = tabId === id;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active);
      panel.hidden = !active;
    }
    localStorage.setItem("emd.ribbonTab", id);
  }

  /** Refresh every control from the current theme. */
  sync() {
    for (const binding of this.bindings) binding.sync(this.getVar(binding.var));
  }

  bind(name, sync) {
    this.bindings.push({ var: name, sync });
  }

  labelled(control, input) {
    if (!control.label) return input;
    return el("label", { class: "ribbon-field" }, el("span", {}, control.label), input);
  }

  control(c) {
    switch (c.type) {
      case "action":
        return el("button", {
          class: "ribbon-btn",
          type: "button",
          title: c.title,
          "aria-label": c.title,
          html: c.icon,
          onclick: () => this.runAction(c.action),
        });

      case "action-select": {
        const select = el("select", { class: "ribbon-select style-select", title: c.title });
        for (const [value, label] of c.options) select.append(el("option", { value }, label));
        select.addEventListener("change", () => {
          this.runAction(c.action, select.value);
          select.value = "0";
        });
        return select;
      }

      case "select": {
        const select = el("select", { class: "ribbon-select", title: c.title || c.label });
        for (const [value, label] of c.options) select.append(el("option", { value }, label));
        if (c.allowCustom) select.append(el("option", { value: "__custom" }, "Custom…"));
        select.addEventListener("change", () => {
          let value = select.value;
          if (value === "__custom") {
            value = prompt("Page size, e.g. 210mm 297mm or 6in 9in", this.getVar(c.var));
            if (!value) return this.sync();
          }
          this.setVars({ [c.var]: value });
        });
        this.bind(c.var, (value) => {
          if (![...select.options].some((o) => o.value === value)) {
            select.querySelector("option[data-current]")?.remove();
            const opt = el("option", { value, "data-current": true }, value);
            select.insertBefore(opt, select.firstChild);
          }
          select.value = value;
        });
        return this.labelled(c, select);
      }

      case "font": {
        const select = el("select", { class: "ribbon-select font-select", title: c.title || c.label });
        for (const [name, stack] of c.stacks) {
          select.append(el("option", { value: stack, style: `font-family:${stack}` }, name));
        }
        select.append(el("option", { value: "__custom" }, "Other font…"));
        select.addEventListener("change", () => {
          let value = select.value;
          if (value === "__custom") {
            const name = prompt("Font name (must be installed), or a full CSS font stack:", "");
            if (!name) return this.sync();
            value = name.includes(",") ? name : `"${name.replace(/"/g, "")}", sans-serif`;
          }
          this.setVars({ [c.var]: value });
        });
        this.bind(c.var, (value) => {
          const norm = (s) => s.replace(/\s+/g, " ").replace(/'/g, '"').trim();
          const match = [...select.options].find((o) => norm(o.value) === norm(value));
          if (match) {
            select.value = match.value;
          } else {
            select.querySelector("option[data-current]")?.remove();
            const first = value.split(",")[0].replace(/["']/g, "").trim();
            const opt = el("option", { value, "data-current": true, style: `font-family:${value}` }, first);
            select.insertBefore(opt, select.firstChild);
            select.value = value;
          }
        });
        return this.labelled(c, select);
      }

      case "length":
      case "number": {
        const input = el("input", {
          class: "ribbon-number",
          type: "number",
          step: c.step,
          min: c.min,
          max: c.max,
          title: c.title || c.label,
        });
        input.addEventListener("change", () => {
          if (input.value === "") return this.sync();
          this.setVars({ [c.var]: c.type === "length" ? `${input.value}${c.unit}` : input.value });
        });
        this.bind(c.var, (value) => {
          const n = parseFloat(value);
          input.value = Number.isFinite(n) ? String(n) : "0";
        });
        const wrap = el("span", { class: "ribbon-number-wrap" }, input);
        if (c.unit) wrap.append(el("span", { class: "unit" }, c.unit));
        return this.labelled(c, wrap);
      }

      case "color": {
        const input = el("input", { type: "color", class: "ribbon-color", title: c.title || c.label });
        input.addEventListener("input", () => this.setVars({ [c.var]: input.value }, { live: true }));
        input.addEventListener("change", () => this.setVars({ [c.var]: input.value }));
        const wrap = el("span", { class: "ribbon-color-wrap" }, input);
        let none;
        if (c.allowNone) {
          none = el("button", {
            type: "button",
            class: "ribbon-none",
            title: "None",
            onclick: () => this.setVars({ [c.var]: "transparent" }),
          }, "∅");
          wrap.append(none);
        }
        this.bind(c.var, (value) => {
          const transparent = isTransparent(value);
          input.value = transparent ? "#ffffff" : toHex(value);
          wrap.classList.toggle("is-none", transparent);
        });
        return this.labelled(c, wrap);
      }

      case "text": {
        const input = el("input", { type: "text", class: "ribbon-text", placeholder: c.placeholder || "" });
        input.addEventListener("focus", () => (this.lastTextField = { input, var: c.var }));
        input.addEventListener("change", () => this.setVars({ [c.var]: quote(input.value) }));
        this.bind(c.var, (value) => {
          if (document.activeElement !== input) input.value = unquote(value);
        });
        return this.labelled(c, input);
      }

      case "token":
        return el("button", {
          type: "button",
          class: "ribbon-chip",
          title: `Insert ${c.token}`,
          onmousedown: (e) => e.preventDefault(),
          onclick: () => {
            const target = this.lastTextField;
            if (!target) {
              alert("Click into a header or footer box first.");
              return;
            }
            const { input } = target;
            const start = input.selectionStart ?? input.value.length;
            const end = input.selectionEnd ?? start;
            input.value = input.value.slice(0, start) + c.token + input.value.slice(end);
            input.focus();
            input.setSelectionRange(start + c.token.length, start + c.token.length);
            this.setVars({ [target.var]: quote(input.value) });
          },
        }, c.label);

      case "toggle": {
        const input = el("input", { type: "checkbox" });
        input.addEventListener("change", () => this.setVars({ [c.var]: input.checked ? c.on : c.off }));
        this.bind(c.var, (value) => (input.checked = value.trim() === c.on));
        return el("label", { class: "ribbon-toggle" }, input, el("span", {}, c.label));
      }

      case "segmented": {
        const wrap = el("div", { class: "ribbon-segmented", role: "group" });
        const buttons = c.options.map(([value, icon, title]) => {
          const b = el("button", {
            type: "button",
            class: "ribbon-btn",
            title,
            "aria-label": title,
            html: icon,
            onclick: () => this.setVars({ [c.var]: value }),
          });
          b.dataset.value = value;
          wrap.append(b);
          return b;
        });
        this.bind(c.var, (value) => buttons.forEach((b) => b.classList.toggle("active", b.dataset.value === value.trim())));
        return wrap;
      }

      case "margin-presets": {
        const select = el("select", { class: "ribbon-select", title: "Margin presets" });
        select.append(el("option", { value: "" }, "Presets…"));
        for (const [id, [name, m]] of Object.entries(c.presets)) {
          select.append(el("option", { value: id }, `${name} (${m.top} / ${m.left} mm)`));
          select.style.width = "110px";
        }
        select.addEventListener("change", () => {
          const preset = c.presets[select.value];
          select.value = "";
          if (!preset) return;
          const m = preset[1];
          this.setVars({
            "--page-margin-top": `${m.top}mm`,
            "--page-margin-right": `${m.right}mm`,
            "--page-margin-bottom": `${m.bottom}mm`,
            "--page-margin-left": `${m.left}mm`,
          });
        });
        return select;
      }

      case "presets": {
        const gallery = el("div", { class: "preset-gallery" });
        for (const preset of PRESETS) {
          const s = preset.sample;
          const card = el(
            "button",
            {
              type: "button",
              class: "preset-card",
              title: `Apply the ${preset.name} style set`,
              onclick: () => {
                const changes = {};
                for (const name of PRESET_VARS) changes[name] = null;
                Object.assign(changes, preset.vars);
                this.setVars(changes);
              },
            },
            el("span", { class: "preset-title", style: `font-family:${s.heading};color:${s.color}` }, "Title"),
            el("span", { class: "preset-rule", style: `background:${s.accent}` }),
            el("span", { class: "preset-body", style: `font-family:${s.body}` }, "Body text"),
            el("span", { class: "preset-name" }, preset.name),
          );
          gallery.append(card);
        }
        return gallery;
      }

      default:
        return el("span");
    }
  }
}
