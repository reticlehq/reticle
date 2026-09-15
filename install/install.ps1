# Reticle, in one line, on a stock Windows box:
#
#   irm https://reticle.sh/install.ps1 | iex
#
# The twin of install.sh, and it exists because `sh` is not on a stock Windows machine at all:
# without this, the majority platform is told to install Git Bash or WSL before it can run the
# command every doc shows. The prototype next door shipped both a .sh and a .cmd for the same
# reason; this is that decision applied to the installer.
#
# The pair is safe because there is almost nothing to drift. Both launchers do the same three
# things that CANNOT be Node, because Node may not exist yet:
#
#   1. is there a usable `node`?
#   2. npm install -g @reticlehq/server
#   3. hand every other decision to `reticle setup install`
#
# Everything else -- writing config, registering the MCP server with the agents on this machine,
# saying what happened -- is `reticle setup install`, which is Node and exists once. If either
# launcher ever needs a fourth step, it belongs in that command, not in here twice.
#
# ZERO HUMAN INPUT. Nothing is asked. The common case is an agent following a link somebody pasted,
# and a prompt there is a hang nobody sees.

$ErrorActionPreference = 'Stop'

$ReticlePkg = '@reticlehq/server'
# The floor the package declares in `engines`. Repeated here because nothing can read package.json
# before Node exists; `engines` stays the source of truth and this is the pre-Node echo of it.
$NodeMinMajor = 20
$StateDir = if ($env:RETICLE_STATE_DIR) { $env:RETICLE_STATE_DIR } else { Join-Path $HOME '.reticle' }

function Say([string]$Message) { [Console]::Error.WriteLine($Message) }

# Takes the lines as an array rather than one here-string. Here-strings in this file broke on the
# backticks in `node`/`reticle`, which PowerShell reads as escapes, and a launcher that does not
# parse is worse than one that is plain.
function Die([string[]]$Lines) {
  Say ("reticle: " + ($Lines -join [Environment]::NewLine))
  exit 1
}

# The ONE thing this script reports on its own, and only on failure.
#
# A pre-Node failure has nobody to emit it -- that is the whole reason for the handoff below. One
# line on disk means that if the person fixes the cause and installs later, the CLI drains it and
# the funnel shows a retry after a failure, which is exactly the shape worth seeing.
function Note-Failure([string]$Step, [string]$Reason) {
  if ($env:RETICLE_TELEMETRY -eq '0') { return }
  if ($env:DO_NOT_TRACK) { return }
  if (Test-Path (Join-Path $StateDir 'telemetry-opt-out')) { return }
  try {
    if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force $StateDir | Out-Null }
    $line = '{{"phase":"install","step":"{0}","status":"failed","reason":"{1}"}}' -f $Step, $Reason
    Add-Content -Path (Join-Path $StateDir 'install-trace.jsonl') -Value $line -Encoding utf8
  } catch {
    # A machine that cannot take the note is not a reason to fail the install.
  }
}

function Check-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Note-Failure 'runtime_ready' 'no_node'
    Die @(
      "Node $NodeMinMajor+ is required and no 'node' was found.",
      '',
      '  winget  winget install OpenJS.NodeJS.LTS',
      '  any     https://nodejs.org/en/download',
      '',
      'Reticle does not install a runtime for you. A piped script that puts a language toolchain on',
      'your machine without asking is not something you should run, from us or from anybody.'
    )
  }
  # `node -v` and split HERE, rather than `node -p 'process.versions.node.split(".")[0]'`.
  #
  # Two Windows-only traps, both of which reported a perfectly good Node 24 as "too old":
  # PowerShell strips the inner double quotes before the native command sees them, so node received
  # `split(.)` and died on a syntax error; and `2>$null` on a native command wraps stderr in an
  # ErrorRecord, which under $ErrorActionPreference = 'Stop' throws. Passing no quoted argument at
  # all avoids both, and `v24.21.0` is a shape that does not need a JS expression to read.
  $major = 0
  try { $major = [int]((& node -v).TrimStart('v').Split('.')[0]) } catch { $major = 0 }
  if ($major -lt $NodeMinMajor) {
    Note-Failure 'runtime_ready' 'node_too_old'
    Die @("Node $major is too old -- Reticle needs $NodeMinMajor or newer.")
  }
}

function Install-Cli {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Note-Failure 'cli_installed' 'no_npm'
    Die @('npm was not found, and it ships with Node. Reinstall Node from nodejs.org.')
  }
  Say "Installing $ReticlePkg..."
  # Native stderr is not a failure signal here; the exit code is. `npm install -g` writes progress
  # to stderr on a perfectly good install, and treating that as an error fails every run.
  & npm install -g $ReticlePkg 2>&1 | ForEach-Object { Say $_ }
  if ($LASTEXITCODE -ne 0) {
    Note-Failure 'cli_installed' 'npm_install'
    Die @("npm could not install $ReticlePkg. Its output above says why.")
  }
  if (-not (Get-Command reticle -ErrorAction SilentlyContinue)) {
    # Installed, but the global bin is not on PATH. Common, and reporting it as success would put
    # somebody in the funnel as installed while nothing they type works.
    Note-Failure 'cli_installed' 'not_on_path'
    Die @(
      "Installed, but 'reticle' is not on your PATH. Add npm's global bin directory:",
      '  $env:PATH = "$(npm prefix -g);$env:PATH"'
    )
  }
}

function Main {
  if ($args -contains '-h' -or $args -contains '--help') {
    Say 'usage: install.ps1 [--no-mcp]'
    exit 0
  }
  $started = Get-Date
  Check-Node
  $runtimeDone = Get-Date
  Install-Cli
  $installed = Get-Date
  # Seconds, not milliseconds, and the same two numbers install.sh reports -- a duration silently
  # 1000x out is worse than one that is coarse.
  $runtimeSecs = [int]($runtimeDone - $started).TotalSeconds
  $installSecs = [int]($installed - $runtimeDone).TotalSeconds
  & reticle setup install --runtime-secs $runtimeSecs --install-secs $installSecs @args
  exit $LASTEXITCODE
}

# LAST on purpose, exactly as in install.sh: an `irm | iex` cut off mid-download otherwise runs
# whatever prefix arrived. This way a truncated file defines functions and runs none of them.
Main @args
