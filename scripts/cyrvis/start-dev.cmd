@echo off
setlocal
cd /d "%~dp0\..\.."
call pnpm run dev:ui-tars
endlocal
