import {onRequest} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {logger} from "firebase-functions/v2";

const REGION = "australia-southeast1";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(opts: { title: string; description?: string; deepLink?: string }): string {
  const deepLinkJs = opts.deepLink ?
    `window.__deepLink = ${JSON.stringify(opts.deepLink)}; window.location.href = window.__deepLink;` :
    "window.__deepLink = null;";
  const descriptionTag = opts.description ?
    `<meta property="og:description" content="${escapeHtml(opts.description)}">` :
    "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(opts.title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="${escapeHtml(opts.title)}">
${descriptionTag}
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
 * Dynamic replacement for the old static public/poll/index.html — a Hosting
 * rewrite (see firebase.json) sends every /poll/{clubId}/{pollId} request
 * here instead. Renders per-poll Open Graph tags (the actual question/venue)
 * so WhatsApp's own link-preview card reflects the specific poll rather than
 * a generic "Crease — Match Poll" title, then redirects to the custom-scheme
 * deep link (same fallback-after-a-beat UX as before) for anyone who lands
 * on the page itself rather than being intercepted by Universal/App Links.
 */
export const pollLandingPage = onRequest({region: REGION, invoker: "public"}, async (req, res) => {
  logger.info(`pollLandingPage: req.path=${req.path} req.originalUrl=${req.originalUrl}`);
  const match = req.path.match(/\/poll\/([^/]+)\/([^/?#]+)/);
  if (!match) {
    logger.warn("pollLandingPage: path did not match expected /poll/{clubId}/{pollId} shape");
    res.status(404).send(renderPage({title: "🏏 Crease — Match Poll"}));
    return;
  }
  const [, clubId, pollId] = match;
  logger.info(`pollLandingPage: parsed clubId=${clubId} pollId=${pollId}`);
  const deepLink = `cricket-scorer-app://poll/${clubId}/${pollId}`;

  try {
    const db = getFirestore();
    const snap = await db.collection("clubs").doc(clubId).collection("matchPolls").doc(pollId).get();
    const data = snap.data();
    if (!data) {
      logger.warn(`pollLandingPage: no poll doc at clubs/${clubId}/matchPolls/${pollId}`);
      res.status(200).send(renderPage({
        title: "🏏 Crease — Match Poll",
        description: "This poll may have expired or been removed.",
        deepLink,
      }));
      return;
    }

    const question = (data.question as string) ?? "Match Poll";
    const venue = data.venue as string | undefined;
    const options = (data.options as {label: string}[] | undefined) ?? [];
    const multiSelect = data.multiSelect as boolean | undefined;

    // Only real, poll-specific info here — no generic "tap to say if you're
    // in" filler line; if there's nothing specific to add, the question in
    // the title carries the card on its own.
    const optionsPart = multiSelect && options.length > 0 ? options.map((o) => o.label).join(" or ") : "";
    const venuePart = venue ?? "";
    const description = [venuePart, optionsPart].filter(Boolean).join(" · ");

    res.status(200).send(renderPage({title: `🏏 ${question}`, description: description || undefined, deepLink}));
  } catch {
    res.status(200).send(renderPage({title: "🏏 Crease — Match Poll", deepLink}));
  }
});
