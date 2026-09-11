# FPS field test

## Objective

Use a running Pi Harness to build and iteratively play-test a complete browser FPS, observing its output and repairing confirmed problems.

## Observations

- The development CLI initially failed to resolve packages from its existing home profile. A separate harness home under the test worktree allowed package resolution.
- An empty isolated agent directory had no model credentials. The eventual running web instance uses the global Pi Harness installation, not the edited worktree build. Its status endpoint confirms the intended test workspace and `everyapi/deepseek-v4-flash`.
- The dedicated instance listens on `127.0.0.1:3142`; the pre-existing instance on port 3141 was left running.
- The first FPS request completed one workspace inspection, then spent about eight minutes generating reasoning without creating game files. A sampled 12-second event stream contained 528 live events. This was active generation, not a dead server.
- The status endpoint remained at three messages and fifteen retained events while reasoning streamed. Retained event counts alone cannot distinguish active generation from a stall.
- The first request was explicitly aborted and replaced with a smaller implementation round: write the HTML and CSS first, followed by game logic in subsequent rounds. The full FPS objective remains unchanged.

## Outstanding validation

Game creation, gameplay checks, iteration on failures, and verification of any harness source fixes are still pending. No completion claim is supported yet.

## Iteration 1

The smaller request successfully produced `game/index.html` and `game/style.css` through Pi Harness tool calls. The existing repository README remained untouched. A headless Chromium visit to the control room completed without page errors; the UI reports globally installed version 0.1.31.

Iteration 2 was submitted through the same active session to implement `game/game.js`, a three-wave FPS loop, and `game/README.md`. A dedicated static server listens on port 4175. Gameplay verification awaits the logic file; HTML/CSS alone are not a playable game.

## Iteration 3: reject a false-positive smoke result

The logic file now exists. The original browser smoke script waited for the start menu to disappear, which happened only when the idle player died. It printed gameover snapshots without rejecting them. Its exit code did not prove working gameplay.

The browser test now requires playing state and an immediately hidden start menu, movement, ammunition consumption, a reload that actually starts and finishes, and pause/resume visibility. Before any game fix, Chromium failed with `Start menu must disappear immediately, not only after death`. Source inspection confirms both startGame and resume explicitly call show(startScreen).

The active Pi Harness round was aborted and a focused third-round prompt submitted to repair only overlay visibility and run the real browser test without weakening its assertions. Outcome remains pending. A separate fire cooldown defect is suspected: fireCd is assigned and decremented but never checked in shoot.

Visible-browser limitation: the local control-room URL was opened using macOS, but desktop inspection of Chrome was denied by the computer tool. This is not evidence of visible manual play-testing. The isolated headless browser run above is automated verification only.

Pi Harness subsequently changed show to accept an omitted overlay, and startGame/resume now call show(). An independent rerun of `uv run --with playwright python game/smoke.py` exited 0: playing at start, W displacement over 0.1, magazine 30→29→30, reserve 120→119, paused state and visible pause overlay, then playing with both overlays hidden. No page errors were captured. This verifies the basic input loop only; kills, occlusion, all waves, victory, and death/restart remain unverified.

## Iteration 4: combat and fire interval

`game/cooldown.py` reproduced the missing gate through a real browser double-click: magazine 28 instead of 29. Pi Harness received a focused fix request and added `if (fireCd > 0) return;`. An independent rerun exited 0. The fourth-round request is still awaiting its final response.

The first live-input playthrough killed three enemies but exhausted ammunition against a wall. This exposed a deficient test driver: it stopped near a target even when separated by a wall. The driver now reads arena geometry without mutation, routes around walls, and fires only along a clear line. It controls the player using actual keyboard and pointer-locked mouse inputs, not state setters.

The next `uv run --with playwright python game/playthrough.py` exited 0 with victory, wave 3, 18 kills, score 3320, HP approximately 85.29, and zero page errors. Its browser had loaded the game before the concurrent cooldown patch, so final-version replay is still required. Death/restart, reverse-direction hits, audio audibility, and broader interaction checks remain outstanding. This was isolated headless automation, not a visible manual gameplay session.

## Iteration 5: rear hits and death/reset

Waiting at spawn did not reliably bring enemies into attack range: the rear-hit setup timed out at 30 seconds and the death setup at 60 seconds. The live-input driver now walks around arena walls toward an enemy before asserting combat behavior. This also shows that approximate enemy wall sliding is not reliable pursuit around all arena obstacles.

