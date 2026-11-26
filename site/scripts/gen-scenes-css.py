#!/usr/bin/env python3
"""Writes src/scenes.css: the capability scenes on the features page.

Every scene is a 12-second CSS loop. The generated part is a library of "appear at N%"
keyframes (`.in-N`) and three windows (`.win-1/2/3`, `.sel-1/2/3`) shared by all scenes;
the bespoke part at the bottom is written by hand and copied through verbatim. Re-run after
editing this file: `python3 scripts/gen-scenes-css.py`.
"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src" / "scenes.css"
DUR = "12s"

lib = []
for n in range(4, 90, 2):
    lib.append(
        f"@keyframes in{n} {{ 0%, {n}% {{ opacity: 0; transform: translateY(6px); }} "
        f"{n + 3}%, 96% {{ opacity: 1; transform: none; }} 97%, 100% {{ opacity: 0; transform: translateY(6px); }} }}"
    )
    lib.append(f".in-{n} {{ opacity: 0; animation: in{n} {DUR} infinite; }}")

windows = {
    1: "0%, 30% { opacity: 1; } 33%, 96% { opacity: 0; } 97%, 100% { opacity: 1; }",
    2: "0%, 30% { opacity: 0; } 33%, 63% { opacity: 1; } 66%, 100% { opacity: 0; }",
    3: "0%, 63% { opacity: 0; } 66%, 96% { opacity: 1; } 97%, 100% { opacity: 0; }",
}
sel = {
    1: "0%, 30% { background: var(--fg); color: var(--bg); } 33%, 96% { background: transparent; color: var(--muted); } 97%, 100% { background: var(--fg); color: var(--bg); }",
    2: "0%, 30% { background: transparent; color: var(--muted); } 33%, 63% { background: var(--fg); color: var(--bg); } 66%, 100% { background: transparent; color: var(--muted); }",
    3: "0%, 63% { background: transparent; color: var(--muted); } 66%, 96% { background: var(--fg); color: var(--bg); } 97%, 100% { background: transparent; color: var(--muted); }",
}
for i in (1, 2, 3):
    lib.append(f"@keyframes win{i} {{ {windows[i]} }}")
    lib.append(f".win-{i} {{ opacity: {1 if i == 1 else 0}; animation: win{i} {DUR} infinite; }}")
    lib.append(f"@keyframes sel{i} {{ {sel[i]} }}")
    lib.append(f".sel-{i} {{ animation: sel{i} {DUR} infinite; }}")

BESPOKE = r"""
/* ---------- shared parts ---------- */

.fs {
  border: var(--border) solid var(--line-strong);
  background: var(--raised);
  overflow: hidden;
  min-width: 0;
}

.fs__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fs__stage {
  position: relative;
  height: 250px;
  padding: 14px;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12px;
  line-height: 1.4;
  overflow: hidden;
}

.fs__stage--tall { height: 350px; }

.m-label {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}

.m-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.m-field__l { font-size: 11px; font-weight: 600; }
.m-field__l .req { color: var(--accent); }

.m-input {
  height: 28px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  border: 1px solid var(--muted);
  background: var(--raised);
  color: var(--fg);
  white-space: nowrap;
  overflow: hidden;
}

.m-input--empty { color: var(--muted); }

.m-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 12px;
  background: var(--fg);
  color: var(--bg);
  font-weight: 700;
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
}

.m-btn--ghost { background: transparent; color: var(--fg); border: 1px solid var(--line-strong); }

.m-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border: 1px solid var(--line-strong);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.m-tag--ok { border-color: var(--ok); color: var(--ok); }
.m-tag--accent { border-color: var(--accent); color: var(--accent); }
.m-tag--muted { border-color: var(--muted); color: var(--muted); }

.m-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.m-cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.m-col { border: 1px solid var(--line); padding: 8px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }

.m-code {
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.5;
  padding: 8px 10px;
  background: var(--sunken);
  border: 1px solid var(--line);
  color: var(--fg);
  white-space: pre;
  overflow: hidden;
}

