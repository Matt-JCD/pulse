param(
    [string]$BaseUrl = "https://pulse-by-prefactor-1.onrender.com",
    [int]$BatchSize = 1,
    [int]$PauseSeconds = 90,
    [int]$SeenCount = 475
)

$ErrorActionPreference = "Stop"

while ($true) {
    $summary = Invoke-RestMethod -Method Get -Uri "$BaseUrl/jobs/outreach-import-summary?seen_count=$SeenCount"
    $approved = [int]($summary.status_counts.approved | ForEach-Object { $_ })

    Write-Output "$(Get-Date -Format s) approved=$approved"

    if ($approved -le 0) {
        break
    }

    $send = Invoke-RestMethod -Method Post -Uri "$BaseUrl/jobs/launch-approved-sends?limit=$BatchSize"
    Write-Output "$(Get-Date -Format s) launched=$($send.launched) errors=$(@($send.errors).Count)"
    if (@($send.errors).Count -gt 0) {
        Write-Output "$(Get-Date -Format s) send_errors=$(@($send.errors) -join ' | ')"
    }

    Start-Sleep -Seconds $PauseSeconds
}

$clear = Invoke-RestMethod -Method Post -Uri "$BaseUrl/jobs/clear-awaiting-review-slack?limit=500"
Write-Output "$(Get-Date -Format s) cleared=$($clear.cleared) skipped=$($clear.skipped)"
