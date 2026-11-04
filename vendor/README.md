# vendor/

Third-party browser assets served from our own origin.

## tailwindcss-3.4.17.js

The Tailwind Play CDN build, vendored deliberately.

`index.html` previously loaded `https://cdn.tailwindcss.com` — unversioned, so
whatever that host served executed on the `agents.sera.cx` origin, with no way
to verify it. Subresource Integrity cannot fix that: `integrity` requires
`crossorigin="anonymous"`, and `cdn.tailwindcss.com` sends no
`Access-Control-Allow-Origin` header, so adding SRI blocks the script outright.

Serving it ourselves removes the third-party origin from the page entirely and
lets the CSP drop to `script-src 'self' 'unsafe-inline'`.

| | |
|---|---|
| Source | `https://cdn.tailwindcss.com/3.4.17` |
| Retrieved | 2026-11-04 |
| sha384 | `igm5BeiBt36UU4gqwWS7imYmelpTsZlQ45FZf+XBn9MuJbn4nQr7yx1yFydocC/K` |

Verify with:

```bash
curl -sS https://cdn.tailwindcss.com/3.4.17 \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

This is still the in-browser compiler. The real fix is to compile Tailwind at
build time and ship a static stylesheet, which would also let the CSP drop
`'unsafe-inline'` from `style-src`.
