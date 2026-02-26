// ── Config ────────────────────────────────────────────────────────────────────

const CFG_KEY = 'vct_config';

// Default keys — baked in so she just opens the link and it works
const DEFAULTS = {
  deepgramKey:   '4bd3d23b01614a946f4b370007a9fe975111e067',
  openaiKey:     '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',
  elevenlabsKey: 'sk_82d13744f6ebc797fbbb60dbb30b0d9b9ee96803d03dacb4',
};

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CFG_KEY)) || {};
    return { ...DEFAULTS, ...saved };
  } catch { return { ...DEFAULTS }; }
}

function saveConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

function configComplete(cfg) {
  return cfg.deepgramKey && cfg.openaiKey && cfg.elevenlabsKey && cfg.myLanguage;
}

// ── Voices ───────────────────────────────────────────────────────────────────

const VOICES = {
  en: 'iP95p4xoKVk53GoZ742B', // Chris — american male 30s
  es: 'cgSgspJ2msm6clMCkdW9', // Jessica — american female 20s (multilingual)
};

const MODELS = {
  en: 'eleven_turbo_v2_5',
  es: 'eleven_multilingual_v2',
};

// ── State ─────────────────────────────────────────────────────────────────────

let cfg = {};
let peer = null;
let activeCall = null;
let localStream = null;
let mediaRecorder = null;
let audioChunks = [];
let translating = false;

// ── DOM ───────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const settingsModal = $('settings-modal');
const app           = $('app');
const remoteVideo   = $('remote-video');
const localVideo    = $('local-video');
const heardBox      = $('heard-box');
const heardText     = $('heard-text');
const translatedBox = $('translated-box');
const translatedText= $('translated-text');
const statusText    = $('status-text');
const panelStart    = $('panel-start');
const panelShare    = $('panel-share');
const panelCall     = $('panel-call');
const myIdText      = $('my-id-text');
const theirIdInput  = $('their-id-input');

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  cfg = loadConfig();

  // Always go straight to app — keys are pre-loaded
  showApp();

  // Pre-fill settings form
  if (cfg.deepgramKey)   $('deepgram-key').value   = cfg.deepgramKey;
  if (cfg.openaiKey)     $('openai-key').value      = cfg.openaiKey;
  if (cfg.elevenlabsKey) $('elevenlabs-key').value  = cfg.elevenlabsKey;
  if (cfg.myLanguage)    $('my-language').value     = cfg.myLanguage;

  // Check if URL has a peer ID to auto-connect
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  if (roomId) theirIdInput.value = roomId;
});

// ── Settings ─────────────────────────────────────────────────────────────────

function showSettings() {
  settingsModal.classList.remove('hidden');
  app.classList.add('hidden');
}

function showApp() {
  settingsModal.classList.add('hidden');
  app.classList.remove('hidden');
}

$('save-settings-btn').addEventListener('click', () => {
  const newCfg = {
    deepgramKey:   $('deepgram-key').value.trim(),
    openaiKey:     $('openai-key').value.trim(),
    elevenlabsKey: $('elevenlabs-key').value.trim(),
    myLanguage:    $('my-language').value,
  };
  if (!configComplete(newCfg)) {
    alert('Please fill in all fields.');
    return;
  }
  cfg = newCfg;
  saveConfig(cfg);
  showApp();
});

$('settings-gear').addEventListener('click', showSettings);

// ── Start Call ────────────────────────────────────────────────────────────────

$('start-btn').addEventListener('click', async () => {
  setStatus('Getting camera & mic...');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (e) {
    setStatus('Camera/mic access denied.');
    return;
  }

  setStatus('Connecting...');

  peer = new Peer({ debug: 0 });

  peer.on('open', id => {
    myIdText.textContent = id;
    panelStart.classList.add('hidden');
    panelShare.classList.remove('hidden');
    setStatus('Share your link or enter theirs');

    // Auto-connect if URL had a room param
    const savedId = theirIdInput.value.trim();
    if (savedId) callPeer(extractId(savedId));
  });

  peer.on('call', incomingCall => {
    incomingCall.answer(localStream);
    handleCall(incomingCall);
  });

  peer.on('error', err => {
    setStatus('Connection error: ' + err.type);
  });
});

// ── Share Link ────────────────────────────────────────────────────────────────

$('share-btn').addEventListener('click', () => {
  const id = myIdText.textContent;
  const url = `${location.origin}${location.pathname}?room=${id}`;

  if (navigator.share) {
    navigator.share({ title: 'Video Chat Translator', text: 'Join my call', url });
  } else {
    navigator.clipboard.writeText(url).then(() => alert('Link copied!'));
  }
});

// ── Connect to Peer ───────────────────────────────────────────────────────────

$('connect-btn').addEventListener('click', () => {
  const raw = theirIdInput.value.trim();
  if (!raw) return;
  callPeer(extractId(raw));
});

function extractId(input) {
  try {
    const url = new URL(input);
    return url.searchParams.get('room') || input;
  } catch {
    return input;
  }
}

function callPeer(theirId) {
  setStatus('Calling...');
  const outCall = peer.call(theirId, localStream);
  handleCall(outCall);
}

// ── Handle Call ───────────────────────────────────────────────────────────────

