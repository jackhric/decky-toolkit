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
      if (res.status === 401) { show('Unauthorized: the stored token was rejected.\nRe-pair the device from the Devices view (… → Re-pair) or run "Decky: Enter token manually".'); return; }
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
          if (applying === 'sent') doneApplying('');
          if (!paused) present(frame);
        }
      }
      show(applying ? 'Applying stream settings…' : 'Stream ended. Reconnecting…');
    } catch (e) {
      if (e.name !== 'AbortError') show(applying ? 'Applying stream settings…' : 'Disconnected: ' + e.message + '\nReconnecting…');
    }
    dot.classList.remove('live');
    if (my === gen && visible && !abort.signal.aborted) retry = setTimeout(run, 2000);
  }

  function stop() { gen++; clearTimeout(retry); if (abort) abort.abort(); dot.classList.remove('live'); }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'reconnect') { if (m.base) base = m.base; stop(); closeWs(); closeAudio(); if (visible) run(); if (inp && inp.enabled) connectWs(); connectAudio(); }
    // Hidden panels keep their context; stop pulling ~50 Mbit/s nobody is looking at.
    // onDidChangeViewState also fires on focus changes, so only act when visibility really flips.
    if (m.type === 'visible' && m.visible !== visible) { visible = m.visible; if (visible) { show('Connecting…'); run(); connectAudio(); } else { stop(); releaseAll(); closeAudio(); } }
    if (m.type === 'input') applyInput(m.state);
    if (m.type === 'stream') streamSettings(m);
    if (m.type === 'pads') setPads(m.pads, m.select);
  });

  el('pause').onclick = () => { paused = !paused; el('pause').textContent = paused ? 'Resume' : 'Pause'; el('pause').classList.toggle('on', paused); };
  el('fit').onclick = () => { const actual = el('main').classList.toggle('actual'); el('fit').classList.toggle('on', !actual); el('fit').textContent = actual ? 'Actual' : 'Fit'; };
  el('snap').onclick = () => vscode.postMessage({ type: 'snapshot' });
  el('full').hidden = !document.fullscreenEnabled;
  el('full').onclick = () => document.fullscreenElement ? document.exitFullscreen() : el('main').requestFullscreen();
  document.addEventListener('keydown', e => {
    if (capturing()) return;
    if (e.key === 'Escape') togglePop(false);
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (e.key === ' ') { e.preventDefault(); el('pause').click(); }
    if (e.key === 'f' && !el('full').hidden) el('full').click();
  });

  // Stream settings are device-wide; like the input flag, the extension loads and applies them
  // (postMessage 'setStream') and pushes changes made elsewhere with its 5 s stats tick.
  const selects = { fps: el('s-fps'), quality: el('s-quality'), width: el('s-width') };
  let applying = false, applyTimer = null;
  function fill(st) {
    for (const [key, sel] of Object.entries(selects)) {
      if (st[key] === undefined) continue;
      const v = String(st[key]);
      if (sel.options && typeof Option === 'function' && ![...sel.options].some(o => o.value === v)) sel.add(new Option(v + (key === 'fps' ? ' fps' : ''), v));
      sel.value = v;
    }
    if (typeof st.audio === 'boolean') {
      el('s-audio').hidden = el('s-audio-label').hidden = false;
      el('s-audio').checked = st.audio;
      setDeviceAudio(st.audio);
    }
  }
  function setDisabled(on) { Object.values(selects).forEach(s => s.disabled = on); el('s-audio').disabled = on; }
  function doneApplying(text) {
    applying = false; clearTimeout(applyTimer);
    setDisabled(false);
    el('s-note').textContent = text || 'Applies to every viewer.';
  }
  function apply(patch) {
    applying = 'pending'; setDisabled(true);
    el('s-note').textContent = 'Applying…';
    vscode.postMessage({ type: 'setStream', patch });
  }
  function streamSettings(m) {
    if (m.error) { doneApplying('Failed: ' + m.error); return; }
    if (m.settings === null) { el('settings').hidden = true; togglePop(false); return; }
    if (applying && !m.applied) return; // a stats tick from before the change
    el('settings').hidden = false;
    fill(m.settings);
    if (!m.applied) return;
    // The video pipeline has restarted by the time PUT returns, so the next frame is from the new one.
    if (m.applied.some(k => k !== 'audio') && visible) { applying = 'sent'; applyTimer = setTimeout(() => doneApplying(''), 6000); }
    else doneApplying('');
  }
  for (const [key, sel] of Object.entries(selects)) sel.onchange = () => apply({ [key]: +sel.value });
  el('s-audio').onchange = () => apply({ audio: el('s-audio').checked });
  function togglePop(open) { el('pop').hidden = !open; el('gear').classList.toggle('on', open); el('gear').setAttribute?.('aria-expanded', String(open)); }
  el('gear').onclick = e => { e.stopPropagation(); togglePop(el('pop').hidden); };
  el('pop').onclick = e => e.stopPropagation();
  document.addEventListener('click', () => togglePop(false));

  // Remote input, ported from static/viewer.html. The on/off flag is device-wide and owned by the
  // extension (postMessage 'setInput'); only the /input WebSocket goes from here to the proxy.
  const main = el('main');
  let inp = null, ws = null, wsRetry = null;
  const heldKeys = new Set(), heldButtons = new Set();
  let pendingMove = null, moveFrame = 0, wheelAcc = 0;
  const wsOpen = () => ws && ws.readyState === WebSocket.OPEN;
  const send = m => { if (wsOpen()) ws.send(JSON.stringify(m)); };
  // Keys are only captured while the picture has focus (click it); toolbar clicks give them back.
  function capturing() { return !!(inp && inp.enabled && wsOpen() && document.activeElement === main); }
  const note = t => { el('inp-note').textContent = t || ''; };

  function releaseAll() {
    for (const k of heldKeys) send({ type: 'key', key: k, down: false });
    for (const b of heldButtons) send({ type: 'mouse_button', button: b, down: false });
    heldKeys.clear(); heldButtons.clear();
    if (padSent) { send(padMsg(NEUTRAL_PAD)); padSent = null; }
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
    sock.onopen = () => { note(''); updateCapture(); };
    sock.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'error') { note(m.message); console.warn('input:', m.message); }
    };
    sock.onclose = ev => {
      if (ws !== sock) return;
      ws = null; heldKeys.clear(); heldButtons.clear(); padSent = null;
      updateCapture();
      // 4003: input was turned off or pairing is open; the extension's next state update says which.
      if (ev.code === 4003) { note(ev.reason || 'Input refused'); vscode.postMessage({ type: 'refreshInput' }); return; }
      if (inp && inp.enabled) wsRetry = setTimeout(connectWs, 1500);
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
  img.addEventListener('dragstart', e => { if (inp && inp.enabled) e.preventDefault(); });
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
  let padTimer = null, padSent = null, padSentAt = 0;
  // "Forward to": '' is Auto (the device's implicit pad), else a virtual pad id from the extension.
  const ADD_PAD = '__add__';
  let pads = null, padTarget = ((vscode.getState && vscode.getState()) || {}).padTarget || '';
  const padMsg = st => padTarget ? { type: 'gamepad', ...st, pad: padTarget } : { type: 'gamepad', ...st };
  function updatePadUi() { el('pad-fwd').hidden = !pads || el('pad-ind').hidden; }
  function setPads(list, select) {
    pads = list;
    if (select) retarget(select);
    if (!list || (padTarget && !list.some(p => p.id === padTarget))) retarget('');
    const sel = el('pad-target');
    if (list) {
      while (sel.options.length) sel.remove(0);
      [['', 'Auto'], ...list.map(p => [p.id, p.name]), [ADD_PAD, 'New virtual pad…']].forEach(([v, t]) => sel.add(new Option(t, v)));
      sel.value = padTarget;
    }
    updatePadUi();
  }
  // The old target gets a neutral state so nothing stays held there.
  function retarget(id) {
    if (id === padTarget) return;
    if (padSent) send(padMsg(NEUTRAL_PAD));
    padSent = null;
    padTarget = id;
    if (vscode.setState) vscode.setState({ ...((vscode.getState && vscode.getState()) || {}), padTarget });
  }
  el('pad-target').onchange = () => {
    const sel = el('pad-target');
    if (sel.value === ADD_PAD) { sel.value = padTarget; vscode.postMessage({ type: 'addPad' }); return; }
    retarget(sel.value);
  };
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
    updatePadUi();
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
  let muted = false, volume = 0.8, aWin = [], aWinBytes = 0, nextT = 0;
  const saved = (vscode.getState && vscode.getState()) || {};
  muted = !!saved.muted; if (typeof saved.volume === 'number') volume = saved.volume;
  el('vol').value = Math.round(volume * 100);

  function updateAudioUi() {
    const running = !!(actx && actx.state === 'running');
    el('audio-ctl').hidden = !deviceAudio;
    el('a-stat').hidden = !deviceAudio;
    el('a-hint').hidden = !deviceAudio || running;
    el('mute').textContent = muted ? '🔇' : '🔊';
    el('mute').classList.toggle('on', muted);
    el('mute').title = muted ? 'Unmute audio on this computer' : 'Mute audio on this computer (the device keeps playing)';
  }
  function applyVolume() {
    if (again) again.gain.value = muted ? 0 : volume;
    if (vscode.setState) vscode.setState({ ...((vscode.getState && vscode.getState()) || {}), muted, volume });
    updateAudioUi();
  }
  el('mute').onclick = () => { muted = !muted; applyVolume(); };
  el('vol').oninput = () => { volume = el('vol').value / 100; if (muted && volume > 0) muted = false; applyVolume(); };

  // Browsers keep an AudioContext suspended until a user gesture, so the first click or key press resumes it.
  let creating = false;
  async function ensureAudio() {
    if (actx) { if (actx.state === 'suspended') actx.resume().then(updateAudioUi); return; }
    if (creating || !window.AudioContext) return;
    creating = true;
    try {
      let ctx;
      try { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); } catch (e) { ctx = new AudioContext({ latencyHint: 'interactive' }); }
      again = ctx.createGain();
      again.connect(ctx.destination);
      // AudioWorklet only exists in secure contexts (https, localhost, webviews); plain http on the
      // LAN falls back to scheduling one AudioBufferSource per chunk.
      if (ctx.audioWorklet) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
        anode = new AudioWorkletNode(ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
        anode.connect(again);
      }
      actx = ctx;
      ctx.onstatechange = updateAudioUi;
      applyVolume();
      if (ctx.state === 'suspended') ctx.resume().then(updateAudioUi, () => {});
    } catch (e) {
      console.warn('audio:', e);
      el('a-hint').textContent = 'Audio playback failed: ' + e.message;
    }
    creating = false;
    updateAudioUi();
  }
  window.addEventListener('pointerdown', () => { if (deviceAudio) ensureAudio(); }, true);
  window.addEventListener('keydown', () => { if (deviceAudio) ensureAudio(); }, true);
  updateAudioUi();

  // Same budget as the worklet: start 120 ms ahead, re-anchor after an underrun or past 300 ms.
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
  function audioStats(bytes) {
    const now = performance.now();
    aWin.push([now, bytes]); aWinBytes += bytes;
    while (aWin.length && now - aWin[0][0] > 2000) aWinBytes -= aWin.shift()[1];
    if (aWin.length % 25 === 0) el('akbps').textContent = Math.round(aWinBytes * 8 / 2 / 1000);
  }
  function connectAudio() {
    if (aws || !deviceAudio || !visible) return;
    clearTimeout(aRetry);
    const sock = aws = new WebSocket(base.replace(/^http/, 'ws') + '/audio');
    sock.binaryType = 'arraybuffer';
    sock.onmessage = ev => {
      if (typeof ev.data === 'string') return; // {"type":"format"}: always 48 kHz s16le stereo
      audioStats(ev.data.byteLength);
      if (!actx || actx.state !== 'running') return;
      if (anode) anode.port.postMessage(ev.data, [ev.data]); else schedule(ev.data);
    };
    sock.onclose = ev => {
      if (aws !== sock) return;
      aws = null; el('akbps').textContent = '–';
      // 4003: switched off device-wide; the next settings update from the extension turns it back on.
      if (ev.code === 4003) { setDeviceAudio(false); return; }
      if (deviceAudio) aRetry = setTimeout(connectAudio, 2000);
    };
  }
  function closeAudio() { clearTimeout(aRetry); if (aws) { const s = aws; aws = null; s.close(); } el('akbps').textContent = '–'; }
  // The extension re-sends the device-wide flag with every stats tick, so a 4003 recovers by itself.
  function setDeviceAudio(on) {
    deviceAudio = on;
    if (on) { connectAudio(); ensureAudio(); } else closeAudio();
    updateAudioUi();
  }

  vscode.postMessage({ type: 'ready' });
  run();
})();
