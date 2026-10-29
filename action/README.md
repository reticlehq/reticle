# Reticle GitHub Action

Replays your saved Reticle journeys against a preview URL, then reports one check with a verdict for each journey.

## On each preview deployment

Vercel and Netlify send a `deployment_status` event when a preview is ready. The event holds the preview URL, so you type no URL.

```yaml
# .github/workflows/reticle.yml
name: reticle
on: [deployment_status]
jobs:
  verify:
    # Run only when the deployment succeeded. The action also skips any other state.
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: reticlehq/reticle/action@v3.9.0
        with:
          api-key: ${{ secrets.RETICLE_API_KEY }}
          # Only for a Vercel preview behind Deployment Protection.
          vercel-bypass-secret: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

## On a pull request, with a URL you give

```yaml
on: [pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Start or deploy your app first. The action needs a URL that answers.
      - uses: reticlehq/reticle/action@v3.9.0
        with:
          url: https://preview.example.com
          api-key: ${{ secrets.RETICLE_API_KEY }}
```

Pin a release tag or a commit SHA, never a branch: `@main` changes under you, so the same workflow can pass one day and fail the next with no change of yours.

## Inputs

| Input | Required | Default | What it does |
| --- | --- | --- | --- |
| `url` | no | none | The running app to verify. When you set it, it wins over the URL in the event |
| `api-key` | yes | none | A Reticle workspace API key. Keep it in a secret |
| `vercel-bypass-secret` | no | none | A Vercel Protection Bypass for Automation secret, for a preview behind Deployment Protection. Keep it in a secret |
| `project` | no | empty | The project id. The action uses it to pull the suite when the repository has no `.reticle/flows` |
| `node-version` | no | `20` | The Node.js version Reticle runs on |
| `cloud-url` | no | `https://app.reticle.sh` | The platform. Change it only for a self-hosted platform |

## Which URL the action verifies

1. On a `deployment_status` event with a state other than `success`, the action verifies nothing and the job passes.
2. When you set `url`, the action uses it.
3. If not, the action uses the event's `environment_url`, then its `target_url`.
4. With no URL from these, the job fails and says so.

## A preview behind protection

**Vercel.** Make a [Protection Bypass for Automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) secret in Project Settings, Deployment Protection. Store it as a repository secret and give it to `vercel-bypass-secret`. Before the replay, the action asks the preview once with the `x-vercel-protection-bypass` and `x-vercel-set-bypass-cookie` headers. Vercel answers with a bypass cookie. The replay's browser starts with that cookie, so each request of the replay gets through. The secret itself does not go to the browser.

**Netlify.** Netlify has no bypass secret for its password protection. Turn off protection for deploy previews, or give a `url` that is not protected.

If the preview answers 401 or 403, the job fails before the replay and says which secret is missing or wrong.

## What it does

1. Installs `@reticlehq/server`, plus the Chromium that version drives.
2. Finds the URL, and asks the preview once to find protection.
3. Uses the journeys in `.reticle/flows`. If the repository has none, it pulls the project's suite from the platform.
4. Runs `reticle verify <url> --results-json <file>`. This writes one verdict per journey: `yes`, `no` or `unknown`. A journey whose run reached the platform also names that run, so the check page can replay it.
5. Posts those verdicts to the platform as one check for the commit, and prints the details URL. The URL is also the `details-url` output.

## When the job fails

- Any journey's verdict is `no`.
- No journey was verified at all. A run that checked nothing is never a pass.
- The preview answered 401 or 403. The job names the secret to set.
- The platform needs a card to keep running checks. The job prints the platform's message.
- The platform refused the check, for example because the key is wrong.

The app has to run the Reticle SDK for `verify` to connect. For a preview that is not on `localhost`, see [deploy checks](https://docs.reticle.sh/deploy-checks).