function handleCall(call) {
  activeCall = call;

  call.on('stream', remoteStream => {
    // Show remote video (audio muted — we'll play translated version instead)
    remoteVideo.srcObject = remoteStream;

    panelShare.classList.add('hidden');
    panelCall.classList.remove('hidden');
    setStatus('Connected ✓');

    // Start translation of their audio
    startTranslation(remoteStream);
  });

  call.on('close', endCall);
  call.on('error', () => endCall());
}

// ── End Call ──────────────────────────────────────────────────────────────────

$('end-btn').addEventListener('click', endCall);

function endCall() {
  stopTranslation();
  if (activeCall) { activeCall.close(); activeCall = null; }
  if (peer) { peer.destroy(); peer = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }

  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  heardBox.style.display = 'none';
  translatedBox.style.display = 'none';

  panelCall.classList.add('hidden');
  panelShare.classList.add('hidden');
  panelStart.classList.remove('hidden');
  setStatus('Call ended');
}

// ── Translation Pipeline ──────────────────────────────────────────────────────

function startTranslation(remoteStream) {
  // Their language is the opposite of mine
  const theirLang = cfg.myLanguage === 'en' ? 'es' : 'en';
  const myLang    = cfg.myLanguage;

  // Get audio-only stream from remote
  const audioTracks = remoteStream.getAudioTracks();
  if (audioTracks.length === 0) return;
  const audioStream = new MediaStream(audioTracks);

  // Pick mime type (Safari needs audio/mp4)
  const mimeType = MediaRecorder.isTypeSupported('audio/webm')
    ? 'audio/webm'
    : 'audio/mp4';

  mediaRecorder = new MediaRecorder(audioStream, { mimeType });

  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 50) {
      audioChunks.push(e.data);
    }
  };

  // Process every 3 seconds
  mediaRecorder.onstop = async () => {
    if (audioChunks.length === 0 || translating) return;
    const blob = new Blob(audioChunks, { type: mimeType });
    audioChunks = [];
    translating = true;

    try {
      await processChunk(blob, theirLang, myLang);
    } finally {
      translating = false;
    }

    // Restart recording if still in call
    if (mediaRecorder && activeCall) {
      mediaRecorder.start();
      setTimeout(() => { if (mediaRecorder?.state === 'recording') mediaRecorder.stop(); }, 3000);
    }
  };

  // Start the recording loop
  audioChunks = [];
  mediaRecorder.start();
  setTimeout(() => { if (mediaRecorder?.state === 'recording') mediaRecorder.stop(); }, 3000);
}

function stopTranslation() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  audioChunks = [];
}

async function processChunk(audioBlob, theirLang, myLang) {
  // 1. Transcribe with Deepgram
  setStatus('Transcribing...');
  const transcript = await transcribe(audioBlob, theirLang);
  if (!transcript || transcript.split(' ').length < 2) {
    setStatus('Connected ✓');
    return;
  }

  showHeard(transcript);
  setStatus('Translating...');

  // 2. Translate with OpenAI
  const translation = await translate(transcript, theirLang, myLang);
  if (!translation) { setStatus('Connected ✓'); return; }

  showTranslated(translation);
  setStatus('Speaking...');

  // 3. Synthesize with ElevenLabs and play
  const audioUrl = await synthesize(translation, myLang);
  if (audioUrl) await playAudio(audioUrl);

  setStatus('Connected ✓');
}

// ── Deepgram ─────────────────────────────────────────────────────────────────

async function transcribe(audioBlob, language) {
  const langCode = language === 'es' ? 'es' : 'en-US';
  try {
    const resp = await fetch(
      `https://api.deepgram.com/v1/listen?model=nova-3&language=${langCode}&punctuate=true&smart_format=true`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${cfg.deepgramKey}`,
          'Content-Type': audioBlob.type,
        },
        body: audioBlob,
      }
    );
    const data = await resp.json();
    return data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  } catch (e) {
    console.error('Transcribe error:', e);
    return '';
  }
}

// ── OpenAI Translation ────────────────────────────────────────────────────────

const PROMPTS = {
  es_to_en: 'You are a real-time interpreter. Translate the following Colombian Spanish to natural conversational American English. Output only the translation.',
  en_to_es: 'You are a real-time interpreter. Translate the following English to conversational Colombian Spanish as spoken in Medellín. Use natural casual phrasing with tú. Output only the translation.',
};

async function translate(text, fromLang, toLang) {
  const direction = `${fromLang}_to_${toLang}`;
  const systemPrompt = PROMPTS[direction] || PROMPTS['en_to_es'];
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.openaiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error('Translate error:', e);
    return '';
  }
}

// ── ElevenLabs TTS ────────────────────────────────────────────────────────────

async function synthesize(text, language) {
  const voiceId  = VOICES[language];
  const modelId  = MODELS[language];
  try {
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': cfg.elevenlabsKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        output_format: 'mp3_44100_128',
      }),
    });
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  } catch (e) {
    console.error('Synthesize error:', e);
    return null;
  }
}

function playAudio(url) {
  return new Promise(resolve => {
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror = resolve;
    audio.play().catch(resolve);
  });
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

function setStatus(msg) { statusText.textContent = msg; }

function showHeard(text) {
  heardText.textContent = text;
  heardBox.style.display = 'block';
}

function showTranslated(text) {
  translatedText.textContent = text;
  translatedBox.style.display = 'block';
}
