// Adapted from static/viewer.html. Talks only to the extension's loopback proxy.
(() => {
  const vscode = acquireVsCodeApi();
  const el = id => document.getElementById(id);
  const img = el('img'), msg = el('msg'), dot = el('dot');
  let base = document.body.dataset.base;
  let paused = false, visible = true, abort = null, gen = 0, frames = 0, lastUrl = null, retry = null;
  let winFrames = [], winBytes = 0;

  const show = t => { msg.textContent = t; msg.hidden = !t; };

  function stats(bytes) {
    const now = performance.now();
    winFrames.push([now, bytes]); winBytes += bytes;
    while (winFrames.length && now - winFrames[0][0] > 2000) winBytes -= winFrames.shift()[1];
    el('fps').textContent = (winFrames.length / 2).toFixed(1);
    el('frames').textContent = ++frames;
    if (frames % 10 === 0) el('mbps').textContent = (winBytes * 8 / 2 / 1e6).toFixed(1);
  }

  function present(buf) {
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    img.onload = () => { if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = url; el('res').textContent = img.naturalWidth + '×' + img.naturalHeight; };
    img.src = url;
  }

  // Parse the multipart/x-mixed-replace stream ourselves so we can count frames and bytes.
  async function run() {
    const my = ++gen;
    clearTimeout(retry);
    // A second concurrent stream would feed stats() too and double the fps readout.
    if (abort) abort.abort();
    abort = new AbortController();
    try {
      const res = await fetch(base + '/stream.mjpeg', { signal: abort.signal, cache: 'no-store' });
      if (res.status === 401) { show('Unauthorized: the stored token was rejected.\nRe-pair the Deck from the Devices view (… → Re-pair) or run "Decky: Enter token manually".'); return; }
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
      show(''); dot.classList.add('live');
      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      const dec = new TextDecoder();
      const concat = (a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; };
      const indexOf = (hay, needle, from) => { outer: for (let i = from; i <= hay.length - needle.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return i; } return -1; };
      const CRLF2 = [13, 10, 13, 10];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = concat(buf, value);
        while (true) {
          const h = indexOf(buf, CRLF2, 0);
          if (h < 0) break;
          const head = dec.decode(buf.subarray(0, h));
          const m = /content-length:\s*(\d+)/i.exec(head);
          if (!m) { buf = buf.subarray(h + 4); continue; }
          const len = +m[1], start = h + 4;
          if (buf.length < start + len) break;
          const frame = buf.slice(start, start + len);
          buf = buf.subarray(start + len);
          stats(len);
          if (!paused) present(frame);
        }
      }
      show('Stream ended. Reconnecting…');
    } catch (e) {
      if (e.name !== 'AbortError') show('Disconnected: ' + e.message + '\nReconnecting…');
    }
    dot.classList.remove('live');
    if (my === gen && visible && !abort.signal.aborted) retry = setTimeout(run, 2000);
  }

  function stop() { gen++; clearTimeout(retry); if (abort) abort.abort(); dot.classList.remove('live'); }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'reconnect') { if (m.base) base = m.base; stop(); closeWs(); if (visible) run(); if (inp && inp.enabled) connectWs(); }
    // Hidden panels keep their context; stop pulling ~50 Mbit/s nobody is looking at.
    // onDidChangeViewState also fires on focus changes, so only act when visibility really flips.
    if (m.type === 'visible' && m.visible !== visible) { visible = m.visible; if (visible) { show('Connecting…'); run(); } else { stop(); releaseAll(); } }
    if (m.type === 'input') applyInput(m.state);
  });

  el('pause').onclick = () => { paused = !paused; el('pause').textContent = paused ? 'Resume' : 'Pause'; el('pause').classList.toggle('on', paused); };
  el('fit').onclick = () => { const actual = el('main').classList.toggle('actual'); el('fit').classList.toggle('on', !actual); el('fit').textContent = actual ? 'Actual' : 'Fit'; };
  el('snap').onclick = () => vscode.postMessage({ type: 'snapshot' });
  document.addEventListener('keydown', e => { if (capturing()) return; if (e.key === ' ') { e.preventDefault(); el('pause').click(); } });

  // Remote input, ported from static/viewer.html. The on/off flag is device-wide and owned by the
  // extension (postMessage 'setInput'); only the /input WebSocket goes from here to the proxy.
  const main = el('main');
  const LOCK_HINT = 'Pointer lock unavailable in this webview, use the browser viewer for Game mode';
  let inp = null, ws = null, wsRetry = null, mode = 'ui';
  let lockTimer = null, lockWorked = false;
  const heldKeys = new Set(), heldButtons = new Set();
  let pendingMove = null, relX = 0, relY = 0, moveFrame = 0, wheelAcc = 0;
  const wsOpen = () => ws && ws.readyState === WebSocket.OPEN;
  const send = m => { if (wsOpen()) ws.send(JSON.stringify(m)); };
  const locked = () => document.pointerLockElement === main;
  // Keys are only captured while the picture has focus (click it); toolbar clicks give them back.
  function capturing() { return !!(inp && inp.enabled && wsOpen() && (document.activeElement === main || locked())); }
  const note = t => { el('inp-note').textContent = t || ''; };
  const gameNote = 'Click the picture to lock the pointer; Esc releases it.';

  function releaseAll() {
    for (const k of heldKeys) send({ type: 'key', key: k, down: false });
    for (const b of heldButtons) send({ type: 'mouse_button', button: b, down: false });
    heldKeys.clear(); heldButtons.clear();
    if (padSent) { send({ type: 'gamepad', ...NEUTRAL_PAD }); padSent = null; }
    send({ type: 'release_all' });
  }

  function applyInput(st) {
    inp = st;
    el('input-ctl').hidden = !st;
    if (!st) { closeWs(); return; }
    const b = el('inp');
    b.classList.toggle('on', st.enabled);
    b.textContent = st.enabled ? 'Input on' : 'Input';
    b.disabled = !st.supported || (!st.available && !st.enabled);
    b.title = !st.supported ? 'Remote input is ' + st.reason
      : !st.available && !st.enabled ? (st.reason || 'Input unavailable')
      : st.enabled ? 'Remote input is on (' + st.backend + '). Click to turn it off for every client.'
      : 'Turn on remote keyboard, mouse and gamepad input (device-wide)';
    el('mode').hidden = !st.enabled;
    if (st.enabled) connectWs(); else { closeWs(); note(''); }
    updateCapture();
  }
  el('inp').onclick = () => {
    if (!inp) return;
    if (inp.enabled) releaseAll();
    el('inp').disabled = true;
    vscode.postMessage({ type: 'setInput', enabled: !inp.enabled });
  };

  function connectWs() {
    if (ws) return;
    clearTimeout(wsRetry);
    const sock = ws = new WebSocket(base.replace(/^http/, 'ws') + '/input');
    sock.onopen = () => { note(mode === 'game' ? gameNote : ''); updateCapture(); };
    sock.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'error') { note(m.message); console.warn('input:', m.message); }
    };
    sock.onclose = ev => {
      if (ws !== sock) return;
      ws = null; heldKeys.clear(); heldButtons.clear(); padSent = null;
      if (locked()) document.exitPointerLock();
      updateCapture();
      // 4003: input was turned off or pairing is open; the extension's next state update says which.
      if (ev.code === 4003) { note(ev.reason || 'Input refused'); vscode.postMessage({ type: 'refreshInput' }); return; }
      if (inp && inp.enabled) wsRetry = setTimeout(connectWs, 1500);
    };
  }
  function closeWs() {
    clearTimeout(wsRetry);
    if (ws) { releaseAll(); const s = ws; ws = null; s.close(); }
    if (locked()) document.exitPointerLock();
    updateCapture();
  }

  function updateCapture() { main.classList.toggle('capturing', capturing()); }
  main.addEventListener('focus', updateCapture);
  main.addEventListener('blur', () => { if (!locked()) releaseAll(); updateCapture(); });
  window.addEventListener('blur', () => { releaseAll(); updateCapture(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  for (const [id, m] of [['mode-ui', 'ui'], ['mode-game', 'game']]) el(id).onclick = () => {
    mode = m; el('mode-ui').classList.toggle('on', m === 'ui'); el('mode-game').classList.toggle('on', m === 'game');
    if (m === 'ui' && locked()) document.exitPointerLock();
    note(m === 'game' ? gameNote : '');
  };

  // VS Code may run webviews without pointer-lock permission; the request then rejects, fires
  // pointerlockerror or does nothing at all, so a timeout covers the silent case.
  function lockFailed() {
    clearTimeout(lockTimer); lockTimer = null;
    if (!locked()) note(lockWorked ? 'Pointer lock refused; click the picture again.' : LOCK_HINT);
  }
  function requestLock() {
    if (lockTimer) return;
    lockTimer = setTimeout(lockFailed, 1500);
    const attempt = opts => { try { return main.requestPointerLock(opts); } catch (e) { return Promise.reject(e); } };
    const p = attempt({ unadjustedMovement: true });
    // Rejects with NotSupportedError where unadjustedMovement is unknown; retry without it.
    if (p && p.then) p.catch(() => { if (locked()) return; const q = attempt(); if (q && q.then) q.catch(lockFailed); });
  }

  // Map a client point onto the picture, allowing for object-fit: contain letterboxing.
  function norm(e) {
    const r = img.getBoundingClientRect(), nw = img.naturalWidth || 1920, nh = img.naturalHeight || 1080;
    const scale = Math.min(r.width / nw, r.height / nh);
    const offX = (r.width - nw * scale) / 2, offY = (r.height - nh * scale) / 2;
    const clamp = v => Math.min(1, Math.max(0, v));
    return [clamp((e.clientX - r.left - offX) / (nw * scale)), clamp((e.clientY - r.top - offY) / (nh * scale))];
  }
  function flushMove() {
    moveFrame = 0;
    if (pendingMove) { send({ type: 'mouse_move', x: +pendingMove[0].toFixed(5), y: +pendingMove[1].toFixed(5) }); pendingMove = null; }
    if (relX || relY) { send({ type: 'mouse_move', dx: relX, dy: relY }); relX = relY = 0; }
  }
  const scheduleMove = () => { if (!moveFrame) moveFrame = requestAnimationFrame(flushMove); };
  const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];
  const press = b => { heldButtons.add(b); send({ type: 'mouse_button', button: b, down: true }); };

  img.addEventListener('mousemove', e => {
    if (mode !== 'ui' || !capturing()) return;
    pendingMove = norm(e); scheduleMove();
  });
  document.addEventListener('mousemove', e => {
    if (!locked()) return;
    relX += e.movementX; relY += e.movementY; scheduleMove();
  });
  img.addEventListener('mousedown', e => {
    if (!inp || !inp.enabled || !wsOpen()) return;
    e.preventDefault();
    main.focus();
    if (mode === 'game') {
      if (!locked()) { requestLock(); return; }
    } else {
      pendingMove = norm(e); flushMove();
    }
    const b = BUTTONS[e.button]; if (b) press(b);
  });
  main.addEventListener('mousedown', e => { if (locked() && e.target !== img) { const b = BUTTONS[e.button]; if (b) press(b); } });
  window.addEventListener('mouseup', e => {
    const b = BUTTONS[e.button];
    if (b && heldButtons.delete(b)) { flushMove(); send({ type: 'mouse_button', button: b, down: false }); }
  });
  img.addEventListener('contextmenu', e => { if (inp && inp.enabled) e.preventDefault(); });
  img.addEventListener('dragstart', e => { if (inp && inp.enabled) e.preventDefault(); });
  main.addEventListener('wheel', e => {
    if (!capturing()) return;
    e.preventDefault();
    wheelAcc += e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY : e.deltaY / 100;
    const n = Math.trunc(wheelAcc);
    if (n) { wheelAcc -= n; send({ type: 'wheel', dx: 0, dy: Math.max(-20, Math.min(20, n)) }); }
  }, { passive: false });
  document.addEventListener('pointerlockchange', () => {
    if (locked()) { lockWorked = true; clearTimeout(lockTimer); lockTimer = null; note('Pointer locked; Esc releases it.'); }
    else { releaseAll(); if (mode === 'game' && !lockTimer) note(gameNote); }
    updateCapture();
  });
  // The promise-less form only reports failure through this event; let a pending retry finish first.
  document.addEventListener('pointerlockerror', () => setTimeout(() => { if (lockTimer && !locked()) lockFailed(); }, 300));

  // Capture phase plus stopImmediatePropagation keeps captured keys from VS Code's keybindings,
  // which the webview host picks up from a bubbling listener on window.
  document.addEventListener('keydown', e => {
    if (!capturing()) return;
    // The browser itself uses Escape to leave pointer lock.
    if (locked() && e.code === 'Escape') return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat || !e.code || heldKeys.has(e.code)) return;
    heldKeys.add(e.code); send({ type: 'key', key: e.code, down: true });
  }, true);
  document.addEventListener('keyup', e => {
    if (!heldKeys.has(e.code)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    heldKeys.delete(e.code); send({ type: 'key', key: e.code, down: false });
  }, true);

  // Gamepad API, standard mapping: 0-3 A/B/X/Y, 4/5 bumpers, 6/7 triggers, 8/9 back/start,
  // 10/11 stick clicks, 12-15 d-pad, 16 guide.
  const NEUTRAL_PAD = { buttons: { a: false, b: false, x: false, y: false, lb: false, rb: false, back: false, start: false, ls: false, rs: false, guide: false }, axes: { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 }, hat: [0, 0] };
  const PAD_NAMES = ['a', 'b', 'x', 'y', 'lb', 'rb', null, null, 'back', 'start', 'ls', 'rs'];
  let padTimer = null, padSent = null, padSentAt = 0;
  function readPad() {
    const pad = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(p => p && p.connected && p.mapping === 'standard');
    if (!pad) return null;
    const b = i => !!(pad.buttons[i] && pad.buttons[i].pressed), v = i => pad.buttons[i] ? +pad.buttons[i].value.toFixed(3) : 0;
    const dz = x => Math.abs(x) < 0.06 ? 0 : +x.toFixed(3);
    const buttons = {}; PAD_NAMES.forEach((n, i) => { if (n) buttons[n] = b(i); }); buttons.guide = b(16);
    return { buttons, axes: { lx: dz(pad.axes[0] || 0), ly: dz(pad.axes[1] || 0), rx: dz(pad.axes[2] || 0), ry: dz(pad.axes[3] || 0), lt: v(6), rt: v(7) },
             hat: [(b(15) ? 1 : 0) - (b(14) ? 1 : 0), (b(13) ? 1 : 0) - (b(12) ? 1 : 0)] };
  }
  function pollPad() {
    let st = null;
    // getGamepads throws where the frame's permissions policy blocks the API.
    try { st = readPad(); } catch (e) { /* no gamepad */ }
    el('pad-ind').hidden = !st;
    if (!st) { clearInterval(padTimer); padTimer = null; return; }
    if (!inp || !inp.enabled || !wsOpen() || !document.hasFocus()) {
      if (padSent) { send({ type: 'gamepad', ...NEUTRAL_PAD }); padSent = null; }
      return;
    }
    const json = JSON.stringify(st), now = performance.now();
    // Resend now and then so the server does not retire the pad while a stick is held still.
    if (json !== padSent || now - padSentAt > 10000) { send({ type: 'gamepad', ...st }); padSent = json; padSentAt = now; }
  }
  const startPad = () => { if (!padTimer) padTimer = setInterval(pollPad, 16); pollPad(); };
  window.addEventListener('gamepadconnected', startPad);
  window.addEventListener('gamepaddisconnected', () => { if (padSent) { send({ type: 'gamepad', ...NEUTRAL_PAD }); padSent = null; } pollPad(); });

  vscode.postMessage({ type: 'ready' });
  run();
})();
