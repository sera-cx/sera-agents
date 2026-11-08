import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

/** Every HTML file the static image serves. Templates ship separately. */
const sitePages = async () => {
  const pages = ["index.html"];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(dir, root), {
      withFileTypes: true,
    })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".html")) pages.push(path);
    }
  };
  await walk("docs");
  return pages;
};

const styleSrcAllowsInline = (csp) => {
  const directive = csp.match(/style-src([^;"]*)/)?.[1] ?? "";
  return directive.includes("'unsafe-inline'");
};

test("the edge CSP does not permit inline styles", async () => {
  const caddy = await read("agents-gateway/deploy/Caddyfile");
  const csp = caddy.match(/Content-Security-Policy\s+"([^"]+)"/)?.[1];

  assert.ok(csp, "Caddyfile declares no Content-Security-Policy");
  assert.equal(
    styleSrcAllowsInline(csp),
    false,
    "style-src regained 'unsafe-inline' — if that is deliberate, this test " +
      "and the no-style-attribute rule below should go together",
  );
});

test("no page uses a style attribute the CSP would block", async () => {
  // style-src governs style attributes too (via style-src-attr's fallback), so
  // under style-src 'self' every `style="..."` is dropped silently: the page
  // still renders, just not as designed, and only the console says so. Colours
  // belong in utility classes, which compile into assets/tailwind.css.
  const caddy = await read("agents-gateway/deploy/Caddyfile");
  const csp = caddy.match(/Content-Security-Policy\s+"([^"]+)"/)?.[1] ?? "";
  if (styleSrcAllowsInline(csp)) return;

  const offenders = [];
  for (const page of await sitePages()) {
    const matches = (await read(page)).match(/\sstyle="[^"]*"/g);
    if (matches) offenders.push(`${page} (${matches.length})`);
  }

  assert.deepEqual(
    offenders,
    [],
    `inline style attributes are blocked at the edge: ${offenders.join(", ")}`,
  );
});
