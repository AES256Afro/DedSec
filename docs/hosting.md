# Hosting

The client is a static site: HTML, one stylesheet, and plain ES modules. No
server, no runtime dependencies, no build service. `npm run build:site` produces
a `site/` directory (~780 KB) that any static host will serve as-is.

```bash
npm run build:site
npx serve site          # or python3 -m http.server, or drag it anywhere
```

## dedsek.whatiwatched.com via GitHub Pages

`.github/workflows/deploy.yml` builds and publishes `site/` on every push to
`main`, gated behind the test suite so a broken world never reaches the domain.
`site/CNAME` is written with the custom domain during the build.

Two steps have to happen outside this repository, and only the account owner can
do them:

**1. Turn Pages on.** Repository → Settings → Pages → *Build and deployment* →
Source: **GitHub Actions**. Then set *Custom domain* to
`dedsek.whatiwatched.com` and tick **Enforce HTTPS** once the certificate has
been issued (usually a few minutes, occasionally up to an hour).

**2. Point DNS at it.** At whatever hosts DNS for `whatiwatched.com`, add:

| Type  | Name     | Value                    |
| ----- | -------- | ------------------------ |
| CNAME | `dedsek` | `aes256afro.github.io.`  |

A `CNAME` is correct here because `dedsek` is a subdomain — apex domains need
`A`/`AAAA` records instead, which is not the case for this one. Propagation is
usually minutes; GitHub will not issue the TLS certificate until it resolves.

Verify with:

```bash
dig +short dedsek.whatiwatched.com
curl -sI https://dedsek.whatiwatched.com | head -1
```

## Anywhere else

Nothing about the build is Pages-specific. `site/` works unchanged on Netlify,
Cloudflare Pages, S3 + CloudFront, or a plain nginx root. Delete `site/CNAME` (or
clear `CUSTOM_DOMAIN` in `scripts/build-site.mjs`) if you are not using Pages
with a custom domain.

Two things worth knowing wherever it lands:

- **Serve `.js` as `text/javascript`.** The client is ES modules; a host that
  serves them as `text/plain` will fail with a MIME type error. Every host above
  does the right thing by default.
- **There is no backend.** World state lives entirely in the browser tab and is
  regenerated from the seed in the URL, so `?seed=marina` is the whole of the
  save system. Nothing is uploaded and there is nothing to secure.
