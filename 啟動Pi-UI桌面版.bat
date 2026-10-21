@echo off
title 啟動 Pi Agent 桌面版
cd /d "%~dp0"
echo 正在啟動 Pi Agent 桌面版...
npx electron .
