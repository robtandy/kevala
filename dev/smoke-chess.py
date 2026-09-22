#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.50"]
# ///
"""Exercise Chess in a real browser without downloading or running a model.

Start `pnpm serve`, then run:
    uv run dev/smoke-chess.py --channel chrome

Omit --channel to use Playwright's Chromium instead of installed Chrome:
    uv run --with playwright python -m playwright install chromium
    uv run dev/smoke-chess.py

Uses an isolated browser context and deferred stub classifier responses. Checks
local and model play, special moves, keyboard/focus, responsive layout, errors,
stale results, and navigation alongside Tetris. External/weight requests fail the
check; this tests UI integration, not real model quality or GPU inference.
"""

import argparse
import asyncio
import json
import re
from urllib.parse import urlsplit

from playwright.async_api import async_playwright, expect


async def move(page, source, destination):
    await page.locator(f'[data-square="{source}"]').click()
    await page.locator(f'[data-square="{destination}"]').click()


async def reset(page, fen=None):
    await page.evaluate("fen => chess.reset(fen || undefined)", fen)


async def history(page, expected):
    assert await page.evaluate("chess.controller.game.history()") == expected


async def job(page, count):
    await page.wait_for_function("n => chessTest.jobs.length === n", arg=count)
    assert await page.evaluate("chess.controller.busy")


async def local_play(page):
    await expect(page.locator('footer a[href="#/chess"]')).to_have_count(1)
    await expect(page.locator("[data-board] [data-square]")).to_have_count(64)
    await expect(page.locator("[data-gate-wrap]")).to_be_visible()
    await page.locator("[data-mode]").select_option("local")
    await expect(page.locator("[data-gate-wrap]")).to_be_hidden()
    await expect(page.locator("[data-color-field]")).to_be_hidden()
    await expect(page.locator("[data-action=pause]")).to_be_disabled()
    await expect(page.locator("[data-action=undo]")).to_be_disabled()

    await move(page, "e2", "e5")  # illegal, not a pawn teleport
    await history(page, [])
    await page.locator('[data-square="e2"]').click()
    assert await page.locator(".ch-square.legal").evaluate_all("xs => xs.map(x => x.dataset.square).sort()") == ["e3", "e4"]
    await page.locator('[data-square="e4"]').click()
    await move(page, "e7", "e5")
    await history(page, ["e4", "e5"])
    await expect(page.locator("[data-history] tbody tr")).to_have_count(1)
    await expect(page.locator("[data-status]")).to_have_text("White to move.")
    await page.locator("[data-action=undo]").click()
    await history(page, ["e4"])
    await page.locator("[data-action=reset]").click()

    await page.locator('[data-square="e2"]').focus()
    for key in ["Enter", "ArrowUp", "ArrowUp", "Space"]:
        await page.keyboard.press(key)
    await history(page, ["e4"])
    await page.locator("[data-action=flip]").click()
    await expect(page.locator("[data-square]").first).to_have_attribute("data-square", "h1")
    await page.locator('[data-square="e7"]').click()
    await page.keyboard.press("ArrowUp")
    await expect(page.locator('[data-square="e6"]')).to_be_focused()
    await page.keyboard.press("Escape")
    await expect(page.locator(".ch-square.selected")).to_have_count(0)
    await expect(page.locator('[data-square][tabindex="0"]')).to_have_count(1)
    await page.locator("[data-action=flip]").click()
    print("PASS local play, undo, flip, and keyboard controls")


