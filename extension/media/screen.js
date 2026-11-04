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
    if (m.type === 'reconnect') { if (m.base) base = m.base; stop(); if (visible) run(); }
    // Hidden panels keep their context; stop pulling ~50 Mbit/s nobody is looking at.
    // onDidChangeViewState also fires on focus changes, so only act when visibility really flips.
    if (m.type === 'visible' && m.visible !== visible) { visible = m.visible; if (visible) { show('Connecting…'); run(); } else stop(); }
  });

  el('pause').onclick = () => { paused = !paused; el('pause').textContent = paused ? 'Resume' : 'Pause'; el('pause').classList.toggle('on', paused); };
  el('fit').onclick = () => { const actual = el('main').classList.toggle('actual'); el('fit').classList.toggle('on', !actual); el('fit').textContent = actual ? 'Actual' : 'Fit'; };
  el('snap').onclick = () => vscode.postMessage({ type: 'snapshot' });
  document.addEventListener('keydown', e => { if (e.key === ' ') { e.preventDefault(); el('pause').click(); } });
  run();
})();
