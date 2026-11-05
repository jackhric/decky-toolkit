// Sidebar preview: one /frame.jpg every 1.5 s through the extension's loopback proxy, never the MJPEG stream.
(() => {
  const vscode = acquireVsCodeApi();
  const img = document.getElementById('img'), msg = document.getElementById('msg');
  const INTERVAL_MS = 1500;
  const base = document.body.dataset.base;
  const open = document.getElementById('open');
  // live: the extension's connection is up; otherwise `offline` explains why and nothing is fetched.
  let live = document.body.dataset.live === 'true', offline = document.body.dataset.text || '';
  let visible = document.visibilityState === 'visible';
  let timer = null, inflight = null, lastUrl = null, gen = 0;

  const show = t => { msg.textContent = t; msg.hidden = !t; };

  async function tick() {
    const my = gen;
    timer = null;
    if (!visible || !live) return;
    inflight = new AbortController();
    try {
      const res = await fetch(base + '/frame.jpg?t=' + Date.now(), { signal: inflight.signal, cache: 'no-store' });
      if (res.status === 401) show('Token rejected.\nRe-pair the device from the Devices view.');
      else if (!res.ok) show('No frame: ' + (await res.text()).slice(0, 200));
      else {
        const url = URL.createObjectURL(await res.blob());
        img.onload = () => { if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = url; };
        img.src = url;
        show('');
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      show('Device unreachable');
    } finally {
      inflight = null;
    }
    if (my === gen) schedule();
  }

  function schedule() { if (!timer && visible && live) timer = setTimeout(tick, INTERVAL_MS); }
  function stop() { gen++; clearTimeout(timer); timer = null; if (inflight) inflight.abort(); }
  function restart() {
    stop();
    open.hidden = !live;
    if (!live) return show(offline || 'Not connected.\nConnect to a device in the Devices view.');
    if (visible) tick();
  }

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'state') { live = m.live; offline = m.text || ''; restart(); }
    if (m.type === 'visible') { visible = m.visible; restart(); }
  });
  document.addEventListener('visibilitychange', () => { visible = document.visibilityState === 'visible'; restart(); });
  open.onclick = () => vscode.postMessage({ type: 'open' });
  restart();
})();
