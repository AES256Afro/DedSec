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

Two steps have to happen by hand, once. Neither can be automated, and it is
worth knowing exactly why.

**1. Turn Pages on.** Settings → Pages → *Build and deployment* → Source:
**GitHub Actions**.

The workflow declares `pages: write`, which is enough to *publish to* a Pages
site — but not to *create* one. Creating it is an admin operation, and asking
for it from a workflow token fails with:

```
Create Pages site failed. Error: Resource not accessible by integration
```

`actions/configure-pages` advertises an `enablement: true` parameter that sounds
like it solves this. It does not, for the same reason: it calls the same
create-site endpoint with the same token. Do not bother trying it.

So the workflow checks instead. If Pages is off, the build still succeeds — the
code is fine — and the run summary spells out this setting. Only genuine
breakage turns the workflow red, which keeps the signal worth reading.

**2. Point DNS at Pages.** At whatever hosts DNS for `whatiwatched.com`, add:

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
