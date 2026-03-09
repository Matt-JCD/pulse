param(
    [string]$BaseUrl = "https://pulse-by-prefactor-1.onrender.com",
    [int]$BatchSize = 1,
    [int]$PauseSeconds = 90,
    [int]$MaxRuns = 0
)

$ErrorActionPreference = "Stop"

$run = 0

while ($true) {
    if ($MaxRuns -gt 0 -and $run -ge $MaxRuns) {
        Write-Output "$(Get-Date -Format s) MaxRuns reached; stopping."
        break
    }

    $run += 1
    $url = "$BaseUrl/jobs/launch-approved-sends?limit=$BatchSize"
    $response = Invoke-RestMethod -Method Post -Uri $url
    $launched = [int]($response.launched | ForEach-Object { $_ })
    $errors = @($response.errors)

    Write-Output "$(Get-Date -Format s) Run $run launched=$launched errors=$($errors.Count)"

    if ($errors.Count -gt 0) {
        Write-Output "$(Get-Date -Format s) Errors: $($errors -join ' | ')"
    }

    if ($launched -le 0 -and $errors.Count -eq 0) {
        Write-Output "$(Get-Date -Format s) No approved rows launched; stopping."
        break
    }

    Start-Sleep -Seconds $PauseSeconds
}
