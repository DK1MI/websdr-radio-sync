// Port chooser for when the side panel can't show Chrome's serial chooser.
// The permission it grants belongs to the extension origin, so the side panel
// can then open the same port through navigator.serial.getPorts().
'use strict';

const msg = document.getElementById('msg');

document.getElementById('chooseBtn').addEventListener('click', async () => {
  msg.textContent = '';
  let port;
  const t0 = performance.now();
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    if (e.name === 'NotFoundError' && performance.now() - t0 < 400) {
      msg.textContent = 'Chrome refused to show the port chooser here (it rejected instantly). Check chrome://settings/content/serialPorts.';
    } else {
      msg.textContent = e.name === 'NotFoundError' ? 'No port selected.' : `Port selection failed: ${e.name}: ${e.message}`;
    }
    return;
  }
  const info = port.getInfo();
  await chrome.runtime.sendMessage({
    type: 'port-granted',
    info: { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId },
  }).catch(() => {});
  msg.textContent = 'Port granted. You can close this tab.';
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab) await chrome.tabs.remove(tab.id);
    else window.close();
  } catch (_) { window.close(); }
});
