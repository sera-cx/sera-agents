/**
 * Build-time Tailwind config.
 *
 * Every page used to ship this same object as an inline `tailwind.config = {...}`
 * script alongside the Play CDN, which compiled utilities in the browser. That
 * required `script-src 'unsafe-inline'` and a third-party script origin. The
 * config now lives here and the utilities are compiled into assets/tailwind.css.
 *
 * The three inline copies (index.html, docs/index.html, the other 11 docs pages)
 * differed only in whitespace, so this single config reproduces all of them.
 */
module.exports = {
  content: ["./index.html", "./docs/**/*.html"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        ink: { 950: "#06070A", 900: "#0B0D12", 800: "#11141B", 700: "#181C26" },
        chalk: { 50: "#F8F8F4", 100: "#EDEDE6", 300: "#A4A89C", 500: "#6B7180" },
        accent: { 400: "#7DF9C2", 500: "#3DE8A0", 600: "#10C77F" },
      },
    },
  },
};
