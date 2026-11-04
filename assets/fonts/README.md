# assets/fonts/

Self-hosted web fonts. Replaces the Google Fonts stylesheet and its two
`preconnect` hints, which were the last third-party origins the pages loaded
and the last reason the CSP could not be `style-src 'self'; font-src 'self'`.

## Provenance

Fetched from the Google Fonts CSS API v2 on 2026-11-04, with a Chrome
user-agent so the API returns `woff2`:

```
https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800
  &family=JetBrains+Mono:wght@400;500;600&display=swap
```

## Why six files and not sixty

That stylesheet declares 60 `@font-face` rules — 9 font variants (Inter at six
weights, JetBrains Mono at three) across 7 unicode subsets. But Google serves
the **same variable-font file** for every weight of a given family+subset: the
27 URLs across the three subsets kept here are only 6 distinct files, verified
by content hash. So `assets/css/fonts.css` declares each face once with a
weight *range* (`300 800`, `400 600`) pointing at the shared file, rather than
once per weight.

## Subsets kept: latin, latin-ext, greek

The pages use 25 distinct non-ASCII characters. Dashes, bullets and ellipses
are in `latin` (general punctuation); `Δ` is in `greek`. The rest — arrows
(`→ ↔`), math (`≈ ≠ ≤ ≥`), box-drawing (`─ │ ┌ ┐`) and geometric shapes
(`▶ ▼ ◀`) — are in **no** Google subset for these families, so they fell back
to a system font before this change too.

Dropping `cyrillic`, `cyrillic-ext`, `greek-ext` and `vietnamese` takes this
from 1039 KiB to 197 KiB. `unicode-range` means a browser only downloads the
subsets a page actually needs, so adding one back is just a matter of
re-running the fetch with that subset included.

| File | Bytes |
|---|---|
| `inter-latin.woff2` | 48256 |
| `inter-latin-ext.woff2` | 85068 |
| `inter-greek.woff2` | 18996 |
| `jetbrains-mono-latin.woff2` | 31432 |
| `jetbrains-mono-latin-ext.woff2` | 11624 |
| `jetbrains-mono-greek.woff2` | 6836 |

Both families are SIL Open Font License 1.1.
