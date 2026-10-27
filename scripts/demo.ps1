<#
Run the demo club on this laptop, so it can be shown in person: on the laptop
itself, and on phones on the same Wi-Fi (or on the laptop's / your phone's hotspot).

    demo.cmd            start; the demo club gets fresh dates once a day. Press Enter to stop.
    demo.cmd -Reset     rebuild the demo club now, then start
    demo.cmd -Detach    leave it running in the background; stop it later with demo.cmd -Stop
    demo.cmd -Stop      stop a demo left running

The demo has its own database (padel_demo): the real club's data is never touched.
The API listens on this laptop only; phones reach it through the website on port 5174.
#>
param([switch]$Reset, [switch]$Detach, [switch]$Stop)

$root = Split-Path -Parent $PSScriptRoot
$state = Join-Path $root ".demo"
$python = Join-Path $root ".venv\Scripts\python.exe"
$pidFile = Join-Path $state "pids.txt"
$apiPort = 8001
$webPort = 5174
$slug = "padel-arena-demo"

New-Item -ItemType Directory -Force $state | Out-Null
Set-Location $root

function Stop-Demo {
    if (Test-Path $pidFile) {
        foreach ($id in Get-Content $pidFile) { & taskkill /PID $id /T /F *> $null }
        Remove-Item $pidFile
    }
}

function Fail($message) {
    Write-Host ""
    Write-Host "  $message" -ForegroundColor Red
    Stop-Demo
    exit 1
}

function Test-Url($url) {
    try { return (Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}

if ($Stop) {
    Stop-Demo
    Write-Host "Demo stopped."
    exit 0
}

# Whatever an earlier run left behind (a closed window does not stop its servers).
Stop-Demo
foreach ($port in $apiPort, $webPort) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        Fail "Port $port is already in use. Is the demo already running? Stop it with demo.cmd -Stop, or close the other program."
    }
}

# 1. The database, in Docker.
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Starting Docker Desktop..."
    $desktop = @(
        (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"),
        "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $desktop) { Fail "Docker Desktop is not installed. Install it, then run the demo again." }
    Start-Process $desktop
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 3
        & docker info *> $null
        if ($LASTEXITCODE -eq 0) { break }
    }
    if ($LASTEXITCODE -ne 0) { Fail "Docker did not start. Open Docker Desktop, wait until it is running, and try again." }
}
Write-Host "Starting the database..."
& docker compose up -d db *> $null
if ($LASTEXITCODE -ne 0) { Fail "The database did not start (docker compose up -d db)." }
for ($i = 0; $i -lt 30; $i++) {
    & docker compose exec -T db pg_isready -U padel *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 1
}
$exists = & docker compose exec -T db psql -U padel -d padel -tAc "SELECT 1 FROM pg_database WHERE datname = 'padel_demo'"
if ("$exists".Trim() -ne "1") {
    & docker compose exec -T db psql -U padel -d padel -c "CREATE DATABASE padel_demo" *> $null
}

# 2. The demo club. Its bookings are dated around today, so it is rebuilt once a day.
$env:DB_NAME = "padel_demo"
$env:PAYMENTS_DEMO = "1"            # the demo payment page; no real money
$env:DJANGO_ALLOWED_HOSTS = "*"     # phones reach the API through the website's address
& $python manage.py migrate --noinput -v 0
if ($LASTEXITCODE -ne 0) { Fail "Updating the demo database failed (see the messages above)." }
$stamp = Join-Path $state "seeded-on.txt"
$today = Get-Date -Format "yyyy-MM-dd"
$seeded = if (Test-Path $stamp) { (Get-Content $stamp).Trim() } else { "" }
if ($Reset -or $seeded -ne $today) {
    Write-Host "Preparing the demo club with fresh dates (about a minute)..."
    & $python manage.py seed_demo --reset
    if ($LASTEXITCODE -ne 0) { Fail "Preparing the demo club failed (see the messages above)." }
    Set-Content $stamp $today
}

# 3. The API (this laptop only) and the website (the whole network).
if (-not (Test-Path (Join-Path $root "frontend\node_modules\vite"))) {
    Write-Host "Installing the website's packages (first time only)..."
    Push-Location (Join-Path $root "frontend")
    & npm install --no-audit --no-fund
    Pop-Location
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed." }
}
$env:API_TARGET = "http://127.0.0.1:$apiPort"
$api = Start-Process -FilePath $python -ArgumentList "manage.py", "runserver", "127.0.0.1:$apiPort", "--noreload" `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $state "api.log") -RedirectStandardError (Join-Path $state "api-errors.log")
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail "Node.js is not installed." }
$web = Start-Process -FilePath $node -ArgumentList "node_modules/vite/bin/vite.js", "--host", "0.0.0.0", "--port", "$webPort", "--strictPort" `
    -WorkingDirectory (Join-Path $root "frontend") -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $state "web.log") -RedirectStandardError (Join-Path $state "web-errors.log")
Set-Content $pidFile @($api.Id, $web.Id)

Write-Host "Starting the servers..."
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Url "http://127.0.0.1:$webPort/api/public/clubs/$slug/") { $ready = $true; break }
}
if (-not $ready) { Fail "The servers did not start. Details are in the .demo folder (api-errors.log, web-errors.log)." }

# 4. The address phones use: the Wi-Fi or cable network, not VPNs or virtual adapters.
$lan = Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.InterfaceAlias -notmatch "tun|tap|vEthernet|VPN|WireGuard|Tailscale|ZeroTier|Loopback" } |
    ForEach-Object { $_.IPv4Address.IPAddress } | Select-Object -First 1
$address = if ($lan) { $lan } else { "localhost" }
$site = "http://${address}:$webPort"

# Windows must let phones in. Node.js is usually allowed when it first asks; say so if it is blocked.
$nodeRules = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue |
    Where-Object { $_.Program -eq $node } | Get-NetFirewallRule |
    Where-Object { $_.Direction -eq "Inbound" -and $_.Enabled -eq "True" }
$blocked = $nodeRules | Where-Object { $_.Action -eq "Block" }

Write-Host ""
Write-Host "  Padel Booking demo is running" -ForegroundColor Green
Write-Host ""
Write-Host "  Admin site:        $site/"
Write-Host "  Sign in:           demo_owner / padel-demo-2026   (also demo_manager, demo_desk)"
Write-Host "  Customers' page:   $site/book/$slug"
Write-Host "  QR code for phones: Club settings > Online booking > QR code"
Write-Host ""
if (-not $lan) {
    Write-Host "  No Wi-Fi or cable network found: only this laptop can open the site." -ForegroundColor Yellow
    Write-Host "  Connect to Wi-Fi, or turn on your phone's hotspot and connect the laptop to it." -ForegroundColor Yellow
} else {
    Write-Host "  Phones must be on the same Wi-Fi as this laptop (or on its hotspot)."
}
if ($blocked) {
    Write-Host "  Windows Firewall blocks Node.js, so phones cannot open the site. Allow it in" -ForegroundColor Yellow
    Write-Host "  Windows Security > Firewall > Allow an app through firewall > Node.js (Private and Public)." -ForegroundColor Yellow
}
Write-Host ""

Start-Process "$site/"

if ($Detach) {
    Write-Host "  It keeps running in the background. Stop it with: demo.cmd -Stop"
    exit 0
}
try {
    Read-Host "  Press Enter to stop the demo" | Out-Null
} finally {
    Stop-Demo
    Write-Host "  Demo stopped."
}
