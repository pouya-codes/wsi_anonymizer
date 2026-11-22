/**
 * Self-contained login page (no scripts, inline styles only — allowed by CSP).
 */
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function loginPage({ error } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<title>Sign in · Slide Anonymizer</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
    background: #0e1420; color: #e8eef6;
    font: 14px/1.5 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
  }
  .card {
    width: 100%; max-width: 400px; background: #16202e; border: 1px solid #2b3a4f;
    border-radius: 14px; padding: 28px 26px 24px;
  }
  .logo { display: block; height: 34px; width: auto; margin-bottom: 18px; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  p { margin: 0 0 18px; color: #93a4b8; font-size: 13px; }
  label { display: block; font-size: 12px; color: #93a4b8; margin-bottom: 6px; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2b3a4f;
    background: #0e1420; color: #e8eef6; font: inherit;
  }
  input:focus { outline: 2px solid #4c9ffe; outline-offset: 1px; border-color: #4c9ffe; }
  button {
    width: 100%; margin-top: 14px; padding: 10px 12px; border: 0; border-radius: 8px;
    background: #4c9ffe; color: #06101c; font: 600 14px/1.2 inherit; cursor: pointer;
  }
  button:hover { background: #6db1ff; }
  .error {
    margin: 0 0 14px; padding: 9px 12px; border-radius: 8px; font-size: 13px;
    background: rgba(231, 76, 60, 0.12); border: 1px solid rgba(231, 76, 60, 0.4); color: #ffb4ab;
  }
  .note {
    margin: 18px 0 0; padding-top: 14px; border-top: 1px solid #2b3a4f;
    font-size: 12px; color: #93a4b8;
  }
  .note strong { color: #b6f0cd; font-weight: 600; }
</style>
</head>
<body>
  <main class="card">
    <img class="logo" src="/brand/logo-wordmark.svg" alt="cPathPortal">
    <h1>Slide Anonymizer</h1>
    <p>Enter the access password to use the tool.</p>
    ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/login">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Sign in</button>
    </form>
    <p class="note">
      <strong>Your slides stay on your computer.</strong> Anonymization runs inside your
      browser; slides are never uploaded to this server. Only the number of slides
      anonymized with each password is recorded.
    </p>
  </main>
</body>
</html>
`;
}
