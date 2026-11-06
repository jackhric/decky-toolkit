// The screen panel's picture, input and sound. Controls are editor title actions in the extension, which
// owns their state and posts it here; this page talks only to the extension's loopback proxy.
(() => {
  const vscode = acquireVsCodeApi();
  const el = id => document.getElementById(id);
  const img = el('img'), msg = el('msg'), hint = el('hint'), main = el('main');
  let base = document.body.dataset.base;
  let paused = false, visible = true, abort = null, gen = 0, lastUrl = null, retry = null;
  // False while the extension says the device is not connected: nothing is fetched, the last frame stays dimmed.
  let live = document.body.dataset.live !== 'false';

  const show = t => { msg.textContent = t; msg.hidden = !t; };
  // Short notes (gamepad connected, input refused) fade on their own; the audio hint stays until audio runs.
  let hintTimer = null, note = '';
  function flash(t, ms = 3000) { note = t; clearTimeout(hintTimer); hintTimer = setTimeout(() => { note = ''; renderHint(); }, ms); renderHint(); }
  function renderHint() {
    const t = note || (deviceAudio && !audioRunning() ? 'Click the picture to enable audio' : '');
    hint.textContent = t; hint.hidden = !t;
  }

  // A healthy stream never goes quiet (the device resends the last frame); silence means the device is
  // restarting its capture, e.g. after a game starts or quits. The connection stays open meanwhile.
  let stallTimer = null, stalled = false;
  function armStall() {
    clearTimeout(stallTimer);
    if (stalled) { stalled = false; show(''); }
    stallTimer = setTimeout(() => { stalled = true; show('No frames from the device. Stream restarting…'); }, 2500);
  }
  function disarmStall() { clearTimeout(stallTimer); stalled = false; }

  let applying = false, applyTimer = null;
  function doneApplying() { applying = false; clearTimeout(applyTimer); }

  function present(buf) {
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    img.onload = () => { if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = url; };
    img.src = url;
  }

  // Parse the multipart/x-mixed-replace stream ourselves so a stall is noticed per frame.
  async function run() {
    const my = ++gen;
    clearTimeout(retry);
    if (abort) abort.abort();
    abort = new AbortController();
    try {
      const res = await fetch(base + '/stream', { signal: abort.signal, cache: 'no-store' });
      if (res.status === 401) { show('Unauthorized: the stored token was rejected.\nRe-pair the device from the Devices view (… → Re-pair) or run "Decky: Enter token manually".'); vscode.postMessage({ type: 'lost' }); return; }
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 300));
      show(''); armStall();
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
          armStall();
          if (applying) { doneApplying(); show(''); }
          if (!paused) present(frame);
        }
      }
      disarmStall();
      if (my === gen) { show(applying ? 'Applying stream settings…' : 'Stream ended. Reconnecting…'); vscode.postMessage({ type: 'lost' }); }
    } catch (e) {
      disarmStall();
      if (e.name !== 'AbortError' && my === gen) { show(applying ? 'Applying stream settings…' : 'Disconnected: ' + e.message + '\nReconnecting…'); vscode.postMessage({ type: 'lost' }); }
    }
    if (my === gen && visible && live && !abort.signal.aborted) retry = setTimeout(run, 2000);
  }

  function stop() { gen++; clearTimeout(retry); disarmStall(); if (abort) abort.abort(); }

  function applyLink(m) {
    const was = live;
    live = !!m.live;
    main.classList.toggle('offline', !live);
    if (!live) { stop(); closeWs(); closeAudio(); doneApplying(); show(m.text); return; }
    if (was) return;
    show('Connecting…');
    if (visible) run();
    if (inp && inp.enabled) connectWs();
    connectAudio();
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'link') applyLink(m);
    if (m.type === 'reconnect' && live) { if (m.base) base = m.base; stop(); closeWs(); closeAudio(); if (visible) run(); if (inp && inp.enabled) connectWs(); connectAudio(); }
    // Hidden panels keep their context; stop pulling ~50 Mbit/s nobody is looking at.
    // onDidChangeViewState also fires on focus changes, so only act when visibility really flips.
    if (m.type === 'visible' && m.visible !== visible) { visible = m.visible; if (!live) return; if (visible) { show('Connecting…'); run(); connectAudio(); } else { stop(); releaseAll(); closeAudio(); } }
    if (m.type === 'input') applyInput(m.state);
    if (m.type === 'paused') paused = !!m.paused;
    if (m.type === 'applying') { applying = true; clearTimeout(applyTimer); applyTimer = setTimeout(doneApplying, 6000); }
    if (m.type === 'audio') applyAudio(m);
    if (m.type === 'padTarget') retarget(m.id || '');
  });

  // Remote input. The on/off flag is device-wide and owned by the extension; only the /input WebSocket
  // goes from here to the proxy.
  let inp = null, ws = null, wsRetry = null;
  const heldKeys = new Set(), heldButtons = new Set();
  let pendingMove = null, moveFrame = 0, wheelAcc = 0;
  const wsOpen = () => ws && ws.readyState === WebSocket.OPEN;
  const send = m => { if (wsOpen()) ws.send(JSON.stringify(m)); };
  // Keys are only captured while the picture has focus (click it); clicking elsewhere gives them back.
  function capturing() { return !!(inp && inp.enabled && wsOpen() && document.activeElement === main); }

  function releaseAll() {
    for (const k of heldKeys) send({ type: 'key', key: k, down: false });
    for (const b of heldButtons) send({ type: 'mouse_button', button: b, down: false });
    heldKeys.clear(); heldButtons.clear();
    if (padSent) { send(padMsg(NEUTRAL_PAD)); padSent = null; }
    send({ type: 'release_all' });
  }

  function applyInput(st) {
    inp = st;
    if (st && st.enabled) connectWs(); else closeWs();
    updateCapture();
  }

  function connectWs() {
    if (ws || !live) return;
    clearTimeout(wsRetry);
    const sock = ws = new WebSocket(base.replace(/^http/, 'ws') + '/input');
    sock.onopen = updateCapture;
    sock.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'error') { flash(m.message, 5000); console.warn('input:', m.message); }
    };
    sock.onclose = ev => {
      if (ws !== sock) return;
      ws = null; heldKeys.clear(); heldButtons.clear(); padSent = null;
      updateCapture();
      // 4003: input was turned off or pairing is open; the extension's next state update says which.
      if (ev.code === 4003) { flash(ev.reason || 'Input refused', 5000); vscode.postMessage({ type: 'refreshInput' }); return; }
      if (inp && inp.enabled && live) wsRetry = setTimeout(connectWs, 1500);
    };
  }
  function closeWs() {
    clearTimeout(wsRetry);
    if (ws) { releaseAll(); const s = ws; ws = null; s.close(); }
    updateCapture();
  }

  function updateCapture() { main.classList.toggle('capturing', capturing()); }
  main.addEventListener('focus', updateCapture);
  main.addEventListener('blur', () => { releaseAll(); updateCapture(); });
  window.addEventListener('blur', () => { releaseAll(); updateCapture(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

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
  }
  const scheduleMove = () => { if (!moveFrame) moveFrame = requestAnimationFrame(flushMove); };
  const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];
  const press = b => { heldButtons.add(b); send({ type: 'mouse_button', button: b, down: true }); };

  img.addEventListener('mousemove', e => {
    if (!capturing()) return;
    pendingMove = norm(e); scheduleMove();
  });
  img.addEventListener('mousedown', e => {
    if (!inp || !inp.enabled || !wsOpen()) return;
    e.preventDefault();
    main.focus();
    pendingMove = norm(e); flushMove();
    const b = BUTTONS[e.button]; if (b) press(b);
  });
  window.addEventListener('mouseup', e => {
    const b = BUTTONS[e.button];
    if (b && heldButtons.delete(b)) { flushMove(); send({ type: 'mouse_button', button: b, down: false }); }
  });
  img.addEventListener('contextmenu', e => { if (inp && inp.enabled) e.preventDefault(); });
  img.addEventListener('dragstart', e => e.preventDefault());
  main.addEventListener('wheel', e => {
    if (!capturing()) return;
    e.preventDefault();
    wheelAcc += e.deltaMode === 1 ? e.deltaY / 3 : e.deltaMode === 2 ? e.deltaY : e.deltaY / 100;
    const n = Math.trunc(wheelAcc);
    if (n) { wheelAcc -= n; send({ type: 'wheel', dx: 0, dy: Math.max(-20, Math.min(20, n)) }); }
  }, { passive: false });
  // Capture phase plus stopImmediatePropagation keeps captured keys from VS Code's keybindings,
  // which the webview host picks up from a bubbling listener on window.
  document.addEventListener('keydown', e => {
    if (!capturing()) return;
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
  let padTimer = null, padSent = null, padSentAt = 0, hadPad = false;
  // '' is Auto (the device's implicit pad), else a virtual pad id chosen in the extension's settings.
  let padTarget = '';
  const padMsg = st => padTarget ? { type: 'gamepad', ...st, pad: padTarget } : { type: 'gamepad', ...st };
  // The old target gets a neutral state so nothing stays held there.
  function retarget(id) {
    if (id === padTarget) return;
    if (padSent) send(padMsg(NEUTRAL_PAD));
    padSent = null;
    padTarget = id;
  }
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
    if (!!st !== hadPad) { hadPad = !!st; flash(st ? 'Gamepad connected' : 'Gamepad disconnected'); }
    if (!st) { clearInterval(padTimer); padTimer = null; return; }
    if (!inp || !inp.enabled || !wsOpen() || !document.hasFocus()) {
      if (padSent) { send(padMsg(NEUTRAL_PAD)); padSent = null; }
      return;
    }
    const json = JSON.stringify(st), now = performance.now();
    // Resend now and then so the server does not retire the pad while a stick is held still.
    if (json !== padSent || now - padSentAt > 10000) { send(padMsg(st)); padSent = json; padSentAt = now; }
  }
  const startPad = () => { if (!padTimer) padTimer = setInterval(pollPad, 16); pollPad(); };
  window.addEventListener('gamepadconnected', startPad);
  window.addEventListener('gamepaddisconnected', () => { if (padSent) { send(padMsg(NEUTRAL_PAD)); padSent = null; } pollPad(); });

  // ---- audio ----
  // Raw 48 kHz s16le stereo over /audio, played by an AudioWorklet with a ~120 ms ring buffer. When
  // the buffer grows past 300 ms (tab throttled, network burst) it drops back to 120 ms, so the
  // sound never drifts behind the picture. Mute and volume are local; on/off is device-wide.
  const WORKLET = `
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = sampleRate;
    this.buf = new Float32Array(this.cap * 2);
    this.r = 0; this.n = 0; this.playing = false;
    this.target = Math.round(sampleRate * 0.12); this.max = Math.round(sampleRate * 0.3);
    this.port.onmessage = e => this.push(new Int16Array(e.data));
  }
  push(s) {
    const frames = s.length >> 1;
    let w = (this.r + this.n) % this.cap;
    for (let i = 0; i < frames; i++) {
      this.buf[w * 2] = s[i * 2] / 32768; this.buf[w * 2 + 1] = s[i * 2 + 1] / 32768;
      w = (w + 1) % this.cap;
    }
    this.n += frames;
    if (this.n > this.max) { const drop = this.n - this.target; this.r = (this.r + drop) % this.cap; this.n -= drop; }
    if (!this.playing && this.n >= this.target) this.playing = true;
  }
  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    for (let i = 0; i < L.length; i++) {
      if (this.playing && this.n > 0) {
        L[i] = this.buf[this.r * 2]; R[i] = this.buf[this.r * 2 + 1];
        this.r = (this.r + 1) % this.cap; this.n--;
      } else { L[i] = 0; R[i] = 0; this.playing = false; }
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);`;
  let actx = null, anode = null, again = null, aws = null, aRetry = null, deviceAudio = false;
  let muted = false, volume = 0.8, nextT = 0;
  const audioRunning = () => !!(actx && actx.state === 'running');

  function applyAudio(m) {
    muted = !!m.muted;
    if (typeof m.volume === 'number') volume = m.volume;
    if (again) again.gain.value = muted ? 0 : volume;
    setDeviceAudio(!!m.on);
  }

  // Browsers keep an AudioContext suspended until a user gesture, so the first click or key press resumes it.
  let creating = false;
  async function ensureAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume().then(renderHint); return; }
    if (creating || !window.AudioContext) return;
    creating = true;
    try {
      let ctx;
      try { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); } catch (e) { ctx = new AudioContext({ latencyHint: 'interactive' }); }
      again = ctx.createGain();
      again.gain.value = muted ? 0 : volume;
      again.connect(ctx.destination);
      if (ctx.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        anode = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
        anode.connect(again);
      }
      actx = ctx;
      ctx.onstatechange = renderHint;
      if (ctx.state === 'suspended') ctx.resume().then(renderHint, () => {});
    } catch (e) {
      console.warn('audio:', e);
      flash('Audio playback failed: ' + e.message, 8000);
    }
    creating = false;
    renderHint();
  }
  window.addEventListener('pointerdown', () => { if (deviceAudio) ensureAudio(); }, true);
  window.addEventListener('keydown', () => { if (deviceAudio) ensureAudio(); }, true);

  // Without a worklet: start 120 ms ahead, re-anchor after an underrun or past 300 ms.
  function schedule(data) {
    const s = new Int16Array(data), n = s.length >> 1;
    const buf = actx.createBuffer(2, n, 48000), L = buf.getChannelData(0), R = buf.getChannelData(1);
    for (let i = 0; i < n; i++) { L[i] = s[i * 2] / 32768; R[i] = s[i * 2 + 1] / 32768; }
    const now = actx.currentTime;
    if (nextT < now + 0.01 || nextT > now + 0.3) nextT = now + 0.12;
    const src = actx.createBufferSource();
    src.buffer = buf; src.connect(again); src.start(nextT);
    nextT += n / 48000;
  }
  function connectAudio() {
    if (aws || !deviceAudio || !visible || !live) return;
    clearTimeout(aRetry);
    const sock = aws = new WebSocket(base.replace(/^http/, 'ws') + '/audio');
    sock.binaryType = 'arraybuffer';
    sock.onmessage = ev => {
      if (typeof ev.data === 'string') return; // {"type":"format"}: always 48 kHz s16le stereo
      if (!audioRunning()) return;
      if (anode) anode.port.postMessage(ev.data, [ev.data]); else schedule(ev.data);
    };
    sock.onclose = ev => {
      if (aws !== sock) return;
      aws = null;
      // 4003: switched off device-wide; the extension's next settings update turns it back on.
      if (ev.code === 4003) { setDeviceAudio(false); return; }
      if (deviceAudio) aRetry = setTimeout(connectAudio, 2000);
    };
  }
  function closeAudio() { clearTimeout(aRetry); if (aws) { const s = aws; aws = null; s.close(); } }
  function setDeviceAudio(on) {
    deviceAudio = on;
    if (on) { connectAudio(); ensureAudio(); } else closeAudio();
    renderHint();
  }

  vscode.postMessage({ type: 'ready' });
  if (live) run();
})();
