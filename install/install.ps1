# Reticle, in one line, on a stock Windows box:
#
#   irm https://raw.githubusercontent.com/reticlehq/reticle/main/install/install.ps1 | iex
#
# The twin of install.sh, and it exists because `sh` is not on a stock Windows machine at all:
# without this, the majority platform is told to install Git Bash or WSL before it can run the
# command every doc shows. The prototype next door shipped both a .sh and a .cmd for the same
# reason; this is that decision applied to the installer.
#
# The pair is safe because there is almost nothing to drift. Both launchers do the same four
# things, the first two of which CANNOT be Node, because Node may not exist yet:
#
#   1. is there a usable `node`?
#   2. npm install -g @reticlehq/server
#   3. hand every other decision to `reticle setup install`
#   4. show `reticle tutorial` verifying a demo app
#
# Everything else -- writing config, registering the MCP server with the agents on this machine,
# saying what happened -- is `reticle setup install`, which is Node and exists once. If either
# launcher ever needs a fifth step, it belongs in that command, not in here twice.
#
# ZERO HUMAN INPUT. Nothing is asked. The common case is an agent following a link somebody pasted,
# and a prompt there is a hang nobody sees.

$ErrorActionPreference = 'Stop'

$ReticlePkg = '@reticlehq/server'
# The floor the package declares in `engines`. Repeated here because nothing can read package.json
# before Node exists; `engines` stays the source of truth and this is the pre-Node echo of it.
$NodeMinMajor = 20
# See install.sh: engines.node is >=20.11, so a major-only check admits 20.0-20.10 and defers the
# refusal to npm, after this script has already told the user they were fine.
$NodeMinMinor = 11
$StateDir = if ($env:RETICLE_STATE_DIR) { $env:RETICLE_STATE_DIR } else { Join-Path $HOME '.reticle' }

function Say([string]$Message) { [Console]::Error.WriteLine($Message) }

# `irm | iex` runs this file inside the user's own PowerShell session, where `exit` closes that
# session: the error, or the success text and its next step, vanish with the window. Run as a file
# (`powershell -File install.ps1`), `exit` is right, because the process exit code is the contract.
# So: exit when this is a file, otherwise unwind to the bottom of the file with the code set.
$script:ReticleExitCode = 0
function Quit([int]$Code) {
  if ($PSCommandPath) { exit $Code }
  $script:ReticleExitCode = $Code
  throw 'reticle-exit'
}

# `npm` and `reticle` resolve to their `.ps1` shims first, and the default Windows execution policy
# refuses to run a .ps1 ("running scripts is disabled on this system"), so a stock machine failed
# right after the Node check. The `.cmd` shims sit beside them and are not subject to the policy.
function Native([string]$Name) {
  if (Get-Command "$Name.cmd" -ErrorAction SilentlyContinue) { return "$Name.cmd" }
  return $Name
}

# Takes the lines as an array rather than one here-string. Here-strings in this file broke on the
# backticks in `node`/`reticle`, which PowerShell reads as escapes, and a launcher that does not
# parse is worse than one that is plain.
function Die([string[]]$Lines) {
  Say ("reticle: " + ($Lines -join [Environment]::NewLine))
  Quit 1
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
    # Not Add-Content -Encoding utf8: on Windows PowerShell 5.1 that writes a BOM, and a JSON-lines
    # reader then rejects the first line.
    [IO.File]::AppendAllText((Join-Path $StateDir 'install-trace.jsonl'), $line + "`n")
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
      'Install Node, then run the same command again. Reticle does not install a runtime for you: a piped script that puts a language toolchain on your machine without asking is not something you should run, from us or from anybody.'
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
  $minor = 0
  try {
    $parts = (& node -v).TrimStart('v').Split('.')
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
  } catch { $major = 0; $minor = 0 }
  if (($major -lt $NodeMinMajor) -or (($major -eq $NodeMinMajor) -and ($minor -lt $NodeMinMinor))) {
    Note-Failure 'runtime_ready' 'node_too_old'
    Die @("Node $major.$minor is too old -- Reticle needs $NodeMinMajor.$NodeMinMinor or newer. Install a newer one (winget install OpenJS.NodeJS.LTS, or nodejs.org), then run the same command again.")
  }
}

