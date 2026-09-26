'use strict';

// Shared by the renderer and main process so browser launches use the same rules.
function localAppUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : 'http://' + text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    if (!(url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname))) return '';
    return url.href;
  } catch { return ''; }
}

if (typeof module !== 'undefined') module.exports = { localAppUrl };
else window.localAppUrl = localAppUrl;
