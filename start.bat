@echo off
rem Starts the Family Vault backend (port 4000) and frontend (port 8080).
start "Family Vault API" cmd /k "cd /d %~dp0backend && npm start"
start "Family Vault UI" cmd /k "cd /d %~dp0frontend && npx vite dev"
timeout /t 6 >nul
start http://localhost:8080