async def special_moves(page):
    castle = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
    for destination, rook, san in [("g1", "f1", "O-O"), ("c1", "d1", "O-O-O")]:
        await reset(page, castle)
        await move(page, "e1", destination)
        await history(page, [san])
        assert await page.evaluate("square => chess.controller.game.get(square).type", rook) == "r"
        await page.locator("[data-action=undo]").click()
        assert await page.evaluate("chess.controller.game.fen()") == castle

    await reset(page, "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1")
    await move(page, "e5", "d6")
    await history(page, ["exd6"])
    await expect(page.locator('[data-square="d5"]')).to_have_attribute("aria-label", "d5, empty")

    # The chooser must scroll into view, and choosing/cancelling must return focus
    # to the board even on a phone where both cannot fit on screen at once.
    await page.set_viewport_size({"width": 390, "height": 844})
    promotion = "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"
    for piece in ["q", "r", "b", "n"]:
        await reset(page, promotion)
        await move(page, "a7", "a8")
        await history(page, [])
        await expect(page.locator("[data-promote=q]")).to_be_focused()
        await expect(page.locator("[data-promotion]")).to_be_in_viewport(ratio=1)
        await page.locator(f"[data-promote={piece}]").click()
        assert await page.evaluate("chess.controller.game.get('a8').type") == piece
        await expect(page.locator("[data-promotion]")).to_be_hidden()
        await expect(page.locator('[data-square="a8"]')).to_be_focused()
        await expect(page.locator('[data-square="a8"]')).to_be_in_viewport(ratio=0.99)
    await reset(page, promotion)
    await move(page, "a7", "a8")
    await page.keyboard.press("Escape")
    await expect(page.locator("[data-promotion]")).to_be_hidden()
    await expect(page.locator('[data-square="a8"]')).to_be_focused()
    await history(page, [])

    await reset(page, "7k/6Q1/5K2/8/8/8/8/8 b - - 0 1")
    await expect(page.locator("[data-status]")).to_have_text("White wins by checkmate.")
    await expect(page.locator('[data-square="h8"]')).to_have_class(re.compile(r"\bin-check\b"))
    await reset(page, "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")
    await expect(page.locator("[data-status]")).to_have_text("Draw by stalemate.")
    await page.set_viewport_size({"width": 1280, "height": 1000})
    await reset(page)
    print("PASS castling, en passant, all promotions, mobile focus, and game outcomes")


async def tetris_navigation(page):
    await move(page, "e2", "e4")
    await page.locator('header [data-route="tetris"]').click()
    await page.locator(".view-tetris .ov-play").click()
    await page.keyboard.press("Space")
    assert await page.evaluate("tetris.game.pieces") == 1
    await page.locator('header [data-route="chess"]').click()
    await expect(page.locator(".view-chess")).to_be_visible()
    await history(page, ["e4"])
    assert await page.evaluate("tetris.game.paused")
    await page.locator('[data-square="e7"]').click()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Space")
    await history(page, ["e4", "e6"])
    assert await page.evaluate("tetris.game.pieces") == 1, "hidden Tetris must not consume Chess input"
    await reset(page)
    print("PASS Chess/Tetris navigation, retained positions, and isolated input")


async def model_play(page):
    await page.evaluate("""() => {
        window.chessTest = {
            jobs: [],
            attach() {
                const jobs = this.jobs;
                const owned = [];
                const session = kevala_site.session;
                session.model = 'kev-0.8b';
                session.kevala = {
                    info: { backend: 'wasm', threads: 16, loadMs: 1 },
                    decideMany(items) {
                        return new Promise((resolve, reject) => {
                            const job = { items, resolve, reject };
                            jobs.push(job); owned.push(job);
                        });
                    },
                    dispose() { for (const job of owned) job.reject(new Error('disposed')); },
                };
                session.status = 'ready';
                session.dispatchEvent(new Event('change'));
            },
            finish(index, san) {
                const { items, resolve } = this.jobs[index];
                const chosen = state => state.includes(`(${san}).`);
                if (!items.some(item => chosen(item.state))) throw new Error(`Illegal stub move: ${san}`);
                resolve(items.map(({state}) => ({
                    answers: {good: {type: 'noul', noul: 0.5}},
                    raw_probabilities: {good: chosen(state) ? [0.499, 0.501] : [0.501, 0.499]},
                })));
            },
        };
        chessTest.attach();
    }""")
    await page.locator("[data-mode]").select_option("human")
    await move(page, "e2", "e4")
    await job(page, 1)
    assert await page.evaluate("chessTest.jobs[0].items.length") == 20
    await move(page, "e7", "e5")  # human cannot move the classifier's pieces
    await history(page, ["e4"])
    await page.evaluate("chessTest.finish(0, 'e5')")
    await page.wait_for_function("!chess.controller.busy")
    await history(page, ["e4", "e5"])
    await expect(page.locator("[data-metrics]")).to_contain_text("Black chose e5 · 20 legal moves")
    await expect(page.locator(".ch-candidates li")).to_have_count(5)
    payload = json.loads(await page.locator("[data-input]").text_content())
    assert payload["response"]["raw_probabilities"]["good"][1] == 0.501
    assert "(e5)." in payload["input"]["state"]

    await reset(page)
    await page.locator("[data-color]").select_option("b")
    await expect(page.locator("[data-square]").first).to_have_attribute("data-square", "h1")
    await job(page, 2)
    await page.evaluate("chessTest.finish(1, 'e4')")
    await page.wait_for_function("!chess.controller.busy")
    await move(page, "e7", "e5")
    await job(page, 3)
    await page.evaluate("chessTest.jobs[2].reject(new Error('<b>stub inference failure</b>'))")
    await expect(page.locator("[data-error]")).to_be_visible()
    await expect(page.locator("[data-error-text]")).to_have_text("<b>stub inference failure</b>")
    await expect(page.locator("[data-error-text] b")).to_have_count(0)
    await history(page, ["e4", "e5"])
    await page.locator("[data-action=retry]").click()
    await job(page, 4)
    await page.evaluate("chessTest.finish(3, 'Nf3')")
    await page.wait_for_function("!chess.controller.busy")
    await expect(page.locator("[data-error]")).to_be_hidden()
    await history(page, ["e4", "e5", "Nf3"])

    await page.locator("[data-action=pause]").click()
    await page.locator("[data-mode]").select_option("self")
    assert await page.evaluate("chess.controller.paused && chess.controller.timer === null")
    await page.locator("[data-action=pause]").click()
    await job(page, 5)
    await page.locator("[data-action=reset]").click()
    assert await page.evaluate("chess.controller.busy && chessTest.jobs.length === 5")
    await page.evaluate("chessTest.finish(4, 'Nc6')")  # old position: discarded
    await job(page, 6)
    await history(page, [])

    await page.locator('header [data-route="how"]').click()
    await expect(page.locator(".view-chess")).to_be_hidden()
    await page.evaluate("chessTest.jobs[5].reject(new Error('stale failure'))")
    await page.wait_for_function("!chess.controller.busy")
    assert await page.evaluate("chess.controller.error === null && chess.controller.timer === null")
    await page.locator('header [data-route="chess"]').click()
    await job(page, 7)
    await page.evaluate("kevala_site.session.unload()")
    await page.wait_for_function("!chess.controller.busy")
    await history(page, [])
    await expect(page.locator("[data-error]")).to_be_hidden()
    await expect(page.locator("[data-gate-wrap] .gate")).to_be_visible()
    await page.evaluate("chessTest.attach()")
    await job(page, 8)
    await page.locator("[data-mode]").select_option("local")
    await page.evaluate("chessTest.finish(7, 'd4')")
    await page.wait_for_function("!chess.controller.busy")
    await history(page, [])
    await move(page, "e2", "e4")
    await history(page, ["e4"])
    print("PASS classifier ownership, raw scores, errors/retry, pause, and stale requests")


