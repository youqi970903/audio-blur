const captures = new Map();

async function releaseAudio(capture) {
  // Stopping the tab stream returns playback to Chrome's native audio path.
  for (const track of capture.stream?.getTracks() ?? []) track.stop();
  if (capture.context && capture.context.state !== 'closed') {
    await capture.context.close().catch(console.warn);
  }
}

async function stopAudio(tabId) {
  const capture = captures.get(tabId);
  if (!capture) return;
  captures.delete(tabId);
  await releaseAudio(capture);
}

function reportCaptureEnded(tabId, capture) {
  if (captures.get(tabId) !== capture) return;
  stopAudio(tabId).then(() => {
    chrome.runtime.sendMessage({ target: 'popup', action: 'capture-ended', tabId }).catch(() => {});
    chrome.runtime.sendMessage({ target: 'background', action: 'capture-ended', tabId }).catch(console.warn);
  }).catch(console.warn);
}

async function resumeAudio(context) {
  if (context.state === 'running') return;
  let timeout;
  try {
    await Promise.race([
      context.resume(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Chrome could not start audio playback.')), 2500);
      }),
    ]);
    if (context.state !== 'running') throw new Error('Chrome could not start audio playback.');
  } finally {
    clearTimeout(timeout);
  }
}

async function startAudio({ tabId, streamId, intensity }) {
  if (captures.has(tabId)) return;

  const capture = { intensity };
  try {
    capture.context = new AudioContext();
    capture.effect = createAdjustableEffect(capture.context);
    applyEffectIntensity(capture.effect, intensity, capture.context, true);
    capture.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    });
    const tracks = capture.stream.getAudioTracks();
    if (!tracks.length) throw new Error('Chrome did not provide audio for this tab.');

    const source = capture.context.createMediaStreamSource(capture.stream);
    source.connect(capture.effect.input);
    capture.effect.output.connect(capture.context.destination);
    await resumeAudio(capture.context);

    if (tracks.every(track => track.readyState === 'ended')) throw new Error('Tab audio ended before the effect started.');
    captures.set(tabId, capture);
    for (const track of tracks) track.addEventListener('ended', () => reportCaptureEnded(tabId, capture), { once: true });
  } catch (error) {
    await releaseAudio(capture);
    throw error;
  }
}

async function handleAudio(message) {
  const { action, tabId, intensity } = message;
  const capture = captures.get(tabId);
  switch (action) {
    case 'idle':
      return { idle: captures.size === 0 };
    case 'status':
      return { enabled: Boolean(capture), intensity: capture?.intensity };
    case 'start':
      await startAudio(message);
      return {};
    case 'stop':
      await stopAudio(tabId);
      return {};
    case 'intensity':
      if (capture) {
        applyEffectIntensity(capture.effect, intensity, capture.context);
        capture.intensity = intensity;
      }
      return {};
    default:
      throw new Error('Unknown audio operation.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'offscreen' || sender.id !== chrome.runtime.id) return;
  handleAudio(message).then(
    result => reply({ ok: true, ...result }),
    error => reply({ ok: false, error: error.message }),
  );
  return true;
});
