@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === 하늘 날씨 앱 GitHub에 올리기 ===
echo.
git add .
set "MSG="
set /p MSG=바뀐 내용을 한 줄로 적어 주세요 (그냥 Enter를 누르면 "업데이트"): 
if "%MSG%"=="" set "MSG=업데이트"
git commit -m "%MSG%"
git push
echo.
echo 끝났어요. 1~2분 뒤 https://htcho-max.github.io/weather/ 에서 새로고침해 보세요.
echo GitHub Actions 배포가 '취소됨'이면 Actions 화면에서 Re-run all jobs를 눌러 주세요.
echo Worker 코드(worker/kma-worker.js)가 바뀐 경우에는 Cloudflare에 새 코드를 붙여넣어 주세요.
echo.
pause