async def responsive_layout(page):
    # Keep the longer Kev + CPU chip visible: Laya's idle chip misses wrapping bugs.
    for width in [1280, 1100, 1024, 1001, 960, 900, 850, 800, 768, 760, 600, 420, 390, 320]:
        await page.set_viewport_size({"width": width, "height": 900})
        await page.evaluate("scrollTo(0, 0)")
        dimensions = await page.evaluate("""() => {
            const board = document.querySelector('[data-board]').getBoundingClientRect();
            const chip = document.querySelector('.mchip').getBoundingClientRect();
            return {overflow: document.documentElement.scrollWidth > innerWidth,
                    board: Math.abs(board.width - board.height), chip: chip.height};
        }""")
        assert not dimensions["overflow"], f"page overflows at {width}px"
        assert dimensions["board"] < 1, f"board is not square at {width}px"
        assert dimensions["chip"] < 35, f"model selector wraps at {width}px"
    print("PASS responsive board and navigation at 320–1280px")


async def run(args):
    base = args.url.rstrip("/") + "/"
    origin = urlsplit(base).netloc
    errors = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel=args.channel, headless=True)
        try:
            context = await browser.new_context(viewport={"width": 1280, "height": 1000}, reduced_motion="reduce")

            async def guard(route):
                url = urlsplit(route.request.url)
                if url.netloc != origin or url.path.endswith((".kevala", ".wasm")):
                    errors.append(f"Unexpected external/model request: {route.request.url}")
                    await route.abort()
                else:
                    await route.continue_()

            await context.route("**/*", guard)
            page = await context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("response", lambda response: errors.append(f"HTTP {response.status}: {response.url}") if response.status >= 400 else None)
            await page.goto(base + "#/")
            await page.locator('.view-home .demo-card[href="#/chess"]').click()
            await expect(page.locator(".view-chess")).to_be_visible()
            for check in [local_play, special_moves, tetris_navigation, model_play, responsive_layout]:
                await check(page)
            assert not errors, "\n".join(errors)
            print("Chess browser smoke passed (stub classifier; no weights downloaded).")
        finally:
            await browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://127.0.0.1:8080", help="base URL of the running site, without a hash/query")
    parser.add_argument("--channel", help="installed browser channel, e.g. chrome; defaults to Playwright Chromium")
    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
