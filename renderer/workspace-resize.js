'use strict';

(() => {
  const panel = document.getElementById('workspace');
  const divider = document.getElementById('workspaceresize');
  const main = document.getElementById('main');
  const key = 'workspaceHeight';
  let preferred = Number(localStorage.getItem(key)) || 190;
  let drag = null;

  function apply(height) {
    const max = Math.max(140, main.clientHeight - 150);
    const next = Math.round(Math.max(140, Math.min(max, height)));
    panel.style.height = next + 'px';
    divider.setAttribute('aria-valuemin', '140');
    divider.setAttribute('aria-valuemax', String(max));
    divider.setAttribute('aria-valuenow', String(next));
    return next;
  }

  function save(height) {
    preferred = apply(height);
    localStorage.setItem(key, String(preferred));
  }

  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height };
    divider.setPointerCapture(event.pointerId);
    divider.classList.add('dragging');
    document.body.classList.add('workspace-resizing');
    divider.focus();
  });
  divider.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    apply(drag.height + event.clientY - drag.y);
  });
  function finish(event) {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    divider.classList.remove('dragging');
    document.body.classList.remove('workspace-resizing');
    save(panel.getBoundingClientRect().height);
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  }
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) divider.addEventListener(name, finish);
  divider.addEventListener('dblclick', () => save(190));
  divider.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = (event.shiftKey ? 40 : 10) * (event.key === 'ArrowUp' ? -1 : 1);
    save(event.key === 'Home' ? 190 : panel.getBoundingClientRect().height + delta);
  });
  new ResizeObserver(() => apply(preferred)).observe(main);
  apply(preferred);
})();