`uv run --with playwright python game/combat_edges.py --death` exited 0 after natural enemy damage: HP zero, visible game-over overlay, restart returning to playing/wave 1/HP 100/score and kills zero/ammo 30+120 with overlays hidden.

The rear-hit test verified mouse aim more than 3 radians away from the enemy, fired a real shot, and failed because that enemy lost health. The source accepts perpendicular distance without rejecting negative forward projection. A focused fifth-round prompt was submitted to Pi Harness to reject rear targets and correct inaccurate README claims (held automatic fire, unavailable pointer lock, and unimplemented drops). Verification pending.

Pi Harness added the non-positive forward-projection rejection. Independent `combat_edges.py` rerun exited 0 (`rear-hit rejection PASS`). A fresh `playthrough.py` run loaded both the cooldown and rear-hit fixes and exited 0 with 18 kills, wave 3, score 3320, victory overlay visible, and `victory restart PASS`. The restart resets wave, kills, score, and ammunition and hides the victory overlay. No page errors were captured. Remaining gameplay-quality issue: enemy pursuit can stall behind walls; this has not yet been repaired.

## Iteration 6: reliable pursuit

Added `game/navigation.py`, an explicitly isolated AI regression, not live gameplay or victory evidence. It runs the real updateEnemy and collision/map code with four local grunt fixtures from quadrant corners, seeded randomness, and a 30-second simulated budget. All four failed to reach within 1.5 cells of the player (remaining distances 5.45–5.47), without wall crossing. A sixth-round prompt requested small grid navigation while preserving speed, collision radius, and damage. Pi Harness is implementing; outcome pending.

The first BFS patch still failed: periodic replanning returned enemies to their current cell center and prevented progress. Pi Harness is inspecting per-frame waypoint traces. The regression additionally checks that displacement never exceeds the configured speed budget.

Independent code review found incorrect DDA wall-hit distance and unchecked enemy separation. `game/geometry.py` reproduces both with controlled fixtures (not a live-play victory): ray distance 2.41309 instead of 0.80436, hidden enemy HP 90→50, and initially valid separated enemies becoming wall-overlapping. These fixes remain pending; completion is not yet supported.

The second Pi Harness navigation patch passed an independent navigation.py run: all four quadrant fixtures reached 1.48–1.49 cells, with no collision or speed violations in those scenarios. Pi Harness is running its remaining regression suite.

The supervising agent separately fixed the two reviewed geometry defects using narrow patches outside the navigation implementation: DDA returns the boundary before its last increment; enemy separation uses the existing collision-checked movement helper. Independent geometry.py now passes (distance 0.8043629, hidden HP90, valid positions before and after). A new full live-input playthrough has started against these combined changes; result pending.

That combined-version playthrough exited 0 with victory, wave 3, 18 kills, score 3320, HP approximately 66.93, and victory restart PASS. The independent syntax/cooldown/smoke command also exited 0. Pi Harness sixth round finished normally.

A targeted stuck-recovery fixture then caught the fixed 0.2-cell sidestep exceeding the 0.02833-cell frame budget. The supervising agent changed recovery to use only the remaining movement budget. A fresh geometry/navigation/full-playthrough sequence is running against this last patch; final outcome pending.

## Final-version verification

The last-patch geometry/navigation/playthrough sequence exited 0. Geometry reports recovery displacement 0.0283333 within budget, correct first-wall distance, no hidden-target damage, and valid separation. All four navigation fixtures pass. Live-input playthrough reached victory with wave 3, 18 kills, score 3320, HP approximately 70.95; victory restart passed, with no page errors. The game server returns HTTP 200, and the Pi Harness service is ready after six completed rounds.

The complete FPS loop is supported by browser evidence. Manual audio audition, cross-browser/mobile support, and performance benchmarking are not claimed. Browser verification used isolated headless Chromium, not a visible manually controlled personal Chrome window. The separate request to repair all 70+ plugins remains outside this FPS completion and has not been completed. No commit or push was performed.

Final-version rear-hit and natural death/restart reruns both passed and their command exited 0. Syntax and whitespace checks passed. The sanitized completion report was published and its iframe document fetched successfully (HTTP 200 with expected title, sections, and scope disclaimer); the temporary local report was removed. Local game and Pi Harness services remain available. The FPS field-test objective is complete within these stated verification boundaries.