function Install-Cli {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Note-Failure 'cli_installed' 'no_npm'
    Die @('npm was not found, and it ships with Node. Reinstall Node from nodejs.org.')
  }
  Say "Installing $ReticlePkg..."
  Say '  npm prints nothing until it finishes. First run on a cold cache takes a minute.'
  # Native stderr is not a failure signal here; the exit code is. `npm install -g` writes progress
  # to stderr on a perfectly good install, and under $ErrorActionPreference = 'Stop' Windows
  # PowerShell 5.1 turns the first stderr line into a terminating error (see Check-Node), so the
  # preference is relaxed for this one native call.
  $ErrorActionPreference = 'Continue'
  & (Native 'npm') install -g $ReticlePkg 2>&1 | ForEach-Object { Say "$_" }
  $npmRc = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($npmRc -ne 0) {
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
    Quit 0
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
  # Same four steps as install.sh, and the same reason the wording lives here: this file is served
  # from main, so what a new user reads changes on merge, without an npm release.
  # Step 3: registration stays Node's; its closing tour is cut at its first line. If that line is
  # ever reworded the cut finds nothing and the full text prints: noisy, never broken.
  # Native stderr under $ErrorActionPreference = 'Stop' becomes a throwing ErrorRecord (see Check-Node),
  # so it is relaxed for exactly the two native calls whose stderr is output, not failure.
  $ErrorActionPreference = 'Continue'
  $out = & (Native 'reticle') setup install --runtime-secs $runtimeSecs --install-secs $installSecs @args 2>&1
  $rc = $LASTEXITCODE
  foreach ($line in $out) {
    if ("$line" -match 'Reticle is installed\. How it works') { break }
    Write-Output "$line"
  }
  if ($rc -ne 0) { $ErrorActionPreference = 'Stop'; Quit $rc }

  # Step 4: a real verdict on Reticle's own demo app, before anything touches the user's project.
  # A port the OS says is free, run from the temp dir so a crash log never lands in the user's
  # folder, and never fatal.
  Say 'Watching Reticle verify a demo app...'
  # From .NET, not `node -e`: PowerShell strips the inner quotes a JS snippet needs (see Check-Node).
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $listener.Stop()
  Push-Location $env:TEMP
  $demo = & (Native 'reticle') tutorial --run --headless --port $port 2>&1
  $demoRc = $LASTEXITCODE
  Pop-Location
  $ErrorActionPreference = 'Stop'
  if ($demoRc -eq 0) {
    foreach ($line in $demo) {
      if ("$line" -notmatch '^\{"t"' -and "$line" -notmatch '^  why:') { Write-Output "$line" }
    }
  } else {
    Say "  skipped: no browser could start here. Reticle is installed; 'reticle doctor' says why."
  }

  # One next step. Redirected output means an agent ran this, and an agent cannot restart itself.
  Say ''
  if (-not [Console]::IsOutputRedirected) {
    Say "Done. Open your coding agent in your app's folder and ask:"
    Say '  "Verify one flow in my running app with Reticle."'
    Say "Agent already open? Restart it once so it loads Reticle's tools."
  } else {
    Say "Done. Next, in the user's app folder: 'reticle init' wires the app and proves it connects."
    Say "The reticle_* tools load when this agent session restarts. Cannot restart yourself? 'reticle init --relaunch' prints the command that resumes this conversation with the tools loaded."
  }
  Quit 0
}

# LAST on purpose, exactly as in install.sh: an `irm | iex` cut off mid-download otherwise runs
# whatever prefix arrived. This way a truncated file defines functions and runs none of them.
try {
  Main @args
} catch {
  if ("$_" -ne 'reticle-exit') { throw }
  $global:LASTEXITCODE = $script:ReticleExitCode
}
