# Выпуск обновления: сборка, zip для автообновления и релиз на GitHub.
# Перед запуском поднимите "version" в package.json и закоммитьте изменения.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
$zip = Join-Path (Get-Location) 'release\LargoClean-win.zip'

npm run build
if ($LASTEXITCODE -ne 0) { throw 'Сборка не удалась' }

if (Test-Path $zip) { Remove-Item $zip -Force }
# Архив — содержимое win-unpacked без вложенной папки: updater.js копирует его поверх папки программы
Compress-Archive -Path 'release\win-unpacked\*' -DestinationPath $zip -CompressionLevel Optimal

git push
gh release create $tag $zip --repo largodevelop/Largo-Clean --title "Largo Clean $tag" --notes "Largo Clean $tag"
if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать релиз' }
Write-Host "Релиз $tag опубликован"
