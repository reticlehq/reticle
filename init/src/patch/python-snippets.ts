/**
 * The connect snippets for Python apps (Streamlit, Django), which have no JS build to inline the
 * token. Each one reads this machine's pairing token from the token file when the page is served,
 * so the token is never in `init` output or in the pasted code.
 */
import { CDN_SDK_URL, withTokenExpression } from './snippets.js';

/** Where the Python snippets put the token, until the page is served. */
const PYTHON_TOKEN_PLACEHOLDER = '__RETICLE_PAIRING_TOKEN__';

/** Python that reads this machine's pairing token at run time, the way the daemon finds it. */
const PYTHON_TOKEN_READER = `def _reticle_pairing_token():
    folder = os.environ.get("RETICLE_PAIRING_TOKEN_DIR") or str(Path.home() / ".reticle")
    try:
        return (Path(folder) / "pairing-token").read_text().strip()
    except OSError:
        return ""`;

/** The connect literal for a Python snippet: the token is substituted when the page is served. */
export function pythonConnectArg(connectArgLiteral: string): string {
  return withTokenExpression(connectArgLiteral, PYTHON_TOKEN_PLACEHOLDER);
}

/**
 * Streamlit has no served HTML template, and `st.markdown` inserts script markup without executing
 * it. Streamlit 1.63 added an explicit JavaScript boundary to `st.html`; use a classic script there
 * so it can dynamically import the ESM SDK in the app document. A head marker makes reruns
 * idempotent and is removed after an import failure so the next rerun can retry.
 */
export function streamlitPageSnippet(connectArgLiteral: string): string {
  return `import json
import os
from pathlib import Path

import streamlit as st


${PYTHON_TOKEN_READER}


st.html(
    """
    <script>
      (() => {
        if (document.getElementById('reticle-streamlit-connect')) return;
        const marker = document.createElement('meta');
        marker.id = 'reticle-streamlit-connect';
        document.head.appendChild(marker);
        void import('${CDN_SDK_URL}')
          .then(({ reticle }) => reticle.connect(${connectArgLiteral}))
          .catch((error) => {
            marker.remove();
            throw error;
          });
      })();
    </script>
    """.replace("${PYTHON_TOKEN_PLACEHOLDER}", json.dumps(_reticle_pairing_token())),
    unsafe_allow_javascript=True,
)`;
}

/**
 * DEBUG-only middleware that injects Reticle into every Django-rendered page.
 *
 * Django serves templates, so the generic script tag has no single home: an app has many templates
 * and a base template it may not have. Middleware has exactly one, runs for every page, and is the
 * idiomatic Django answer — a field reporter arrived at this same shape by hand after `init` printed
 * a script tag and exited 1, and had to write the middleware and `.reticle.json` themselves.
 *
 * Guarded on `settings.DEBUG` so it can never reach production, and on the response being HTML so it
 * does not corrupt a JSON API response or a file download. Injected before `</body>` rather than in
 * `<head>`, so the SDK sees a parsed document.
 */
export function djangoMiddlewareSnippet(connectArgLiteral: string): string {
  return `# reticle_dev.py: add to MIDDLEWARE while DEBUG is on:
#   MIDDLEWARE = [..., "reticle_dev.ReticleDevMiddleware"]
import json
import os
from pathlib import Path

from django.conf import settings

_SNIPPET = """<script type="module">
  import { reticle } from '${CDN_SDK_URL}';
  reticle.connect(${connectArgLiteral});
</script>"""


${PYTHON_TOKEN_READER}


class ReticleDevMiddleware:
    """Inject the Reticle SDK into HTML responses during development only."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if not settings.DEBUG:
            return response
        if "text/html" not in response.get("Content-Type", ""):
            return response
        # Streaming responses have no .content to rewrite; leave them alone.
        if getattr(response, "streaming", False):
            return response
        body = response.content.decode(response.charset)
        if "</body>" not in body:
            return response
        snippet = _SNIPPET.replace("${PYTHON_TOKEN_PLACEHOLDER}", json.dumps(_reticle_pairing_token()))
        response.content = body.replace("</body>", snippet + "</body>", 1).encode(
            response.charset
        )
        if response.has_header("Content-Length"):
            response["Content-Length"] = str(len(response.content))
        return response
`;
}