.m-code .k { color: var(--accent); }
.m-code .c { color: var(--muted); }

.m-list { display: flex; flex-direction: column; gap: 5px; }
.m-item { display: flex; align-items: center; gap: 8px; }

.m-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 14px;
  height: 14px;
  border: 1px solid var(--muted);
  color: var(--ok);
}

.m-check svg { display: block; }

.m-paper {
  background: #f4f1ea;
  color: #1a1a1a;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.m-paper__title { font-family: var(--display); font-size: 16px; line-height: 1; text-transform: uppercase; letter-spacing: 0.03em; }
.m-paper__row { display: grid; grid-template-columns: 70px 1fr; gap: 6px; align-items: center; font-size: 10px; color: #3d3a34; }
.m-paper__box { height: 14px; border: 1px dashed #b8b3a8; }
.m-paper__sig { margin-top: auto; padding: 4px 6px; border: 1px dashed #b8b3a8; font-family: var(--mono); font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b675f; }

.m-bar { height: 4px; background: var(--line); overflow: hidden; }
.m-bar__fill { height: 100%; width: 0; background: var(--accent); }

.m-switch { position: relative; width: 24px; height: 13px; background: var(--muted); flex: none; }
.m-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 9px; height: 9px; background: var(--bg); }

.m-stack { position: relative; display: grid; }
.m-stack > * { grid-area: 1 / 1; }

.m-ring { position: absolute; inset: -1px; border: 2px solid var(--accent); animation: ring 1s ease-out infinite; }

.m-key {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line-strong);
  color: var(--accent);
}

.m-key svg { display: block; position: relative; }

/* ---------- builder ---------- */

.sc-builder { display: grid; grid-template-columns: 1fr 110px; gap: 10px; }
.sc-builder__sheet { border: 1px solid var(--line); background: var(--raised); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.sc-builder__props { display: flex; flex-direction: column; gap: 8px; font-size: 11px; }
.sc-builder__switch { animation: builderSwitch 12s infinite; }
.sc-builder__save { animation: press56 12s infinite; }

@keyframes builderSwitch { 0%, 35% { background: var(--muted); } 36%, 96% { background: var(--accent); } 97%, 100% { background: var(--muted); } }
@keyframes press56 { 0%, 55.5% { transform: scale(1); } 56% { transform: scale(0.94); } 56.5%, 100% { transform: scale(1); } }

/* ---------- rules ---------- */

.sc-rules__card { animation: rulesHl 12s infinite; }
.sc-rules__tick { opacity: 0; animation: rulesTick 12s infinite; }
.sc-rules__field { opacity: 0; animation: rulesField 12s infinite; }
.sc-rules__hint { animation: rulesHint 12s infinite; }

@keyframes rulesHl { 0%, 19% { border-color: var(--line); } 20%, 30% { border-color: var(--accent); } 32%, 63% { border-color: var(--line); } 64%, 74% { border-color: var(--accent); } 76%, 100% { border-color: var(--line); } }
@keyframes rulesTick { 0%, 21% { opacity: 0; } 22%, 65% { opacity: 1; } 66%, 100% { opacity: 0; } }
@keyframes rulesField { 0%, 25% { opacity: 0; transform: translateY(-8px); } 28%, 68% { opacity: 1; transform: none; } 71%, 100% { opacity: 0; transform: translateY(-8px); } }
@keyframes rulesHint { 0%, 24% { opacity: 1; } 26%, 70% { opacity: 0; } 72%, 100% { opacity: 1; } }

/* ---------- tests ---------- */

.sc-tests__card { white-space: normal; }
.sc-tests__line { display: block; white-space: pre; }
.sc-tests__dot { flex: none; width: 8px; height: 8px; background: var(--muted); animation: testsPass 12s infinite; }
.sc-tests__dot--first { animation-name: testsFail; }
.sc-tests__passed { justify-self: start; align-self: start; max-width: 100%; animation: testsPassed 12s infinite; }
.sc-tests__fail { display: flex; flex-direction: column; gap: 2px; padding: 6px 10px; border: 1px solid var(--accent); background: var(--raised); }
.sc-tests__where { font-family: var(--mono); font-size: 10.5px; font-weight: 700; }
.sc-tests__why { color: var(--muted); font-size: 11px; }

@keyframes testsPass { 0%, 39% { background: var(--muted); } 40%, 96% { background: var(--ok); } 97%, 100% { background: var(--muted); } }
@keyframes testsFail { 0%, 39% { background: var(--muted); } 40%, 55% { background: var(--ok); } 56%, 96% { background: var(--accent); } 97%, 100% { background: var(--muted); } }
@keyframes testsPassed { 0%, 55% { opacity: 1; } 56%, 96% { opacity: 0; } 97%, 100% { opacity: 1; } }

/* ---------- browser assistants ---------- */

.sc-ai__bar { min-width: 0; }
.sc-ai__run, .sc-ai__done { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 5px 10px; border: 1px solid var(--accent); background: var(--raised); min-width: 0; }
.sc-ai__run { opacity: 0; animation: aiRun 12s infinite; }
.sc-ai__done { border-color: var(--line-strong); }
.sc-ai__fields { gap: 6px; }
.sc-ai__w1, .sc-ai__w2, .sc-ai__w3 { border-color: var(--muted); }
.sc-ai__w1 { animation: aiWrite1 12s infinite; }
.sc-ai__w2 { animation: aiWrite2 12s infinite; }
.sc-ai__w3 { animation: aiWrite3 12s infinite; }

@keyframes aiRun { 0%, 4% { opacity: 0; transform: translateY(6px); } 7%, 50% { opacity: 1; transform: none; } 53%, 100% { opacity: 0; transform: none; } }
@keyframes aiWrite1 { 0%, 12% { border-color: var(--muted); box-shadow: none; } 13%, 19% { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); } 21%, 100% { border-color: var(--muted); box-shadow: none; } }
@keyframes aiWrite2 { 0%, 20% { border-color: var(--muted); box-shadow: none; } 21%, 27% { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); } 29%, 100% { border-color: var(--muted); box-shadow: none; } }
@keyframes aiWrite3 { 0%, 28% { border-color: var(--muted); box-shadow: none; } 29%, 35% { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); } 37%, 100% { border-color: var(--muted); box-shadow: none; } }

