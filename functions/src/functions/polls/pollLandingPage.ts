import {onRequest} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";

const REGION = "australia-southeast1";
// Fallback only — the real title is "🏏 {clubName} — Match Poll" once the
// club doc lookup below succeeds. Deliberately does NOT include the poll
// question itself: that already appears in the sender's own message text,
// so the card doesn't need to duplicate it — just enough to say which club.
const DEFAULT_TITLE = "🏏 Crease — Match Poll";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(opts: { title?: string; deepLink?: string }): string {
  const title = opts.title ? escapeHtml(opts.title) : DEFAULT_TITLE;
  // clubId/pollId (and so deepLink) come straight from the request path on
  // this public, unauthenticated endpoint — never trust them into HTML
  // as-is. `<` guards the </script> boundary (JSON.stringify alone
  // doesn't escape "<", so a crafted path could otherwise close the script
  // tag early); escapeHtml guards the href attribute below.
  const deepLinkJs = opts.deepLink ?
    `window.__deepLink = ${JSON.stringify(opts.deepLink).replace(/</g, "\\u003c")}; window.location.href = window.__deepLink;` :
    "window.__deepLink = null;";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="${title}">
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
    margin-top: 22px;
    background: #16a34a;
    color: #ffffff;
    text-decoration: none;
    font-weight: 700;
    padding: 14px 28px;
    border-radius: 10px;
    display: ${opts.deepLink ? "inline-block" : "none"};
  }
  .hint { margin-top: 20px; font-size: 12px; }
</style>
</head>
<body>
  <div class="card" id="card">
    <div class="emoji">🏏</div>
    <h1>Opening Crease…</h1>
    <p id="status-text">Taking you to the match poll.</p>
    <div class="spinner"></div>
    <a class="button" id="open-app" href="${opts.deepLink ? escapeHtml(opts.deepLink) : "#"}">Open in Crease</a>
    <p class="hint">Don't have Crease yet? Ask your club admin for an invite.</p>
  </div>
  <script>
    // The auto-redirect above (window.location.href) can be silently
    // blocked by an in-app browser (e.g. WhatsApp's) when it isn't tied to a
    // direct user gesture — some WebViews only allow non-http(s) scheme
    // navigation from an actual tap. The "Open in Crease" button is a real
    // link with the deep link already wired in from the first render (not
    // added after a delay), so there's always a guaranteed tap-through path
    // even when the automatic redirect above never fires.
    setTimeout(function () {
      document.getElementById('status-text').textContent = window.__deepLink
        ? "Didn't open automatically? Tap below."
        : 'This link looks invalid.';
    }, 1500);
  </script>
</body>
</html>`;
}

/**
 * Landing page for shared match-poll links — a Hosting rewrite (see
 * firebase.json) sends every /poll/{clubId}/{pollId} request here instead of
 * a static file. Only reads the club doc (not the poll doc) — the title
 * says which club the poll belongs to, but never the question/venue/etc,
 * which already appear in the sender's own share-message text. Also builds
 * the custom-scheme redirect — same fallback-after-a-beat UX as before, for
 * anyone who lands on the page itself rather than being intercepted by
 * Universal/App Links.
 */
export const pollLandingPage = onRequest({region: REGION, invoker: "public"}, async (req, res) => {
  const match = req.path.match(/\/poll\/([^/]+)\/([^/?#]+)/);
  if (!match) {
    res.status(404).send(renderPage({}));
    return;
  }
  const [, clubId, pollId] = match;
  const deepLink = `cricket-scorer-app://poll/${clubId}/${pollId}`;

  try {
    const clubSnap = await getFirestore().collection("clubs").doc(clubId).get();
    const clubName = clubSnap.data()?.name as string | undefined;
    const title = clubName ? `🏏 ${clubName} — Match Poll` : undefined;
    res.status(200).send(renderPage({title, deepLink}));
  } catch {
    res.status(200).send(renderPage({deepLink}));
  }
});
