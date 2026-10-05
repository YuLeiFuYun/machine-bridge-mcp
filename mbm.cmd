@echo off
setlocal
cd /d "%~dp0" || exit /b 1
if not exist node_modules\.bin\wrangler.cmd (
  echo Installing local dependencies...
  call npm ci || exit /b 1
)
node bin\machine-mcp.mjs %*
