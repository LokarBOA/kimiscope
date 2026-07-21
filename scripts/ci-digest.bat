@echo off
rem Daily CI digest via headless kimi. Runs under Windows Task Scheduler.
cd /d %USERPROFILE%\Projects
echo. >> %USERPROFILE%\kimi-digest.log
echo === %DATE% %TIME% === >> %USERPROFILE%\kimi-digest.log
%USERPROFILE%\AppData\Roaming\npm\kimi.cmd -c -p "CI digest: using the gh CLI, check my GitHub repos for (1) workflow runs that failed in the last 24h, (2) open PRs, (3) anything else needing attention. Reply with a short digest, no fluff." >> %USERPROFILE%\kimi-digest.log 2>&1
