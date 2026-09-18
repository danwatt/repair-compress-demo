// Shared tab bar for the demo pages.
//
// The pages are hand-edited and self-contained, so the nav lives here rather
// than seven times over: it injects the markup at the top of `.wrap` and marks
// the current page from the URL. The look of `.tabs` is in design-system.css
// with the rest of the system, so this file is markup only.
(() => {
  "use strict";

  const PAGES = [
    { href: "demo.html", label: "RPR1", note: "compression lab" },
    { href: "demo-ylk1.html", label: "YLK1", note: "link chase" },
    { href: "demo-verse.html", label: "Verse", note: "one verse, address by address" },
    { href: "demo-search.html", label: "Search", note: "one query, both codecs" },
    { href: "demo-reader.html", label: "Reader", note: "the curved LCD font" },
    { href: "demo-device.html", label: "Device", note: "the whole machine" },
    { href: "design-system.html", label: "System", note: "tokens and parts" },
  ];

  function currentPage() {
    const file = location.pathname.split("/").pop();
    if (!file || file === "index.html") return "demo.html";
    return file.endsWith(".html") ? file : file + ".html";
  }

  function build() {
    const wrap = document.querySelector(".wrap");
    if (!wrap || wrap.querySelector(".tabs")) return;

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
