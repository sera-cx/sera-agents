// Extracted from index.html's inline <script> so the CSP can drop
// script-src 'unsafe-inline'. Behaviour is unchanged; `defer` keeps it
// running after parse, as an end-of-body inline script did.
// Mobile menu toggle
const menuBtn = document.getElementById("menu-btn");
const mobileMenu = document.getElementById("mobile-menu");
menuBtn.addEventListener("click", () => {
  const open = mobileMenu.classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
});
// Close mobile menu on nav click
mobileMenu.querySelectorAll("a").forEach((a) => {
  a.addEventListener("click", () => {
    mobileMenu.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");
  });
});

// Tabs (install section)
document.querySelectorAll('[role="tablist"]').forEach((bar) => {
  const buttons = bar.querySelectorAll(".tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => {
        b.setAttribute("aria-selected", "false");
      });
      btn.setAttribute("aria-selected", "true");
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab-panel").forEach((p) => {
        p.classList.toggle("active", p.dataset.panel === target);
      });
    });
  });
});

// Build-with-Sera carousel pagination
(() => {
  const pages = document.getElementById("build-pages");
  if (!pages) return;
  const numButtons = document.querySelectorAll(".build-pagination [data-page]");
  const prev = document.getElementById("build-prev");
  const next = document.getElementById("build-next");
  const total = numButtons.length;
  let active = 0;

  function render(idx) {
    active = Math.max(0, Math.min(total - 1, idx));
    pages.style.transform = `translateX(-${active * 100}%)`;
    numButtons.forEach((b, i) => {
      b.setAttribute("aria-current", i === active ? "true" : "false");
    });
    prev.disabled = active === 0;
    next.disabled = active === total - 1;
  }

  numButtons.forEach((btn, i) => {
    btn.addEventListener("click", () => render(i));
  });
  prev.addEventListener("click", () => render(active - 1));
  next.addEventListener("click", () => render(active + 1));

  // Keyboard nav (arrow keys when build section is in viewport)
  document.addEventListener("keydown", (e) => {
    const buildSection = document.getElementById("build");
    if (!buildSection) return;
    const r = buildSection.getBoundingClientRect();
    const inView = r.top < window.innerHeight * 0.6 && r.bottom > window.innerHeight * 0.4;
    if (!inView) return;
    if (e.key === "ArrowLeft" && !prev.disabled) render(active - 1);
    if (e.key === "ArrowRight" && !next.disabled) render(active + 1);
  });
})();
