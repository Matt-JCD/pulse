param(
    [string]$BaseUrl = "https://pulse-by-prefactor-1.onrender.com",
    [int]$BatchSize = 5,
    [int]$PauseSeconds = 90,
    [int]$MaxBatches = 0
)

$ErrorActionPreference = "Stop"

$batch = 0

while ($true) {
    if ($MaxBatches -gt 0 -and $batch -ge $MaxBatches) {
        Write-Output "$(Get-Date -Format s) MaxBatches reached; stopping."
        break
    }

    $batch += 1
    $url = "$BaseUrl/jobs/draft-outreach?limit=$BatchSize"
    $response = Invoke-RestMethod -Method Post -Uri $url
    $drafted = [int]($response.drafted | ForEach-Object { $_ })

    Write-Output "$(Get-Date -Format s) Batch $batch drafted=$drafted limit=$BatchSize"

    if ($drafted -le 0) {
        Write-Output "$(Get-Date -Format s) No more detected rows to draft; stopping."
        break
    }

    Start-Sleep -Seconds $PauseSeconds
}

