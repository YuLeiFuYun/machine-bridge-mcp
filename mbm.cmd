@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules\wrangler (
  echo Installing local dependencies...
  call npm install || exit /b %errorlevel%
)
node bin\machine-mcp.mjs %*
