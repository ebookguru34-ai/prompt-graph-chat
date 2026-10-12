@echo off
setlocal
title Kokoro TTS (port 8880)
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker not found. Install Docker Desktop, or see TTS.md for the non-docker option.
  pause
  exit /b 1
)
docker info >nul 2>nul
if errorlevel 1 (
  echo Docker is installed but not running. Start Docker Desktop and try again.
  pause
  exit /b 1
)
set IMAGE=ghcr.io/remsky/kokoro-fastapi-cpu:latest
set GPUFLAG=
where nvidia-smi >nul 2>nul
if not errorlevel 1 (
  set IMAGE=ghcr.io/remsky/kokoro-fastapi-gpu:latest
  set GPUFLAG=--gpus all
)
if /i "%1"=="cpu" (
  set IMAGE=ghcr.io/remsky/kokoro-fastapi-cpu:latest
  set GPUFLAG=
)
echo Starting %IMAGE% on http://localhost:8880  (first run downloads the image)
echo In the app: Settings - Text-to-speech - Kokoro-FastAPI, URL http://localhost:8880
docker run --rm %GPUFLAG% -p 8880:8880 %IMAGE%
echo Kokoro stopped.
pause
