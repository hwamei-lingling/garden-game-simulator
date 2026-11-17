"""Optional browser check for the sound effects.
Run from anywhere:  python3 tests/browser_check_sound.py
Needs Python 3 + Playwright. It records which sounds the game asks for (it does not listen to them) and checks the
on/off button, the volume slider, mute, and that real Web Audio runs without errors."""
import pathlib
from playwright.sync_api import sync_playwright

URL = (pathlib.Path(__file__).resolve().parent.parent / "garden-simulator.html").as_uri()
problems = []


def check(name, ok, detail=""):
    print(("ok   - " if ok else "FAIL - ") + name + ("" if ok else f"  ({detail})"))
    if not ok:
        problems.append(name)


with sync_playwright() as p:
    browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    page = browser.new_context(viewport={"width": 1100, "height": 1300}).new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "ERR_" not in m.text else None)
    page.clock.install(time=1_800_000_000_000)
    page.goto(URL)
    page.wait_for_timeout(100)
    page.clock.run_for(500)

    cell = lambda r, c: page.locator(f'.cell[data-row="{r}"][data-col="{c}"]')
    slot = lambda i: page.locator(f'#hotbar .slot[data-slot="{i}"]')
    # Record every requested sound name (the real play() still runs, so real Web Audio is exercised too).
    page.evaluate("""() => { window.heard = []; const real = GardenSound.play;
        GardenSound.play = (n, d = 0) => { window.heard.push(d ? n + '@' + d : n); return real(n, d); }; }""")
    heard = lambda: page.evaluate("window.heard.slice()")
    reset = lambda: page.evaluate("window.heard.length = 0")

    check("the sound file loaded", page.evaluate("typeof GardenSound === 'object' && GardenSound.names().length >= 16"))

    slot(2).click()                                   # daisy seeds
    reset(); cell(0, 0).click()
    check("planting makes the plant sound", "plant" in heard(), str(heard()))
    slot(1).click()                                   # watering can
    reset(); cell(0, 0).click()
    check("watering makes the water sound", "water" in heard(), str(heard()))
    page.clock.run_for(4 * 60 * 1000)
    slot(0).click()                                   # shears
    reset(); cell(0, 0).click()
    check("harvesting makes the shears sound", "harvest" in heard(), str(heard()))

    # Selling gives coins -> coin sound
    page.evaluate("window.garden.game.inventory.add('daisy', 3); window.garden.game.travel('market'); window.garden.ui.render();")
    reset()
    page.evaluate("window.garden.ui.handleSellAll(document.body)")
    check("selling crops makes the coin sound", any(n in ("coin", "coins") for n in heard()), str(heard()))
    reset()
    page.evaluate("window.garden.game.player.coins = 500; window.garden.game.inventory.add('rose', 6); window.garden.ui.handleSellAll(document.body)")
    check("a big sale makes the bigger coin sound", "coins" in heard(), str(heard()))
    reset()
    page.evaluate("window.garden.ui.handleBuy('daisy-seed', 1, document.body)")
    check("buying makes the buy sound", "buy" in heard(), str(heard()))
    reset()
    page.evaluate("window.garden.ui.handleSellAll(document.body)")     # nothing left to sell -> failed action
    check("a failed action makes only the soft error sound", heard() == ["error"], str(heard()))

    # Day / night
    page.evaluate("window.garden.game.travel('meadow'); window.garden.ui.render();")
    reset()
    page.evaluate("window.garden.ui.handleTogglePhase()")                 # day -> night
    check("night falls: night sound", heard() == ["night"], str(heard()))
    reset()
    page.evaluate("window.garden.ui.handleTogglePhase()")                 # night -> day
    check("morning: day sound", heard() == ["day"], str(heard()))
    reset()
    page.evaluate("window.garden.ui.handleSleep()")
    check("sleeping: night then (delayed) day sound", heard() == ["night", "day@1.5"], str(heard()))

    # Seasonal ambience: a continuous background scene that matches the season and day/night, and follows the game.
    scene = lambda: page.evaluate("GardenSound.scene()")
    state = lambda: page.evaluate("({season: window.garden.game.time.season, phase: window.garden.game.time.phase})")
    check("a background scene is already playing and matches the game", scene() == state(), f"{scene()} vs {state()}")
    seen = {}
    for _ in range(40):
        page.evaluate("window.garden.ui.handleSleep()")
        st = state()
        seen[st["season"]] = scene()
        if len(seen) == 4:
            break
    check("all four seasons were reached", sorted(seen) == ["Autumn", "Spring", "Summer", "Winter"], str(list(seen)))
    check("each season switches the background to that season", all(v == {"season": k, "phase": "Day"} for k, v in seen.items()), str(seen))
    heard_all = page.evaluate("window.heard")
    check("seasons no longer play one-off season sounds", not any(n.split("@")[0] in ("spring", "summer", "autumn", "winter") for n in heard_all), str(heard_all[-8:]))
    page.evaluate("window.garden.ui.handleTogglePhase()")                      # day -> night
    check("night changes the background to the night version", scene() == {**state(), "phase": "Night"} and state()["phase"] == "Night", str(scene()))
    page.evaluate("window.garden.ui.handleTogglePhase()")                      # night -> day
    check("morning brings the day version back", scene() == state() and state()["phase"] == "Day", str(scene()))
    page.wait_for_timeout(300)
    check("the background keeps running (the audio engine is running)", page.evaluate("GardenSound.scene() !== null"))

    # Controls: on/off button + volume slider
    def open_controls():
        page.locator("#btn-controls").click()
        page.locator("#panel-controls").wait_for(state="visible")     # wait until the panel is really open before clicking inside it
        page.wait_for_timeout(150)
    open_controls()
    btn = page.locator("#btn-sound")
    check("button starts as Sound: on", "on" in btn.inner_text() and btn.get_attribute("aria-pressed") == "true", btn.inner_text())
    btn.click()
    check("button turns sound off", "off" in btn.inner_text() and btn.get_attribute("aria-pressed") == "false" and not page.evaluate("GardenSound.enabled"),
          f"text={btn.inner_text()!r} pressed={btn.get_attribute('aria-pressed')} enabled={page.evaluate('GardenSound.enabled')} panelOpen={page.evaluate('!!document.querySelector(\'#panel-controls:not([hidden])\')')}")
    reset()
    page.keyboard.press("Escape")
    page.evaluate("window.garden.ui.handleTogglePhase()")
    check("muted: the game still asks, but nothing is played", page.evaluate("GardenSound.play('coin')") is False)
    open_controls()
    btn.click()
    check("button turns sound back on", "on" in btn.inner_text() and page.evaluate("GardenSound.enabled"))
    amb = page.locator("#btn-ambience")
    check("ambience button starts as on", "on" in amb.inner_text() and amb.get_attribute("aria-pressed") == "true", amb.inner_text())
    amb.click()
    check("ambience off stops the background but effects stay on", scene() is None and page.evaluate("GardenSound.enabled") and "off" in amb.inner_text(), str(scene()))
    amb.click()
    check("ambience on brings the current season back", scene() == state(), str(scene()))
    btn.click()
    check("Sound off also stops the background", scene() is None)
    btn.click()
    check("Sound on restarts the background", scene() == state())
    page.locator("#sound-volume").fill("30")
    check("volume slider changes the volume", abs(page.evaluate("GardenSound.volume") - 0.3) < 1e-9, str(page.evaluate("GardenSound.volume")))
    check("choice is saved for next time", page.evaluate("JSON.parse(localStorage.getItem('pixel-garden-sound')).volume") == 0.3)
    page.reload()
    page.wait_for_timeout(200)
    check("the ambience choice is remembered too", page.evaluate("JSON.parse(localStorage.getItem('pixel-garden-sound')).ambience") is True)
    check("after reload the volume is remembered", page.evaluate("GardenSound.volume") == 0.3 and page.locator("#sound-volume").input_value() == "30")
    check("sound settings are not part of the game save", "sound" not in page.evaluate("localStorage.getItem('pixel-garden-save-v2')").lower())

    # Real Web Audio: play every sound, none may throw
    ok = page.evaluate("""() => GardenSound.names().every((n) => GardenSound.play(n))""")
    check("every sound plays on the real Web Audio engine", ok)
    check("no console errors", not errors, str(errors))
    browser.close()

print("\nAll sound browser checks passed" if not problems else f"\n{len(problems)} problem(s): {problems}")
raise SystemExit(1 if problems else 0)
