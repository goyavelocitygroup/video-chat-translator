// ── Config ────────────────────────────────────────────────────────────────────

const CFG_KEY = 'vct_config';

// Deepgram + ElevenLabs baked in for convenience.
// OpenAI key is NOT stored here — GitHub auto-revokes sk-proj-* keys found in public repos.
// Users enter it once via ⚙️ Settings; it saves to localStorage on each device.
const DEFAULTS = {
  deepgramKey:   '4bd3d23b01614a946f4b370007a9fe975111e067',
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

// Voices are keyed by the LISTENER's language, but represent the SPEAKER's gender.
// Jeffrey (male) speaks → she hears → male Spanish voice (Chris in Spanish)
// She (female) speaks → he hears → female English voice (Jessica in English)
const VOICES = {
  en: 'cgSgspJ2msm6clMCkdW9', // Jessica — female English (represents her voice)
  es: 'iP95p4xoKVk53GoZ742B', // Chris — male Spanish (represents Jeffrey's voice)
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
let audioCtx = null;  // AudioContext — unlocked on first user gesture for iOS
let roomCode = null;  // set from ?code= URL param for bookmark-based auto-connect

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
const panelRoom     = $('panel-room');
const panelCall     = $('panel-call');
const myIdText      = $('my-id-text');
const theirIdInput  = $('their-id-input');
const langBtn       = $('lang-btn');

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  cfg = loadConfig();

  // Default language if not set
  if (!cfg.myLanguage) cfg.myLanguage = 'en';

  // Read URL params
  const params = new URLSearchParams(window.location.search);

  // ?lang= overrides language (e.g. from a shared link)
  const langParam = params.get('lang');
  if (langParam === 'es' || langParam === 'en') cfg.myLanguage = langParam;

  // ?code= sets the shared room code for bookmark-based auto-connect
  roomCode = params.get('code') || null;

  // Show settings if OpenAI key hasn't been entered yet (it's not baked in)
  if (!cfg.openaiKey) {
    showSettings();
  } else {
    showApp();
  }
  updateLangBtn();

  // Pre-fill settings form
  if (cfg.deepgramKey)   $('deepgram-key').value   = cfg.deepgramKey;
  if (cfg.openaiKey)     $('openai-key').value      = cfg.openaiKey;
  if (cfg.elevenlabsKey) $('elevenlabs-key').value  = cfg.elevenlabsKey;
  $('my-language').value = cfg.myLanguage;

  // Old-style share link: ?room=PEERID fills the connect input
  const roomId = params.get('room');
  if (roomId) theirIdInput.value = roomId;
});

// ── Language Toggle ───────────────────────────────────────────────────────────

function updateLangBtn() {
  langBtn.textContent = cfg.myLanguage === 'es'
    ? 'I speak: Spanish 🇨🇴'
    : 'I speak: English 🇺🇸';
}

langBtn.addEventListener('click', () => {
  cfg.myLanguage = cfg.myLanguage === 'en' ? 'es' : 'en';
  updateLangBtn();
  $('my-language').value = cfg.myLanguage;
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
  updateLangBtn();
  showApp();
});

$('settings-gear').addEventListener('click', showSettings);

// ── Start Call ────────────────────────────────────────────────────────────────

$('start-btn').addEventListener('click', async () => {
  // Unlock audio on iOS — must happen inside user gesture handler
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  } catch(e) { console.warn('AudioContext init failed:', e); }

  setStatus('Getting camera & mic...');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (e) {
    setStatus('Camera/mic access denied.');
    return;
  }

  setStatus('Connecting...');

  // Use a fixed peer ID derived from room code so bookmarks always reconnect
  const myPeerId = roomCode ? `vct-${roomCode}-${cfg.myLanguage}` : undefined;
  peer = new Peer(myPeerId, { debug: 0 });

  peer.on('open', id => {
    panelStart.classList.add('hidden');

    if (roomCode) {
      // Room mode: auto-connect, no sharing needed
      panelRoom.classList.remove('hidden');
      connectToRoom();
    } else {
      // Manual mode: show share panel
      myIdText.textContent = id;
      panelShare.classList.remove('hidden');
      setStatus('Share your link or enter theirs');
      const savedId = theirIdInput.value.trim();
      if (savedId) callPeer(extractId(savedId));
    }
  });

  peer.on('call', incomingCall => {
    incomingCall.answer(localStream);
    handleCall(incomingCall);
  });

  peer.on('error', err => {
    if (err.type === 'peer-unavailable' && roomCode && !activeCall) {
      // Partner not online yet — retry every 5 seconds
      setStatus('Waiting for partner...');
      setTimeout(() => { if (peer && !activeCall) connectToRoom(); }, 5000);
    } else if (err.type === 'unavailable-id') {
      // Fixed ID temporarily taken (e.g. reconnecting too fast) — reload clears it
      setStatus('Reconnecting...');
      setTimeout(() => location.reload(), 3000);
    } else {
      setStatus('Connection error: ' + err.type);
    }
  });
});