/* ---------- renderer ---------- */

.sc-renderer__submit { animation: press20 12s infinite; }
.sc-renderer__first { animation: rendererFocus 12s infinite; }
.sc-renderer__two { opacity: 0; animation: rendererTwo 12s infinite; }
.sc-renderer__one { opacity: 0; animation: rendererOne 12s infinite; }
.sc-renderer__typed { clip-path: inset(0 100% 0 0); animation: typeR 12s steps(12) infinite; }
.sc-renderer__summary { border: 1px solid var(--accent); padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.sc-renderer__summary .m-label { color: var(--accent); }

@keyframes press20 { 0%, 19.5% { transform: scale(1); } 20% { transform: scale(0.94); } 20.5%, 100% { transform: scale(1); } }
@keyframes rendererFocus { 0%, 27% { border-color: var(--muted); outline: 0 solid transparent; } 28%, 96% { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: 2px; } 97%, 100% { border-color: var(--muted); outline: 0 solid transparent; } }
@keyframes rendererTwo { 0%, 23% { opacity: 0; } 24%, 59% { opacity: 1; } 60%, 100% { opacity: 0; } }
@keyframes rendererOne { 0%, 59% { opacity: 0; } 60%, 96% { opacity: 1; } 97%, 100% { opacity: 0; } }
@keyframes typeR { 0%, 44% { clip-path: inset(0 100% 0 0); } 56%, 96% { clip-path: inset(0 0 0 0); } 97%, 100% { clip-path: inset(0 100% 0 0); } }

/* ---------- sandbox ---------- */

.sc-sandbox__a { animation: barA 12s infinite; }
.sc-sandbox__b { animation: barB 12s infinite; }
.sc-sandbox__c { animation: barC 12s infinite; }
.sc-sandbox__hash { font-family: var(--mono); font-size: 9.5px; color: var(--muted); word-break: break-all; }

@keyframes barA { 0%, 8% { width: 0; } 24%, 96% { width: 100%; } 97%, 100% { width: 0; } }
@keyframes barB { 0%, 12% { width: 0; } 28%, 96% { width: 100%; } 97%, 100% { width: 0; } }
@keyframes barC { 0%, 16% { width: 0; } 32%, 96% { width: 100%; } 97%, 100% { width: 0; } }

/* ---------- customization ----------
   Three looks on a 12 s loop: the site's own (0-30%), a dark theme (33-63%), Bootstrap
   (66-96%). Every part of the miniature form restyles, so the switch shows what a theme owns:
   surface, radius, type, labels, inputs, checkbox and buttons. */

.sc-cz__seg { display: flex; border: 1px solid var(--muted); }
.sc-cz__seg span { padding: 3px 8px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }

.sc-cz__form { display: flex; flex-direction: column; gap: 9px; padding: 12px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); animation: czForm 12s infinite; }
.sc-cz__title { font-family: var(--display); font-size: 18px; line-height: 1; text-transform: uppercase; letter-spacing: 0.03em; animation: czTitle 12s infinite; }
.sc-cz__label { font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); animation: czLabel 12s infinite; }
.sc-cz__label--inline { font-size: 11px; }
.sc-cz__input { height: 28px; padding: 0 8px; display: flex; align-items: center; border: 1px solid var(--muted); background: var(--raised); color: var(--fg); font-size: 12px; animation: czInput 12s infinite; }
.sc-cz__help { font-family: var(--mono); font-size: 9.5px; color: var(--muted); animation: czHelp 12s infinite; }
.sc-cz__check { display: flex; align-items: center; gap: 8px; }
.sc-cz__cb { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 14px; height: 14px; border: 1px solid var(--muted); color: var(--accent); animation: czCb 12s infinite; }
.sc-cz__cb svg { display: block; }
.sc-cz__btn { display: inline-flex; align-items: center; height: 28px; padding: 0 12px; background: var(--fg); color: var(--bg); border: 1px solid var(--fg); font-weight: 700; font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; animation: czBtn 12s infinite; }
.sc-cz__btn--ghost { background: transparent; color: var(--fg); border-color: var(--line-strong); animation: czBtnGhost 12s infinite; }

