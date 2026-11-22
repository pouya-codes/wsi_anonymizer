# Vendored @empaia/wsi-anon (0.4.32)

Source: https://gitlab.com/empaia/integration/wsi-anon  
NPM (GitLab registry): `@empaia/wsi-anon`

## Local patch

`bin/wsi-anon.js` includes a small AIM Lab patch that exposes:

- `AnonymizedStream.ready` — Promise resolved when the WASM runtime is initialized
- `AnonymizedStream.VERSION` — `"0.4.32"`

Re-download when upgrading:

```bash
curl -sL \
  "https://gitlab.com/api/v4/projects/31390692/packages/npm/@empaia/wsi-anon/-/@empaia/wsi-anon-VERSION.tgz" \
  -o /tmp/wsi-anon.tgz
# extract into vendor/wsi-anon, then re-apply the ready/VERSION patch
```
