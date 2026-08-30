import {onRequest} from "firebase-functions/v2/https";

const REGION = "australia-southeast1";
// Deliberately static and identical for every poll — the actual question
// already appears in the sender's own message text; the auto-generated
// preview card is just a clean, minimal, always-the-same branded stamp
// with no description line and nothing else in it.
const CARD_TITLE = "🏏 Crease — Match Poll";

function renderPage(deepLink?: string): string {
  const deepLinkJs = deepLink ?
    `window.__deepLink = ${JSON.stringify(deepLink)}; window.location.href = window.__deepLink;` :
    "window.__deepLink = null;";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${CARD_TITLE}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="${CARD_TITLE}">
<meta property="og:type" content="website">
<script>${deepLinkJs}</script>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0b1f14;
    color: #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
  }
  .card { max-width: 420px; text-align: center; }
  .emoji { font-size: 56px; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 700; }
  p { color: #9db8ab; font-size: 14px; line-height: 1.5; margin: 0; }
  .spinner {
    width: 22px; height: 22px; margin: 18px auto 0;
    border: 3px solid rgba(255,255,255,0.25);
    border-top-color: #16a34a;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  a.button {
    display: none;
    margin-top: 22px;
    background: #16a34a;
    color: #ffffff;
    text-decoration: none;
    font-weight: 700;
    padding: 14px 28px;
    border-radius: 10px;
  }
  .hint { margin-top: 20px; font-size: 12px; display: none; }
  .fallback-visible a.button, .fallback-visible .hint { display: inline-block; }
  .fallback-visible .spinner { display: none; }
</style>
</head>
<body>
  <div class="card" id="card">
    <div class="emoji">🏏</div>
    <h1>Opening Crease…</h1>
    <p id="status-text">Taking you to the match poll.</p>
    <div class="spinner"></div>
    <a class="button" id="open-app" href="#">Open in Crease</a>
    <p class="hint">Don't have Crease yet? Ask your club admin for an invite.</p>
  </div>
  <script>
    setTimeout(function () {
      if (window.__deepLink) {
        document.getElementById('open-app').href = window.__deepLink;
      }
      document.getElementById('status-text').textContent = window.__deepLink
        ? "Didn't open automatically?"
        : 'This link looks invalid.';
      document.getElementById('card').classList.add('fallback-visible');
    }, 1500);
  </script>
</body>
</html>`;
}

/**
 * Landing page for shared match-poll links — a Hosting rewrite (see
 * firebase.json) sends every /poll/{clubId}/{pollId} request here instead of
 * a static file. No Firestore lookup: the Open Graph title/description are
 * intentionally static and identical for every poll (see CARD_TITLE above),
 * so this only needs to parse clubId/pollId out of the path to build the
 * custom-scheme redirect — same fallback-after-a-beat UX as before, for
 * anyone who lands on the page itself rather than being intercepted by
 * Universal/App Links.
 */
export const pollLandingPage = onRequest({region: REGION, invoker: "public"}, (req, res) => {
  const match = req.path.match(/\/poll\/([^/]+)\/([^/?#]+)/);
  if (!match) {
    res.status(404).send(renderPage());
    return;
  }
  const [, clubId, pollId] = match;
  res.status(200).send(renderPage(`cricket-scorer-app://poll/${clubId}/${pollId}`));
});
