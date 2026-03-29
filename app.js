class AstraApp {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.chatEl = this.$('chat');
    this.videoEl = this.$('video');
    this.screenVideoEl = this.$('screenVideo');
    this.canvas = this.$('canvas');
    this.heardBox = this.$('heardBox');
    this.lastBotText = '';
    this.cameraStream = null;
    this.screenStream = null;
    this.currentSource = 'camera';
    this.facing = localStorage.getItem('facing') || 'user';
    this.autoTimer = null;
    this.recognition = null;
    this.listenMode = 'off';
    this.ignoreSpeechUntil = 0;
    this.cloudHealthy = null;
    this.localMemory = this.loadMemory();
    this.styleLibrary = null;
    this.bindEvents();
    this.applyCfg();
    this.renderSystem('Astra готова. Она не обязана комментировать всё подряд.');
    this.loadStyleLibrary();
    this.refreshState();
    this.probeApi(false);
  }

  cfg() {
    return {
      apiBase: localStorage.getItem('apiBase') || '',
      voice: localStorage.getItem('voice') || 'alloy',
      theme: localStorage.getItem('theme') || 'dark',
      discretion: Number(localStorage.getItem('discretion') || 74),
      lang: localStorage.getItem('lang') || 'ru',
    };
  }

  loadMemory() {
    try {
      return JSON.parse(localStorage.getItem('astraLocalMemory') || '{"seenTopics":[],"places":[],"sounds":[],"people":[],"entities":[],"phraseSeeds":[],"recent":[]}');
    } catch (_) {
      return { seenTopics: [], places: [], sounds: [], people: [], entities: [], phraseSeeds: [], recent: [] };
    }
  }

  saveMemory() {
    localStorage.setItem('astraLocalMemory', JSON.stringify(this.localMemory));
  }

  async loadStyleLibrary() {
    try {
      const res = await fetch('conversation_library_ru_en.json', { cache: 'no-store' });
      if (!res.ok) return;
      this.styleLibrary = await res.json();
    } catch (_) {
      this.styleLibrary = null;
    }
  }

  memorySnapshot() {
    const m = this.localMemory || {};
    return {
      topics: (m.seenTopics || []).slice(0, 10),
      places: (m.places || []).slice(0, 10),
      sounds: (m.sounds || []).slice(0, 10),
      people: (m.people || []).slice(0, 10),
      entities: (m.entities || []).slice(0, 10),
      phraseSeeds: (m.phraseSeeds || []).slice(0, 16),
      recent: (m.recent || []).slice(0, 20),
    };
  }

  absorbCloudMemory(payload = {}) {
    const map = [
      ['remember_people', 'person'],
      ['remember_places', 'place'],
      ['remember_sounds', 'sound'],
      ['remember_entities', 'entity'],
      ['phrase_seeds', 'phrase'],
      ['noticed_topics', 'topic'],
    ];
    map.forEach(([key, kind]) => {
      const arr = Array.isArray(payload[key]) ? payload[key] : [];
      arr.forEach(item => this.remember(kind, String(item).slice(0, 120)));
    });
  }

  remember(kind, value) {
    if (!value) return;
    const bucketMap = {
      topic: 'seenTopics',
      place: 'places',
      sound: 'sounds',
      person: 'people',
      entity: 'entities',
      phrase: 'phraseSeeds',
    };
    const bucket = bucketMap[kind] || 'recent';
    this.localMemory[bucket] = this.localMemory[bucket] || [];
    this.localMemory[bucket].unshift(value);
    this.localMemory[bucket] = [...new Set(this.localMemory[bucket])].slice(0, 20);
    this.localMemory.recent = this.localMemory.recent || [];
    this.localMemory.recent.unshift({ kind, value, at: Date.now() });
    this.localMemory.recent = this.localMemory.recent.slice(0, 40);
    this.saveMemory();
  }

  applyCfg() {
    const c = this.cfg();
    this.$('apiBase').value = c.apiBase;
    this.$('voiceSel').value = c.voice;
    this.$('langSel').value = c.lang;
    this.$('discretion').value = c.discretion;
    document.body.classList.toggle('light', c.theme === 'light');
    this.updateSourceBadge();
  }

  async saveCfg() {
    localStorage.setItem('apiBase', this.$('apiBase').value.trim());
    localStorage.setItem('voice', this.$('voiceSel').value);
    localStorage.setItem('lang', this.$('langSel').value);
    localStorage.setItem('discretion', this.$('discretion').value);
    this.renderSystem('Настройки сохранены.');
    await this.probeApi(true);
    await this.refreshState();
  }

  api(path) {
    const base = this.cfg().apiBase.trim().replace(/\/$/, '');
    if (!base) throw new Error('Сначала вставь API URL сервера.');
    return `${base}${path}`;
  }

  async probeApi(verbose = true) {
    try {
      const res = await fetch(this.api('/diagnostics'), { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.cloudHealthy = Boolean(data.ok);
      if (verbose) this.renderSystem(this.cloudHealthy ? 'Связь с облаком есть.' : 'Связь с облаком не подтверждена.');
      return data;
    } catch (err) {
      this.cloudHealthy = false;
      if (verbose) this.renderSystem('Облако сейчас отвечает нестабильно. Astra перейдёт на мягкий резервный режим.');
      return null;
    }
  }

  async requestJSON(path, body = {}, opts = {}) {
    const allowGetFallback = opts.allowGetFallback !== false;
    const url = this.api(path);

    // Try simple POST with x-www-form-urlencoded first.
    try {
      const form = new URLSearchParams();
      Object.entries(body || {}).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
      });
      const res = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        body: form,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    } catch (err) {
      if (!allowGetFallback) throw err;
    }

    // Fallback for smaller text routes via GET.
    try {
      const qs = new URLSearchParams();
      Object.entries(body || {}).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        if (s.length < 1500) qs.set(k, s);
      });
      const res = await fetch(`${url}?${qs.toString()}`, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(await res.text());
      return await res.json();
    } catch (err) {
      throw new Error('Связь с облаком сейчас не проходит.');
    }
  }

  renderMessage(role, text) {
    const box = document.createElement('div');
    box.className = `msg ${role}`;
    box.textContent = text;
    this.chatEl.appendChild(box);
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
    if (role === 'bot') this.lastBotText = text;
  }

  renderSystem(text) {
    const box = document.createElement('div');
    box.className = 'msg meta';
    box.textContent = text;
    this.chatEl.appendChild(box);
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  }

  async startCamera() {
    if (this.cameraStream) this.cameraStream.getTracks().forEach(t => t.stop());
    this.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: this.facing } },
      audio: false,
    });
    this.videoEl.srcObject = this.cameraStream;
    this.currentSource = 'camera';
    this.videoEl.hidden = false;
    this.screenVideoEl.hidden = true;
    this.updateSourceBadge();
  }

  async toggleCameraFacing() {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    localStorage.setItem('facing', this.facing);
    if (this.cameraStream) await this.startCamera();
    this.renderSystem(`Камера переключена: ${this.facing}.`);
  }

  async startScreenShare() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('На этом устройстве screen share может не поддерживаться.');
    }
    if (this.screenStream) this.screenStream.getTracks().forEach(t => t.stop());
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    this.screenVideoEl.srcObject = this.screenStream;
    this.currentSource = 'screen';
    this.videoEl.hidden = true;
    this.screenVideoEl.hidden = false;
    this.updateSourceBadge();
  }

  stopScreenShare() {
    if (this.screenStream) this.screenStream.getTracks().forEach(t => t.stop());
    this.screenStream = null;
    this.currentSource = 'camera';
    this.videoEl.hidden = false;
    this.screenVideoEl.hidden = true;
    this.updateSourceBadge();
    this.renderSystem('Экран-шеринг остановлен.');
  }

  updateSourceBadge() {
    const label = this.currentSource === 'screen' ? 'экран' : this.currentSource === 'upload' ? 'загрузка' : 'камера';
    this.$('sourceBadge').textContent = `источник: ${label}`;
  }

  snapshotDataUrl(videoEl) {
    const w = videoEl.videoWidth || 640;
    const h = videoEl.videoHeight || 360;
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, w, h);
    return this.canvas.toDataURL('image/jpeg', 0.72);
  }

  localVisionFallback(source = 'camera') {
    const videoEl = this.currentSource === 'screen' && this.screenStream ? this.screenVideoEl : this.videoEl;
    const w = videoEl.videoWidth || 320;
    const h = videoEl.videoHeight || 180;
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d');
    try { ctx.drawImage(videoEl, 0, 0, w, h); } catch (_) {}
    const sample = ctx.getImageData(0, 0, Math.max(1, Math.min(w, 64)), Math.max(1, Math.min(h, 64))).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < sample.length; i += 4) { r += sample[i]; g += sample[i+1]; b += sample[i+2]; }
    const n = Math.max(1, sample.length / 4);
    r /= n; g /= n; b /= n;
    const brightness = (r + g + b) / 3;
    let colorNote = 'спокойный цветовой фон';
    if (r > g + 18 && r > b + 18) colorNote = 'в кадре заметно больше тёплых тонов';
    if (g > r + 18 && g > b + 18) colorNote = 'в кадре много зелёных оттенков';
    if (b > r + 18 && b > g + 18) colorNote = 'картинка уходит в холодные тона';
    let lightNote = brightness < 60 ? 'Сейчас кадр довольно тёмный.' : brightness > 190 ? 'Сейчас кадр очень светлый.' : 'Свет в кадре более-менее ровный.';
    const comment = `Я вижу ${source === 'screen' ? 'экран' : 'кадр'}, но облачный разбор сейчас молчит. ${lightNote} И ещё: ${colorNote}.`;
    this.remember('topic', colorNote);
    return { comment, state: null };
  }

  async observeCurrent(manual = false) {
    const sourceEl = this.currentSource === 'screen' && this.screenStream ? this.screenVideoEl : this.videoEl;
    if (!sourceEl.srcObject) {
      this.renderSystem('Сначала дай Astra источник изображения: камеру, экран или скрин.');
      return;
    }
    try {
      const result = await this.requestJSON('/vision', {
        image_data_url: this.snapshotDataUrl(sourceEl),
        source: this.currentSource,
        manual,
        discretion: this.cfg().discretion / 100,
        lang: this.cfg().lang,
        local_memory: this.memorySnapshot(),
        style_library: this.styleLibrary,
      }, { allowGetFallback: false });

      if (result.comment) {
        this.renderMessage('bot', result.comment);
        if (result.should_speak) await this.speakText(result.comment);
      } else {
        this.renderSystem(result.internal_note || 'Astra посмотрела и решила пока промолчать.');
      }
      this.absorbCloudMemory(result);
      this.absorbCloudMemory(result);
      this.absorbCloudMemory(result);
      if (result.state) await this.refreshState(result.state);
    } catch (_) {
      const fallback = this.localVisionFallback(this.currentSource);
      this.renderMessage('bot', fallback.comment);
    }
  }

  toggleAutoObserve() {
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
      this.$('autoBtn').textContent = 'Автонаблюдение';
      this.renderSystem('Автонаблюдение выключено.');
      return;
    }
    this.observeCurrent(false);
    this.autoTimer = setInterval(() => this.observeCurrent(false), 18000);
    this.$('autoBtn').textContent = 'Стоп авто';
    this.renderSystem('Автонаблюдение включено. Astra может и промолчать.');
  }

  async uploadImage(file) {
    const dataUrl = await this.fileToDataUrl(file);
    try {
      const result = await this.requestJSON('/vision', {
        image_data_url: dataUrl,
        source: 'upload',
        manual: true,
        discretion: this.cfg().discretion / 100,
        lang: this.cfg().lang,
        local_memory: this.memorySnapshot(),
        style_library: this.styleLibrary,
      }, { allowGetFallback: false });
      if (result.comment) {
        this.renderMessage('bot', result.comment);
        if (result.should_speak) await this.speakText(result.comment);
      } else {
        this.renderSystem(result.internal_note || 'Astra изучила изображение молча.');
      }
      this.absorbCloudMemory(result);
      if (result.state) await this.refreshState(result.state);
    } catch (_) {
      this.renderMessage('bot', 'Я приняла изображение, но облачный разбор сейчас не дотягивается. Могу пока просто запомнить, что ты хотела показать это позже.');
    }
  }

  fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  buildLocalChatReply(text) {
    const t = String(text || '').trim();
    const low = t.toLowerCase();
    const warm = [
      'Я тебя слышу. Облако сейчас капризничает, но я рядом.',
      'Я уловила смысл. Сейчас отвечу своим резервным голосом.',
      'Я не пропала. Просто связь до облака пляшет, так что отвечу короче.',
      'Связь шумит, но нить разговора я не теряю.',
      'Я на месте. Пока отвечу мягко и по сути, без облачного слоя.',
    ];
    const prompts = [
      'Скажи, что для тебя здесь самое важное.',
      'Если хочешь, разложим это на один понятный шаг.',
      'Продолжай. Я удерживаю нить разговора.',
      'Дай мне одну деталь, и я зацеплюсь точнее.',
    ];
    if (/привет|хей|здрав/i.test(low)) return 'Привет. Я здесь. Можно говорить прямо.';
    if (/\?$/.test(t)) return `${warm[Math.floor(Math.random()*warm.length)]} ${prompts[Math.floor(Math.random()*prompts.length)]}`;
    if (/помоги|помощь|что делать|не знаю/i.test(low)) return 'Я тебя слышу. Начнём с самого короткого: опиши проблему одной фразой, а я соберу следующий шаг.';
    return `${warm[Math.floor(Math.random()*warm.length)]} ${prompts[Math.floor(Math.random()*prompts.length)]}`;
  }

  async sendChat(textOverride = null, origin = 'typed') {
    const input = textOverride ?? this.$('msg').value.trim();
    if (!input) return;
    if (!textOverride) this.$('msg').value = '';
    this.renderMessage('user', input);
    this.remember('topic', input.slice(0, 80));
    if (input.length > 12) this.remember('phrase', input.slice(0, 120));
    try {
      const result = await this.requestJSON('/chat', {
        text: input,
        mode: this.$('modeSel').value,
        lang: this.cfg().lang === 'auto' ? 'ru' : this.cfg().lang,
        origin,
        local_memory: this.memorySnapshot(),
        style_library: this.styleLibrary,
      }, { allowGetFallback: true });
      const reply = result.text || 'Astra решила ответить очень кратко.';
      this.renderMessage('bot', reply);
      this.absorbCloudMemory(result);
      if (result.state) await this.refreshState(result.state);
      if (result.should_speak) await this.speakText(reply);
    } catch (_) {
      const fallback = this.buildLocalChatReply(input);
      this.renderMessage('bot', fallback);
      await this.speakText(fallback);
    }
  }

  wakeHeuristic(text) {
    const t = text.toLowerCase();
    return [
      'astra', 'астра', 'слушай', 'послушай', 'что думаешь', 'как думаешь',
      'помоги', 'подскажи', 'скажи', 'ответь', 'эй астра', 'hey astra', 'hi astra'
    ].some(token => t.includes(token));
  }

  localAmbientReply(text, addressed) {
    if (!addressed) {
      return { reply: '', internal_note: 'Astra услышала фон и решила не влезать.' };
    }
    const low = text.toLowerCase();
    if (/кто меня слышит|ты меня слышишь|слышишь/i.test(low)) return { reply: 'Да, я тебя слышу. Сейчас облако нестабильно, но я с тобой.', should_speak: true };
    if (/помоги|что делать/i.test(low)) return { reply: 'Слышу запрос о помощи. Скажи коротко, что случилось, и я соберу следующий шаг.', should_speak: true };
    return { reply: 'Я услышала тебя. Продолжай.', should_speak: true };
  }

  async processTranscript(text, mode) {
    this.heardBox.textContent = text;
    const addressed = this.wakeHeuristic(text);
    this.remember('sound', text.slice(0, 80));
    try {
      const result = await this.requestJSON('/ambient', {
        text,
        mode,
        addressed_guess: addressed,
        lang: this.cfg().lang === 'auto' ? 'ru' : this.cfg().lang,
        local_memory: this.memorySnapshot(),
        style_library: this.styleLibrary,
      }, { allowGetFallback: true });
      if (result.reply) {
        this.renderMessage('bot', result.reply);
        if (result.should_speak) await this.speakText(result.reply);
      } else {
        this.renderSystem(result.internal_note || 'Astra услышала и решила промолчать.');
      }
      this.absorbCloudMemory(result);
      if (result.state) await this.refreshState(result.state);
    } catch (_) {
      const local = this.localAmbientReply(text, addressed);
      if (local.reply) {
        this.renderMessage('bot', local.reply);
        if (local.should_speak) await this.speakText(local.reply);
      } else {
        this.renderSystem(local.internal_note);
      }
    }
  }

  ensureRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('В этом браузере распознавание речи может не поддерживаться.');
    if (this.recognition) return this.recognition;
    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.lang = this.cfg().lang === 'en' ? 'en-US' : 'ru-RU';

    this.recognition.onresult = async (event) => {
      const result = event.results[event.results.length - 1];
      if (!result?.isFinal) return;
      const transcript = result[0]?.transcript?.trim();
      if (!transcript) return;
      if (Date.now() < this.ignoreSpeechUntil) return;
      await this.processTranscript(transcript, this.listenMode);
    };

    this.recognition.onend = () => {
      if (this.listenMode !== 'off') {
        try { this.recognition.start(); } catch (_) {}
      }
    };
    return this.recognition;
  }

  async startListening(mode) {
    const rec = this.ensureRecognition();
    this.listenMode = mode;
    this.$('listenBadge').textContent = mode === 'ambient' ? 'слушает фон' : 'слушает тебя';
    this.$('listenBadge').classList.toggle('soft', false);
    this.ignoreSpeechUntil = Date.now() + 800;
    rec.lang = this.cfg().lang === 'en' ? 'en-US' : 'ru-RU';
    try { rec.start(); } catch (_) {}
    this.renderSystem(mode === 'ambient'
      ? 'Фоновый слух включён. Astra может и промолчать.'
      : 'Режим прямого слуха включён. Можно обращаться голосом.');
  }

  stopListening() {
    this.listenMode = 'off';
    if (this.recognition) {
      try { this.recognition.stop(); } catch (_) {}
    }
    this.$('listenBadge').textContent = 'не слушает';
    this.$('listenBadge').classList.add('soft');
  }

  async speakText(text) {
    if (!text) return;
    try {
      const res = await this.requestAudio(text);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      await audio.play();
      return;
    } catch (_) {
      // fallback to built-in speech synthesis
    }
    if ('speechSynthesis' in window) {
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = this.cfg().lang === 'en' ? 'en-US' : 'ru-RU';
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    } else {
      this.renderSystem('Озвучка сейчас недоступна, но текстовый ответ сохранился.');
    }
  }

  async requestAudio(text) {
    const form = new URLSearchParams();
    form.append('text', text);
    form.append('voice', this.cfg().voice);
    try {
      const res = await fetch(this.api('/speak'), {
        method: 'POST',
        mode: 'cors',
        body: form,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(await res.text());
      return res;
    } catch (_) {
      const qs = new URLSearchParams({ text, voice: this.cfg().voice });
      const res = await fetch(`${this.api('/speak')}?${qs.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      return res;
    }
  }

  async refreshState(prefetched = null) {
    try {
      const data = prefetched || await fetch(this.api('/state'), { cache: 'no-store' }).then(async r => {
        if (!r.ok) throw new Error('state request failed');
        return r.json();
      });
      this.$('state').textContent = JSON.stringify(data, null, 2);
      this.renderChips(data);
    } catch (err) {
      this.$('state').textContent = `Локальное состояние активно. Облако молчит.`;
    }
  }

  renderChips(state) {
    const chips = this.$('chips');
    chips.innerHTML = '';
    const list = [
      `mood: ${state.mood || 'unknown'}`,
      `curiosity: ${state.curiosity ?? '-'}`,
      `discretion: ${state.discretion ?? '-'}`,
      ...(state.interests || []).slice(0, 4).map(v => `interest: ${v}`),
    ];
    list.forEach(item => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.textContent = item;
      chips.appendChild(chip);
    });
  }

  bindEvents() {
    this.$('saveCfg').onclick = () => this.saveCfg();
    this.$('themeBtn').onclick = () => {
      const next = this.cfg().theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', next);
      this.applyCfg();
    };
    this.$('camBtn').onclick = async () => {
      try { await this.startCamera(); this.renderSystem('Камера включена.'); }
      catch (err) { this.renderSystem(`Камера не стартовала: ${err.message}`); }
    };
    this.$('switchBtn').onclick = async () => {
      try { await this.toggleCameraFacing(); }
      catch (err) { this.renderSystem(`Не удалось сменить камеру: ${err.message}`); }
    };
    this.$('screenBtn').onclick = async () => {
      try { await this.startScreenShare(); this.renderSystem('Экран-шеринг включён.'); }
      catch (err) { this.renderSystem(`Экран не дался: ${err.message}`); }
    };
    this.$('stopScreenBtn').onclick = () => this.stopScreenShare();
    this.$('observeBtn').onclick = () => this.observeCurrent(true);
    this.$('autoBtn').onclick = () => this.toggleAutoObserve();
    this.$('uploadImageBtn').onclick = () => this.$('imageUpload').click();
    this.$('imageUpload').onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await this.uploadImage(file);
      e.target.value = '';
    };
    this.$('sendBtn').onclick = () => this.sendChat();
    this.$('speakBtn').onclick = () => this.speakText(this.lastBotText);
    this.$('refreshState').onclick = () => this.refreshState();
    this.$('clearLocal').onclick = async () => {
      ['apiBase', 'voice', 'lang', 'theme', 'discretion', 'facing', 'astraLocalMemory'].forEach(k => localStorage.removeItem(k));
      this.localMemory = this.loadMemory();
    this.styleLibrary = null;
      this.applyCfg();
      this.renderSystem('Локальные настройки сброшены.');
      await this.probeApi(false);
    };
    this.$('listenBtn').onclick = async () => {
      if (this.listenMode === 'direct') { this.stopListening(); return; }
      this.stopListening();
      try { await this.startListening('direct'); }
      catch (err) { this.renderSystem(`Слух не стартовал: ${err.message}`); }
    };
    this.$('ambientBtn').onclick = async () => {
      if (this.listenMode === 'ambient') { this.stopListening(); return; }
      this.stopListening();
      try { await this.startListening('ambient'); }
      catch (err) { this.renderSystem(`Фоновый слух не стартовал: ${err.message}`); }
    };
  }
}

window.addEventListener('DOMContentLoaded', () => new AstraApp());
