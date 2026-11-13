"""Four independent browser clients. Requires Python + Playwright for development only.

Start the app, then: python tests/browser_smoke.py [http://127.0.0.1:3000] [--screenshots]
"""
import json
import sys
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
BASE = next((arg for arg in sys.argv[1:] if arg.startswith('http')), 'http://127.0.0.1:3000')
ROOM = 'demo-' + uuid.uuid4().hex[:8]
SHOTS = '--screenshots' in sys.argv


def shot(page, name):
    if SHOTS:
        directory = ROOT / 'docs/screenshots'
        directory.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(directory / name), full_page=True, animations='disabled')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    contexts = [browser.new_context(viewport={'width': 1440, 'height': 1050}) for _ in range(4)]
    pages = [context.new_page() for context in contexts]
    packets = [[] for _ in pages]
    errors = []
    def attach(page, output):
        page.on('pageerror', lambda error: errors.append(str(error)))
        def frame(payload):
            try:
                message = json.loads(payload)
                if message.get('state'):
                    output.append(message['state'])
            except (ValueError, TypeError):
                pass
        page.on('websocket', lambda socket: socket.on('framereceived', frame))
    names = ['Саша', 'Миша', 'Аня', 'Даша']
    for index, page in enumerate(pages):
        attach(page, packets[index])
        page.goto(f'{BASE}/?room={ROOM}')
        expect(page.locator('#statusChip')).to_have_text('Лобби')
        page.locator('#nameInput').fill(names[index])
        page.locator('#saveNameBtn').click()
        expect(page.locator('#players')).to_contain_text(names[index])
    host = pages[0]
    for name in ['Лисы', 'Совы']:
        host.locator('#teamName').fill(name)
        host.locator('#createTeamBtn').click()
        expect(host.locator('.teamName', has_text=name)).to_be_visible()
    for index, page in enumerate(pages):
        team = page.locator('.team').filter(has=page.locator('.teamName', has_text='Лисы' if index < 2 else 'Совы'))
        team.get_by_role('button', name='Присоединиться', exact=True).click()
        expect(team.locator('.pill', has_text=names[index])).to_be_visible()
    expect(host.locator('#startBtn')).to_be_enabled()
    shot(host, '01-lobby.png')
    host.locator('#startBtn').click()
    for page in pages:
        expect(page.locator('#statusChip')).to_have_text('Игра идёт')
    expect(host.locator('#roleLabel')).to_have_text('Вы объясняете')
    expect(host.locator('#correctBtn')).to_be_enabled()
    secret = host.locator('#word').inner_text()
    assert secret and secret != '•••••'
    for index in range(1, 4):
        expect(pages[index].locator('#word')).to_have_text('•••••')
        assert all('currentWord' not in state['game'] and 'wordId' not in state['game'] for state in packets[index])
    assert all('deck' not in state and 'words' not in state for output in packets for state in output)
    shot(host, '02-explainer.png')
    shot(pages[1], '03-listener.png')
    host.locator('#correctBtn').click()
    expect(host.locator('#scores')).to_contain_text('1 очк.')
    for page in pages:
        expect(page.locator('#scores')).to_contain_text('1 очк.')
    host.locator('#hostNotCountBtn').click()
    expect(host.locator('#hostNotCountBtn')).to_be_disabled()
    expect(host.locator('#scores .pts').first).to_have_text('0 очк.')
    host.locator('#hostCountBtn').click()
    expect(host.locator('#scores')).to_contain_text('1 очк.')
    host.locator('#pauseBtn').click()
    for page in pages:
        expect(page.locator('#statusChip')).to_have_text('Пауза')
    paused = host.locator('#timer').inner_text()
    # Browser-side polling verifies that paused time does not keep decreasing.
    host.wait_for_timeout(1100)
    assert host.locator('#timer').inner_text() == paused
    host.locator('#resumeBtn').click()
    expect(host.locator('#statusChip')).to_have_text('Игра идёт')
    host.locator('#endTurnBtn').click()
    expect(pages[2].locator('#roleLabel')).to_have_text('Вы объясняете')
    expect(host.locator('#word')).to_have_text('•••••')
    # Reload the active explainer: same identity/team, automatic pause, then resume.
    page = pages[2]
    previous_word = page.locator('#word').inner_text()
    page.reload()
    expect(page.locator('#statusChip')).to_have_text('Пауза')
    expect(page.locator('.team').filter(has=page.locator('.teamName', has_text='Совы')).locator('.pill', has_text='Аня')).to_be_visible()
    expect(host.locator('#playerCount')).to_have_text('4')
    host.locator('#resumeBtn').click()
    expect(page.locator('#statusChip')).to_have_text('Игра идёт')
    expect(page.locator('#word')).to_have_text(previous_word)
    pages[1].set_viewport_size({'width': 390, 'height': 844})
    assert pages[1].evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    shot(pages[1], '04-mobile.png')
    host.locator('#resetBtn').click()
    expect(host.locator('#statusChip')).to_have_text('Лобби')
    expect(pages[3].locator('#statusChip')).to_have_text('Лобби')
    pages[3].evaluate('socket.close()')
    expect(pages[3].locator('#statusChip')).to_have_text('Нет связи')
    expect(pages[3].locator('#statusChip')).to_have_text('Лобби')
    expect(pages[3].locator('.team').filter(has=pages[3].locator('.teamName', has_text='Совы')).get_by_role('button', name='Выйти', exact=True)).to_be_enabled()
    # User-provided markup is displayed as text in players, teams and score cards.
    pages[1].locator('#nameInput').fill('<img src=x onerror=alert(1)>')
    pages[1].locator('#saveNameBtn').click()
    expect(host.locator('#players')).to_contain_text('<img src=x onerror=alert(1)>')
    assert host.locator('#teams img').count() == 0
    host.locator('#teamName').fill('<b>Новая команда</b>')
    host.locator('#createTeamBtn').click()
    expect(host.locator('.teamName', has_text='<b>Новая команда</b>')).to_be_visible()
    assert host.locator('.teamName b').count() == 0
    assert not errors, errors
    for context in contexts:
        context.close()
    browser.close()
    print('Browser checks passed: four players, teams, private words in network packets, scoring, corrections, pause, turn switch, reload/rejoin, safe names and mobile layout.')