// ── Share Link ────────────────────────────────────────────────────────────────

$('share-btn').addEventListener('click', () => {
  const id = myIdText.textContent;
  // Share with ?lang=es so the other person (Spanish speaker) auto-sets their language
  const url = `${location.origin}${location.pathname}?room=${id}&lang=es`;

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

function connectToRoom() {
  if (!peer || !localStream || activeCall) return;
  const theirLang = cfg.myLanguage === 'en' ? 'es' : 'en';
  const theirPeerId = `vct-${roomCode}-${theirLang}`;
  setStatus('Calling partner...');
  const outCall = peer.call(theirPeerId, localStream);
  if (outCall) handleCall(outCall);
}

$('cancel-room-btn').addEventListener('click', endCall);

// ── Handle Call ───────────────────────────────────────────────────────────────

function handleCall(call) {
  if (activeCall) { call.close(); return; } // already in a call
  activeCall = call;

  call.on('stream', remoteStream => {
    remoteVideo.srcObject = remoteStream;

    panelShare.classList.add('hidden');
    panelRoom.classList.add('hidden');
    panelCall.classList.remove('hidden');
    setStatus('Connected ✓');

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
  panelRoom.classList.add('hidden');
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

  const CHUNK_MS = 2000; // 2s chunks — shorter = less lag

  function restartRecording() {
    if (!mediaRecorder || !activeCall) return;
    mediaRecorder.start();
    setTimeout(() => { if (mediaRecorder?.state === 'recording') mediaRecorder.stop(); }, CHUNK_MS);
  }

  // Process every 2 seconds — start next recording immediately so capture
  // overlaps with API calls instead of waiting for them to finish
  mediaRecorder.onstop = async () => {
    const capturedChunks = [...audioChunks];
    audioChunks = [];

    // Start next recording right away — don't wait for processing
    restartRecording();

    if (capturedChunks.length === 0 || translating) return;
    const blob = new Blob(capturedChunks, { type: mimeType });
    translating = true;

    try {
      await processChunk(blob, theirLang, myLang);
    } finally {
      translating = false;
    }
  };

  // Start the recording loop
  audioChunks = [];
  restartRecording();
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
  if (!translation) { setStatus('⚠ Translation failed'); return; }

  showTranslated(translation);
  setStatus('Speaking...');

  // 3. Synthesize with ElevenLabs and play
  const audioUrl = await synthesize(translation, myLang);
  if (!audioUrl) { setStatus('⚠ Audio failed'); return; }
  await playAudio(audioUrl);

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
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const msg = err?.error?.message || resp.statusText;
      setStatus(`⚠ OpenAI ${resp.status}: ${msg.slice(0, 60)}`);
      console.error('Translate error:', resp.status, err);
      return '';
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error('Translate error:', e);
    setStatus('⚠ Translate network error');
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
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('ElevenLabs error:', resp.status, errText);
      setStatus('⚠ Audio error ' + resp.status);
      return null;
    }
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  } catch (e) {
    console.error('Synthesize error:', e);
    return null;
  }
}

// ── Audio Playback (AudioContext for iOS compatibility) ───────────────────────

async function playAudio(url) {
  if (audioCtx) {
    try {
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const resp = await fetch(url);
      const arrayBuffer = await resp.arrayBuffer();
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      URL.revokeObjectURL(url);
      return new Promise(resolve => {
        const src = audioCtx.createBufferSource();
        src.buffer = decoded;
        src.connect(audioCtx.destination);
        src.onended = resolve;
        src.start(0);
      });
    } catch(e) {
      console.error('AudioContext playback error:', e);
      URL.revokeObjectURL(url);
      return;
    }
  }
  // Fallback (non-iOS)
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
