const popupURL = chrome.runtime.getURL('popup.html');
const offscreenURL = chrome.runtime.getURL('offscreen.html');
const defaultIntensity = 0.85;
let pendingOperation = Promise.resolve();

// Keep offscreen creation, capture changes, and cleanup ordered across windows.
function enqueue(operation) {
  const result = pendingOperation.then(operation);
  pendingOperation = result.catch(() => {});
  return result;
}

function intensityKey(tabId) {
  return `audioBlurIntensity:${tabId}`;
}

function validIntensity(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

async function getIntensity(tabId) {
  const key = intensityKey(tabId);
  const session = await chrome.storage.session.get(key);
  if (validIntensity(session[key])) return session[key];

  const local = await chrome.storage.local.get('blurIntensity');
  let intensity = local.blurIntensity;
  if (!validIntensity(intensity)) {
    const legacy = await chrome.storage.sync.get('blurIntensity');
    intensity = validIntensity(legacy.blurIntensity) ? legacy.blurIntensity : defaultIntensity;
  }
  await chrome.storage.session.set({ [key]: intensity });
  return intensity;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenURL],
  });
  return contexts.length > 0;
}

async function sendToAudio(action, params = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'offscreen', action, ...params });
  if (!response?.ok) throw new Error(response?.error || 'The audio processor did not respond.');
  return response;
}

async function closeAudioIfIdle() {
  if (await hasOffscreenDocument() && (await sendToAudio('idle')).idle) {
    await chrome.offscreen.closeDocument();
  }
}

async function stopCapture(tabId) {
  if (await hasOffscreenDocument()) {
    await sendToAudio('stop', { tabId });
    await closeAudioIfIdle();
  }
  return { enabled: false };
}

async function startCapture(tabId, intensity) {
  if (!(await hasOffscreenDocument())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Apply the user-selected blur to tab audio and play it locally.',
    });
  }

  try {
    const status = await sendToAudio('status', { tabId });
    if (!status.enabled) {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      await sendToAudio('start', { tabId, streamId, intensity });
    }
    return { enabled: true };
  } catch (error) {
    await closeAudioIfIdle().catch(console.warn);
    throw error;
  }
}

async function handlePopup({ action, tabId, intensity, enabled }) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('No browser tab is available.');
  switch (action) {
    case 'status': {
      const savedIntensity = await getIntensity(tabId);
      const status = await hasOffscreenDocument() ? await sendToAudio('status', { tabId }) : { enabled: false };
      return { enabled: status.enabled, intensity: status.intensity ?? savedIntensity };
    }
    case 'toggle':
      return enabled ? startCapture(tabId, await getIntensity(tabId)) : stopCapture(tabId);
    case 'preview':
    case 'commit': {
      if (!validIntensity(intensity)) throw new Error('Invalid blur intensity.');
      if (await hasOffscreenDocument()) await sendToAudio('intensity', { tabId, intensity });
      if (action === 'commit') {
        await chrome.storage.session.set({ [intensityKey(tabId)]: intensity });
        await chrome.storage.local.set({ blurIntensity: intensity });
      }
      return {};
    }
    default:
      throw new Error('Unknown audio control.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'background' || sender.id !== chrome.runtime.id) return;

  let operation;
  if (sender.url === popupURL) {
    operation = () => handlePopup(message);
  } else if (sender.url === offscreenURL && message.action === 'capture-ended') {
    operation = async () => {
      await closeAudioIfIdle();
      return {};
    };
  } else {
    return;
  }

  enqueue(operation).then(
    result => reply({ ok: true, ...result }),
    error => reply({ ok: false, error: error.message }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  enqueue(async () => {
    await chrome.storage.session.remove(intensityKey(tabId));
    await stopCapture(tabId);
  }).catch(console.warn);
});