@keyframes czForm {
  0%, 30% { background: var(--bg); border-color: var(--line); border-radius: 0; color: var(--fg); }
  33%, 63% { background: #141b29; border-color: #34466a; border-radius: 6px; color: #e3e9f2; }
  66%, 96% { background: #ffffff; border-color: #dee2e6; border-radius: 8px; color: #212529; }
  97%, 100% { background: var(--bg); border-color: var(--line); border-radius: 0; color: var(--fg); }
}
@keyframes czTitle {
  0%, 30% { font-family: var(--display); font-size: 18px; font-weight: 400; letter-spacing: 0.03em; text-transform: uppercase; color: var(--fg); }
  33%, 63% { font-family: var(--body); font-size: 15px; font-weight: 700; letter-spacing: 0; text-transform: none; color: #e3e9f2; }
  66%, 96% { font-family: system-ui, sans-serif; font-size: 17px; font-weight: 500; letter-spacing: 0; text-transform: none; color: #212529; }
  97%, 100% { font-family: var(--display); font-size: 18px; font-weight: 400; letter-spacing: 0.03em; text-transform: uppercase; color: var(--fg); }
}
@keyframes czLabel {
  0%, 30% { font-family: var(--mono); letter-spacing: 0.12em; text-transform: uppercase; font-weight: 400; color: var(--muted); }
  33%, 63% { font-family: var(--body); letter-spacing: 0; text-transform: none; font-weight: 600; color: #b8c4d6; }
  66%, 96% { font-family: system-ui, sans-serif; letter-spacing: 0; text-transform: none; font-weight: 400; color: #212529; }
  97%, 100% { font-family: var(--mono); letter-spacing: 0.12em; text-transform: uppercase; font-weight: 400; color: var(--muted); }
}
@keyframes czInput {
  0%, 30% { border-radius: 0; border-color: var(--muted); background: var(--raised); color: var(--fg); }
  33%, 63% { border-radius: 4px; border-color: #34466a; background: #0b1220; color: #e3e9f2; }
  66%, 96% { border-radius: 6px; border-color: #ced4da; background: #ffffff; color: #212529; }
  97%, 100% { border-radius: 0; border-color: var(--muted); background: var(--raised); color: var(--fg); }
}
@keyframes czHelp {
  0%, 30% { font-family: var(--mono); color: var(--muted); }
  33%, 63% { font-family: var(--body); color: #8fa3c1; }
  66%, 96% { font-family: system-ui, sans-serif; color: #6c757d; }
  97%, 100% { font-family: var(--mono); color: var(--muted); }
}
@keyframes czCb {
  0%, 30% { border-radius: 0; border-color: var(--muted); background: transparent; color: var(--accent); }
  33%, 63% { border-radius: 3px; border-color: #58a6ff; background: #58a6ff; color: #0b1220; }
  66%, 96% { border-radius: 4px; border-color: #0d6efd; background: #0d6efd; color: #ffffff; }
  97%, 100% { border-radius: 0; border-color: var(--muted); background: transparent; color: var(--accent); }
}
@keyframes czBtn {
  0%, 30% { background: var(--fg); border-color: var(--fg); color: var(--bg); border-radius: 0; text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--body); }
  33%, 63% { background: #58a6ff; border-color: #58a6ff; color: #0b1220; border-radius: 4px; text-transform: none; letter-spacing: 0; font-family: var(--body); }
  66%, 96% { background: #0d6efd; border-color: #0d6efd; color: #ffffff; border-radius: 6px; text-transform: none; letter-spacing: 0; font-family: system-ui, sans-serif; }
  97%, 100% { background: var(--fg); border-color: var(--fg); color: var(--bg); border-radius: 0; text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--body); }
}
@keyframes czBtnGhost {
  0%, 30% { background: transparent; border-color: var(--line-strong); color: var(--fg); border-radius: 0; text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--body); }
  33%, 63% { background: transparent; border-color: #58a6ff; color: #58a6ff; border-radius: 4px; text-transform: none; letter-spacing: 0; font-family: var(--body); }
  66%, 96% { background: transparent; border-color: #6c757d; color: #6c757d; border-radius: 6px; text-transform: none; letter-spacing: 0; font-family: system-ui, sans-serif; }
  97%, 100% { background: transparent; border-color: var(--line-strong); color: var(--fg); border-radius: 0; text-transform: uppercase; letter-spacing: 0.06em; font-family: var(--body); }
}

/* ---------- chrome ----------
   One header and footer, three forms cycling through them on the 12 s windows. The chrome
   never changes; the form inside does, and the second form adds a part of its own. The
   background follows the windows too: seamless in the page, an outlined panel, a paper sheet. */

.sc-ch__seg { display: flex; border: 1px solid var(--muted); }
.sc-ch__seg span { padding: 3px 8px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }

.sc-ch__page { display: flex; flex-direction: column; flex: 1; min-height: 0; border: 1px solid transparent; background: transparent; animation: chFrame 12s infinite; }

@keyframes chFrame {
  0%, 30% { border-color: transparent; background: transparent; box-shadow: none; margin: 0; }
  33%, 63% { border-color: var(--line-strong); background: transparent; box-shadow: none; margin: 0; }
  66%, 96% { border-color: var(--line); background: var(--raised); box-shadow: 0 10px 24px rgba(0, 0, 0, 0.5); margin: 4px 10px 8px; }
  97%, 100% { border-color: transparent; background: transparent; box-shadow: none; margin: 0; }
}
.sc-ch__header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 2px solid var(--accent); }
.sc-ch__logo { width: 14px; height: 14px; background: var(--accent); flex: none; }
.sc-ch__org { flex: 1; min-width: 0; font-weight: 700; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-ch__lang { display: flex; flex: none; border: 1px solid var(--muted); font-family: var(--mono); font-size: 9px; letter-spacing: 0.08em; }
.sc-ch__lang span { padding: 2px 6px; color: var(--muted); }
.sc-ch__lang .sc-ch__on { background: var(--fg); color: var(--bg); }
.sc-ch__body { flex: 1; padding: 10px; }
.sc-ch__form { display: flex; flex-direction: column; gap: 7px; }
.sc-ch__notice { padding: 5px 8px; border-left: 2px solid var(--accent); font-size: 11px; color: var(--muted); }
.sc-ch__footer { display: flex; justify-content: space-between; gap: 8px; padding: 6px 10px; border-top: 1px solid var(--line); font-family: var(--mono); font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.sc-ch__footer span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* ---------- embed ---------- */

.sc-embed__l1 { clip-path: inset(0 100% 0 0); animation: embedL1 12s steps(30) infinite; }
.sc-embed__l2 { clip-path: inset(0 100% 0 0); animation: embedL2 12s steps(30) infinite; }
.sc-embed__l3 { clip-path: inset(0 100% 0 0); animation: embedL3 12s steps(30) infinite; }
.sc-embed__form { border: 1px solid var(--line); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }

@keyframes embedL1 { 0%, 4% { clip-path: inset(0 100% 0 0); } 16%, 96% { clip-path: inset(0 0 0 0); } 97%, 100% { clip-path: inset(0 100% 0 0); } }
@keyframes embedL2 { 0%, 18% { clip-path: inset(0 100% 0 0); } 30%, 96% { clip-path: inset(0 0 0 0); } 97%, 100% { clip-path: inset(0 100% 0 0); } }
@keyframes embedL3 { 0%, 32% { clip-path: inset(0 100% 0 0); } 44%, 96% { clip-path: inset(0 0 0 0); } 97%, 100% { clip-path: inset(0 100% 0 0); } }

/* ---------- pdf ---------- */

.sc-pdf { display: grid; grid-template-columns: 1fr 140px; gap: 10px; height: 100%; }
.sc-pdf__side { display: flex; flex-direction: column; gap: 8px; min-width: 0; }

/* ---------- signatures ---------- */

.sc-sig__lane { display: grid; grid-template-columns: 82px 28px 1fr; gap: 8px; align-items: center; }
.sc-sig__ring1 { opacity: 0; animation: sigRing1 12s infinite; }
.sc-sig__ring2 { opacity: 0; animation: sigRing2 12s infinite; }
.sc-sig__wait1 { opacity: 0; animation: sigRing1 12s infinite; }
.sc-sig__wait2 { opacity: 0; animation: sigRing2 12s infinite; }

@keyframes sigRing1 { 0%, 11% { opacity: 0; } 12%, 30% { opacity: 1; } 31%, 100% { opacity: 0; } }
@keyframes sigRing2 { 0%, 39% { opacity: 0; } 40%, 56% { opacity: 1; } 57%, 100% { opacity: 0; } }

/* ---------- data sources ---------- */

.sc-data__select { position: relative; }
.sc-data__panel { opacity: 0; border: 1px solid var(--line-strong); background: var(--raised); display: flex; flex-direction: column; animation: dataPanel 12s infinite; }
.sc-data__opt { padding: 5px 8px; border-bottom: 1px solid var(--line); }
.sc-data__opt:last-child { border-bottom: 0; }
.sc-data__pick { animation: dataPick 12s infinite; }
.sc-data__value { opacity: 0; animation: dataValue 12s infinite; }
.sc-data__placeholder { animation: dataPlaceholder 12s infinite; }
.sc-data__resolving { opacity: 0; animation: dataResolving 12s infinite; }

@keyframes dataPanel { 0%, 15% { opacity: 0; } 16%, 57% { opacity: 1; } 58%, 100% { opacity: 0; } }
@keyframes dataPick { 0%, 51% { background: transparent; color: var(--fg); } 52%, 57% { background: var(--accent); color: var(--accent-fg); } 58%, 100% { background: transparent; color: var(--fg); } }
@keyframes dataValue { 0%, 59% { opacity: 0; } 60%, 96% { opacity: 1; } 97%, 100% { opacity: 0; } }
@keyframes dataPlaceholder { 0%, 59% { opacity: 1; } 60%, 96% { opacity: 0; } 97%, 100% { opacity: 1; } }
@keyframes dataResolving { 0%, 17% { opacity: 0; } 18%, 27% { opacity: 1; } 28%, 100% { opacity: 0; } }

/* ---------- localization ---------- */

.sc-l10n__seg { display: flex; border: 1px solid var(--muted); align-self: flex-start; }
.sc-l10n__seg span { padding: 3px 8px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.sc-l10n__form { display: flex; flex-direction: column; gap: 8px; }

/* ---------- ops ---------- */


/* ---------- small extras the scenes share ---------- */

.m-row--between { justify-content: space-between; }
.m-strong { font-weight: 700; }
.m-ok { color: var(--ok); }
.m-tag svg { display: block; flex: none; }
.sc-builder__switch::after { animation: builderKnob 12s infinite; }
.sc-embed__l1, .sc-embed__l2, .sc-embed__l3 { display: inline-block; }
.sc-pdf { min-height: 0; }
.sc-data__pick { opacity: 0; animation: in36 12s infinite, dataPick 12s infinite; }
.sc-l10n__form .m-btn, .sc-embed__form .m-btn { align-self: flex-start; }

@keyframes builderKnob { 0%, 35% { left: 2px; } 36%, 96% { left: 13px; } 97%, 100% { left: 2px; } }

/* ---------- reduced motion: rest on the finished state ---------- */

@media (prefers-reduced-motion: reduce) {
  .fs *, .fs { animation: none !important; }
  .sc-cz__form, .sc-cz__title, .sc-cz__label, .sc-cz__input, .sc-cz__help, .sc-cz__cb, .sc-cz__btn { animation: none; }
  .fs [class^="in-"], .fs [class*=" in-"] { opacity: 1; transform: none; }
  .fs .win-2, .fs .win-3 { opacity: 0; }
  .sc-rules__tick, .sc-rules__field, .sc-renderer__one, .sc-data__value { opacity: 1; }
  .sc-renderer__typed, .sc-embed__l1, .sc-embed__l2, .sc-embed__l3 { clip-path: none; }
  .sc-data__panel, .sc-data__placeholder, .sc-rules__hint, .sc-renderer__two { opacity: 0; }
  .sc-sandbox__a, .sc-sandbox__b, .sc-sandbox__c { width: 100%; }
  .sc-builder__switch { background: var(--accent); }
  .sc-builder__switch::after { left: 13px; }
  .sc-data__pick { opacity: 1; }
  .sc-tests__dot { background: var(--ok); }
  .sc-tests__dot--first { background: var(--accent); }
  .sc-tests__passed { opacity: 0; }
  .sc-ai__run { opacity: 1; }
  .sc-ai__done { display: none; }
}
"""

OUT.write_text(
    "/* Generated by scripts/gen-scenes-css.py. The capability scenes on the features page:\n"
    "   a library of appear-at-N% keyframes (.in-N), three windows (.win-N, .sel-N), the shared\n"
    "   miniature parts (.m-*), and one bespoke block per scene (.sc-*). Edit the script, not this. */\n\n"
    + "\n".join(lib)
    + "\n"
    + BESPOKE
)
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
