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
    this.bindEvents();
    this.applyCfg();
    this.renderSystem('Astra готова. Она не обязана комментировать всё подряд.');
    this.refreshState();
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

  applyCfg() {
    const c = this.cfg();
    this.$('apiBase').value = c.apiBase;
    this.$('voiceSel').value = c.voice;
    this.$('langSel').value = c.lang;
    this.$('discretion').value = c.discretion;
    document.body.classList.toggle('light', c.theme === 'light');
    this.updateSourceBadge();
  }

  saveCfg() {
    localStorage.setItem('apiBase', this.$('apiBase').value.trim());
    localStorage.setItem('voice', this.$('voiceSel').value);
    localStorage.setItem('lang', this.$('langSel').value);
    localStorage.setItem('discretion', this.$('discretion').value);
    this.renderSystem('Настройки сохранены.');
  }

  api(path) {
    const base = this.cfg().apiBase.trim().replace(/\/$/, '');
    if (!base) throw new Error('Сначала вставь API URL сервера.');
    return `${base}${path}`;
  }

  async postJSON(path, body) {
    const res = await fetch(this.api(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
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
    const [track] = this.screenStream.getVideoTracks();
    if (track) {
      track.onended = () => this.stopScreenShare();
    }
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
    const sourceName = this.currentSource === 'screen' ? 'экран' : 'камера';
    this.$('sourceBadge').textContent = `источник: ${sourceName}`;
  }

  snapshotDataUrl(sourceEl) {
    const w = sourceEl.videoWidth || 720;
    const h = sourceEl.videoHeight || 1280;
    this.canvas.width = w;
    this.canvas.height = h;
    const ctx = this.canvas.getContext('2d');
    ctx.drawImage(sourceEl, 0, 0, w, h);
    return this.canvas.toDataURL('image/jpeg', 0.92);
  }

  async observeCurrent(manual = false) {
    const sourceEl = this.currentSource === 'screen' && this.screenStream ? this.screenVideoEl : this.videoEl;
    if (!sourceEl.srcObject) {
      this.renderSystem('Сначала дай Astra источник изображения: камеру, экран или скрин.');
      return;
    }

    try {
      const result = await this.postJSON('/vision', {
        image_data_url: this.snapshotDataUrl(sourceEl),
        source: this.currentSource,
        manual,
        discretion: this.cfg().discretion / 100,
        lang: this.cfg().lang,
      });

      if (result.comment) {
        this.renderMessage('bot', result.comment);
      } else {
        this.renderSystem(result.internal_note || 'Astra посмотрела и решила пока промолчать.');
      }
      await this.refreshState(result.state);
    } catch (err) {
      this.renderMessage('bot', `Ошибка наблюдения: ${err.message}`);
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
    const result = await this.postJSON('/vision', {
      image_data_url: dataUrl,
      source: 'upload',
      manual: true,
      discretion: this.cfg().discretion / 100,
      lang: this.cfg().lang,
    });
    if (result.comment) this.renderMessage('bot', result.comment);
    else this.renderSystem(result.internal_note || 'Astra изучила изображение молча.');
    await this.refreshState(result.state);
  }

  fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });
  }

  async sendChat(textOverride = null, origin = 'typed') {
    const input = textOverride ?? this.$('msg').value.trim();
    if (!input) return;
    if (!textOverride) this.$('msg').value = '';
    this.renderMessage('user', input);
    try {
      const result = await this.postJSON('/chat', {
        text: input,
        mode: this.$('modeSel').value,
        lang: this.cfg().lang,
        origin,
      });
      if (result.text) this.renderMessage('bot', result.text);
      else this.renderSystem('Astra решила ответить очень кратко.');
      await this.refreshState(result.state);
      if (result.should_speak) await this.speakText(result.text);
    } catch (err) {
      this.renderMessage('bot', `Ошибка чата: ${err.message}`);
    }
  }

  wakeHeuristic(text) {
    const t = text.toLowerCase();
    return [
      'astra', 'астра', 'lyra', 'лира',
      'слушай', 'послушай', 'что думаешь', 'как думаешь',
      'помоги', 'подскажи', 'скажи', 'ответь', 'hey astra', 'hi astra'
    ].some(token => t.includes(token));
  }

  async processTranscript(text, mode) {
    this.heardBox.textContent = text;
    const addressed = this.wakeHeuristic(text);
    try {
      const result = await this.postJSON('/ambient', {
        text,
        mode,
        addressed_guess: addressed,
        lang: this.cfg().lang,
      });
      if (result.reply) {
        this.renderMessage('bot', result.reply);
        if (result.should_speak) await this.speakText(result.reply);
      } else {
        this.renderSystem(result.internal_note || 'Astra услышала и решила промолчать.');
      }
      await this.refreshState(result.state);
    } catch (err) {
      this.renderSystem(`Ошибка слуха: ${err.message}`);
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
        try {
          this.recognition.start();
        } catch (_) {
          // ignore rapid restart issue
        }
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
      ? 'Фоновый слух включён. Astra чаще молчит.'
      : 'Режим прямого слуха включён. Можно обращаться голосом.');
  }

  stopListening() {
    this.listenMode = 'off';
    if (this.recognition) {
      try { this.recognition.onend = null; this.recognition.stop(); } catch (_) {}
      this.recognition = null;
    }
    this.$('listenBadge').textContent = 'не слушает';
    this.$('listenBadge').classList.add('soft');
  }

  async speakText(text) {
    if (!text) return;
    try {
      const res = await fetch(this.api('/speak'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: this.cfg().voice }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      await audio.play();
    } catch (err) {
      this.renderSystem(`Озвучка не сработала: ${err.message}`);
    }
  }

  async refreshState(prefetched = null) {
    try {
      const data = prefetched || await fetch(this.api('/state')).then(r => {
        if (!r.ok) throw new Error('state request failed');
        return r.json();
      });
      this.$('state').textContent = JSON.stringify(data, null, 2);
      this.renderChips(data);
    } catch (err) {
      this.$('state').textContent = `Пока нет состояния: ${err.message}`;
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
    this.$('clearLocal').onclick = () => {
      ['apiBase', 'voice', 'lang', 'theme', 'discretion', 'facing'].forEach(k => localStorage.removeItem(k));
      this.applyCfg();
      this.renderSystem('Локальные настройки сброшены.');
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
