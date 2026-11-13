const toggle = document.getElementById('enableToggle');
const statusLabel = document.getElementById('statusLabel');
const slider = document.getElementById('blurSlider');
const blurValue = document.getElementById('blurValue');
const infoText = document.getElementById('infoText');
const container = document.querySelector('.container');
const defaultHint = infoText.textContent.trim();
let tabId;
let enabled = false;
let busy = false;
let previewTimer;

document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;

async function request(action, fields = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', action, tabId, ...fields });
  if (!response?.ok) throw new Error(response?.error || 'Audio Blur did not respond.');
  return response;
}

function renderState() {
  toggle.checked = enabled;
  toggle.disabled = busy || tabId === undefined;
  slider.disabled = busy || !enabled;
  statusLabel.textContent = busy ? 'Working…' : enabled ? 'Enabled' : 'Disabled';
  statusLabel.classList.toggle('active', enabled);
  container.classList.toggle('disabled', !enabled);
}

function renderIntensity(intensity) {
  const percentage = Math.round(intensity * 100);
  slider.value = percentage;
  blurValue.textContent = `${percentage}%`;
  slider.style.background = `linear-gradient(to right, #fff 0%, #fff ${percentage}%, #2a2a2a ${percentage}%, #2a2a2a 100%)`;
}

function showError(message, error) {
  infoText.textContent = message;
  console.warn(error.message);
}

toggle.addEventListener('change', async () => {
  const requestedState = toggle.checked;
  busy = true;
  infoText.textContent = defaultHint;
  renderState();
  try {
    const status = await request('toggle', { enabled: requestedState });
    enabled = status.enabled;
  } catch (error) {
    showError(requestedState ? 'Audio Blur could not start on this tab.' : 'Audio Blur could not stop. Try again.', error);
    try {
      enabled = (await request('status')).enabled;
    } catch (statusError) {
      console.warn(statusError.message);
    }
  } finally {
    busy = false;
    renderState();
  }
});

slider.addEventListener('input', () => {
  renderIntensity(Number(slider.value) / 100);
  if (previewTimer !== undefined) return;
  previewTimer = setTimeout(() => {
    previewTimer = undefined;
    request('preview', { intensity: Number(slider.value) / 100 }).catch(error => {
      showError('Audio Blur could not update the intensity.', error);
    });
  }, 40);
});

slider.addEventListener('change', () => {
  clearTimeout(previewTimer);
  previewTimer = undefined;
  infoText.textContent = defaultHint;
  request('commit', { intensity: Number(slider.value) / 100 }).catch(error => {
    showError('Audio Blur could not save the intensity.', error);
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'popup' ||
      message.action !== 'capture-ended' || message.tabId !== tabId) return;
  enabled = false;
  infoText.textContent = 'Tab audio stopped. Turn Audio Blur back on to continue.';
  renderState();
});

async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined || tab.id < 0) throw new Error('No active browser tab.');
    tabId = tab.id;
    const status = await request('status');
    enabled = status.enabled;
    renderIntensity(status.intensity);
  } catch (error) {
    tabId = undefined;
    showError('Open a video or audio page to use Audio Blur.', error);
  }
  renderState();
}

initialize();
