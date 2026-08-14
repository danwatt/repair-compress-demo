// Shared tab bar for the four demo pages.
//
// The pages are hand-edited and self-contained, so the nav lives here rather
// than four times over: it injects its own style and markup at the top of
// `.wrap` and marks the current page from the URL. It uses the palette custom
// properties every page already declares, so it inherits each page's colours
// without knowing anything about them.
(() => {
  "use strict";

  const PAGES = [
    { href: "demo.html", label: "RPR1", note: "compression lab" },
    { href: "demo-ylk1.html", label: "YLK1", note: "link chase" },
    { href: "demo-verse.html", label: "Verse", note: "one verse, address by address" },
    { href: "demo-search.html", label: "Search", note: "one query, both codecs" },
  ];

  const CSS = `
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin: 0 0 26px;
  border-bottom: 1px solid var(--rule);
}
.tabs a {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 14px 9px;
  text-decoration: none;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 2px 2px 0 0;
  margin-bottom: -1px;
  color: var(--ink-soft);
  background: transparent;
}
.tabs a .label {
  font-family: var(--pixel, "Silkscreen", "IBM Plex Mono", monospace);
  font-size: 11px;
  letter-spacing: .06em;
  color: var(--dmg-3);
}
.tabs a .note {
  font-size: 10px;
  color: var(--ink-soft);
}
.tabs a:hover {
  background: var(--panel);
  border-color: var(--rule);
}
.tabs a:hover .label { color: var(--dmg-4, var(--dmg-3)); }
.tabs a[aria-current="page"] {
  background: var(--panel);
  border-color: var(--rule);
  box-shadow: inset 0 2px 0 var(--hot);
  cursor: default;
}
.tabs a[aria-current="page"] .label { color: var(--hot); }
.tabs a:focus-visible { outline: 2px solid var(--hot); outline-offset: 2px; }
@media (max-width: 620px) {
  .tabs a .note { display: none; }
}
`;

  function currentPage() {
    const file = location.pathname.split("/").pop();
    if (!file || file === "index.html") return "demo.html";
    return file.endsWith(".html") ? file : file + ".html";
  }

  function build() {
    const wrap = document.querySelector(".wrap");
    if (!wrap || wrap.querySelector(".tabs")) return;

    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const here = currentPage();
    const nav = document.createElement("nav");
    nav.className = "tabs";
    nav.setAttribute("aria-label", "demos");
    for (const page of PAGES) {
      const link = document.createElement("a");
      link.href = page.href;
      if (page.href === here) link.setAttribute("aria-current", "page");
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = page.label;
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = page.note;
      link.append(label, note);
      nav.appendChild(link);
    }
    wrap.insertBefore(nav, wrap.firstChild);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
