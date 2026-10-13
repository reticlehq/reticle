# Reticle GitHub Action

Replays your saved Reticle journeys against a URL on every push or pull request, then reports one check with a verdict for each journey.

```yaml
# .github/workflows/reticle.yml
name: reticle
on: [pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Start or deploy your app first; the action needs a URL that answers.
      - uses: reticlehq/reticle/action@main
        with:
          url: https://preview.example.com
          api-key: ${{ secrets.RETICLE_API_KEY }}
```

## Inputs

| Input | Required | Default | What it does |
| --- | --- | --- | --- |
| `url` | yes | none | The running app to verify |
| `api-key` | yes | none | A Reticle workspace API key. Keep it in a secret |
| `project` | no | empty | The project id. The action uses it to pull the suite when the repository has no `.reticle/flows` |
| `node-version` | no | `20` | The Node.js version Reticle runs on |
| `cloud-url` | no | `https://app.reticle.sh` | The platform. Change it only for a self-hosted platform |

## What it does

1. Installs `@reticlehq/server`, plus the Chromium that version drives.
2. Uses the journeys in `.reticle/flows`. If the repository has none, it pulls the project's suite from the platform.
3. Runs `reticle verify <url> --results-json <file>`. This writes one verdict per journey: `yes`, `no` or `unknown`.
4. Posts those verdicts to the platform as one check for the commit, and prints the details URL. The URL is also the `details-url` output.

## When the job fails

- Any journey's verdict is `no`.
- No journey was verified at all. A run that checked nothing is never a pass.
- The platform needs a card to keep running checks. The job prints the platform's message.
- The platform refused the check, for example because the key is wrong.

The app has to run the Reticle SDK for `verify` to connect. For a preview that is not on `localhost`, see [deploy checks](https://docs.reticle.sh/deploy-checks).
