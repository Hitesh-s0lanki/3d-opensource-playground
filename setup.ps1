<#
    One-shot environment bootstrap.

        .\setup.ps1                 # default, CUDA 12.4 wheels
        .\setup.ps1 -Cuda cpu       # CPU-only torch
        .\setup.ps1 -Cuda cu126     # newer CUDA wheels
        .\setup.ps1 -Recreate       # delete .venv and start clean
#>
[CmdletBinding()]
param(
    [ValidateSet('cu121', 'cu124', 'cu126', 'cpu')]
    [string]$Cuda = 'cu124',
    [switch]$Recreate
)

# NOTE: deliberately NOT 'Stop'.
# uv, pip and git all write ordinary progress to stderr. Under Windows
# PowerShell 5.1 with ErrorActionPreference='Stop', a native command writing to
# stderr raises a terminating NativeCommandError even when it exited 0, which
# aborts this script on a successful install. Correctness comes from checking
# $LASTEXITCODE explicitly after every native call instead.
$ErrorActionPreference = 'Continue'

Set-Location $PSScriptRoot

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "`nFAILED: $msg" -ForegroundColor Red; exit 1 }

function Assert-ExitCode($what) {
    if ($LASTEXITCODE -ne 0) { Die "$what (exit code $LASTEXITCODE)" }
}

# --- 1. uv ------------------------------------------------------------------
Step "Checking for uv"
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Warn "uv not found - installing"
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        Die "uv installed but is still not on PATH. Open a new terminal and re-run."
    }
}
Write-Host "    $(uv --version)"

# --- 2. venv ----------------------------------------------------------------
if ($Recreate -and (Test-Path .venv)) {
    Step "Removing existing .venv"
    Remove-Item -Recurse -Force .venv
}

Step "Creating virtual environment (Python 3.10)"
uv venv --python 3.10
Assert-ExitCode "uv venv"

$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { Die "expected interpreter not found at $py" }

# --- 3. torch ---------------------------------------------------------------
# torch must come from the PyTorch index, not PyPI. Installed BEFORE
# requirements.txt so the pinned CUDA build is already satisfied by the time
# the (unpinned) torch line in requirements.txt is resolved.
Step "Installing torch ($Cuda) - this is a ~2.5 GB download"
$index = if ($Cuda -eq 'cpu') {
    'https://download.pytorch.org/whl/cpu'
} else {
    "https://download.pytorch.org/whl/$Cuda"
}
uv pip install --python $py torch torchvision --index-url $index
Assert-ExitCode "torch install"

# --- 4. everything else -----------------------------------------------------
Step "Installing project requirements"
uv pip install --python $py -r requirements.txt
Assert-ExitCode "requirements install"

# --- 4b. the package itself -------------------------------------------------
# Editable so src/ stays the live source, and so the console scripts
# (dreamspace-generate / dreamspace-view) land on PATH inside the venv.
# --no-deps because requirements.txt was just resolved above; re-resolving from
# pyproject would pull torch from PyPI and clobber the CUDA build.
Step "Installing dreamspace (editable)"
uv pip install --python $py -e . --no-deps
Assert-ExitCode "editable install"

# --- 5. .env ----------------------------------------------------------------
if (-not (Test-Path .env)) {
    Step "Creating .env from .env.example"
    Copy-Item .env.example .env
    Warn "Review .env - HF_HOME defaults to C:/ai/hf-cache to keep 1.7 GB of"
    Warn "weights out of your OneDrive-synced project folder."
} else {
    Step ".env already exists - leaving it alone"
}

New-Item -ItemType Directory -Force -Path inputs, outputs | Out-Null

# --- 6. verify --------------------------------------------------------------
Step "Verifying installation"
& $py -m dreamspace.cli.generate --doctor
$doctor = $LASTEXITCODE

Write-Host ""
if ($doctor -eq 0) {
    Write-Host "Setup complete. Next steps:" -ForegroundColor Green
    Write-Host "  1. Put cropped, single-object images in .\inputs\"
    Write-Host "  2. .\.venv\Scripts\Activate.ps1"
    Write-Host "  3. dreamspace-generate --image inputs\"
} else {
    Warn "Install finished but --doctor reported problems; see the table above."
}
exit $doctor
