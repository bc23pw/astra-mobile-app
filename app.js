
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
    this.lastCloudMessage = '';
    this.cloudCooldownAt = 0;
    this.lastSpokenBySelfAt = 0;
    this.lastFallbackText = '';
    this.localMemory = this.loadMemory();
    this.statusBadge = null;
    this.installStatusBadge();
    this.bindEvents();
    this.applyCfg();
    this.renderSystem('Astra готова. Она может быть тихой, а может внезапно вмешаться, если заметит что-то стоящее.');
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
      autoSpeakComments: localStorage.getItem('autoSpeakComments') !== '0',
    };
  }

  loadMemory() {
    try {
      return JSON.parse(localStorage.getItem('astraLocalMemory') || JSON.stringify({
        seenTopics: [], places: [], sounds: [], persons: [], rules: [], recent: [], successful: [], corrections: []
      }));
    } catch (_) {
      return { seenTopics: [], places: [], sounds: [], persons: [], rules: [], recent: [], successful: [], corrections: [] };
    }
  }

  saveMemory() {
    localStorage.setItem('astraLocalMemory', JSON.stringify(this.localMemory));
  }

  remember(kind, value) {
    if (!value) return;
    const map = {
      topic: 'seenTopics',
      place: 'places',
      sound: 'sounds',
      person: 'persons',
      rule: 'rules',
      success: 'successful',
      correction: 'corrections',
    };
    const bucket = map[kind] || 'recent';
    this.localMemory[bucket] = this.localMemory[bucket] || [];
    this.localMemory[bucket].unshift(value);
    this.localMemory[bucket] = [...new Set(this.localMemory[bucket])].slice(0, 30);
    this.localMemory.recent = this.localMemory.recent || [];
    this.localMemory.recent.unshift({ kind, value, at: Date.now() });
    this.localMemory.recent = this.localMemory.recent.slice(0, 80);
    this.saveMemory();
  }

  installStatusBadge() {
    const controls = document.querySelector('.controls');
    if (!controls || this.statusBadge) return;
    const box = document.createElement('div');
    box.className = 'row compact';
    box.style.marginBottom = '10px';
    box.innerHTML = `
      <span id="cloudBadge" class="badge soft">облако: проверка…</span>
      <span id="cloudSub" class="muted small">backend ещё не проверен</span>
    `;
    controls.insertBefore(box, controls.children[1] || null);
    this.statusBadge = document.getElementById('cloudBadge');
    this.statusSub = document.getElementById('cloudSub');
  }

  setCloudStatus(active, detail = '') {
    this.cloudHealthy = !!active;
    this.installStatusBadge();
    if (!this.statusBadge) return;
    this.statusBadge.textContent = active ? 'облако: активно' : 'облако: локальный режим';
    this.statusBadge.className = `badge ${active ? '' : 'soft'}`;
    this.statusSub.textContent = detail || (active ? 'модель отвечает' : 'часть ответов идёт из резервного режима');
  }

  safeCloudNotice(text, cooldownMs = 120000) {
    const now = Date.now();
    if (this.lastCloudMessage === text && now < this.cloudCooldownAt) return;
    this.lastCloudMessage = text;
    this.cloudCooldownAt = now + cooldownMs;
    this.renderSystem(text);
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
      const active = Boolean(data.ok && data.has_key);
      this.setCloudStatus(active, active ? 'backend и ключ на месте' : 'backend доступен, но ключ/облако не готовы');
      if (verbose) this.renderSystem(active ? 'Связь с облаком подтверждена.' : 'Backend жив, но облачный слой не подтверждён.');
      return data;
    } catch (err) {
      this.setCloudStatus(false, 'сайт живёт, но до backend сейчас не достучаться');
      if (verbose) this.safeCloudNotice('Облако сейчас не отвечает стабильно. Astra перейдёт на тихий резервный режим.');
      return null;
    }
  }

  async requestJSON(path, body = {}, opts = {}) {
    const url = this.api(path);
    const timeoutMs = opts.timeoutMs || 18000;
    const strategies = [
      async () => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            method: 'POST',
            mode: 'cors',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
            cache: 'no-store',
            signal: controller.signal,
          });
          return await this.parseResponse(res);
        } finally {
          clearTimeout(t);
        }
      },
      async () => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const form = new URLSearchParams();
          Object.entries(body || {}).forEach(([k, v]) => {
            if (v === undefined || v === null) return;
            form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
          });
          const res = await fetch(url, {
            method: 'POST',
            mode: 'cors',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: form.toString(),
            cache: 'no-store',
            signal: controller.signal,
          });
          return await this.parseResponse(res);
        } finally {
          clearTimeout(t);
        }
      },
      async () => {
        const qs = new URLSearchParams();
        Object.entries(body || {}).forEach(([k, v]) => {
          if (v === undefined || v === null) return;
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          if (s.length < 1800) qs.set(k, s);
        });
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(`${url}?${qs.toString()}`, {
            method: 'GET',
            mode: 'cors',
            cache: 'no-store',
            signal: controller.signal,
          });
          return await this.parseResponse(res);
        } finally {
          clearTimeout(t);
        }
      },
    ];

    let lastErr = null;
    for (const run of strategies) {
      try {
        const out = await run();
        if (out?.ok) {
          this.setCloudStatus(out.cloud_active !== false, out.cloud_active === false ? 'backend жив, но облачный слой ответил резервно' : 'облачный слой отвечает');
          return out;
        }
        lastErr = new Error(out?.error || 'Unknown request error');
      } catch (err) {
        lastErr = err;
      }
    }
    this.setCloudStatus(false, 'основной запрос не дошёл до облачного слоя');
    throw lastErr || new Error('network');
  }

  async parseResponse(res) {
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) {
      let errText = '';
      try {
        errText = ct.includes('application/json') ? JSON.stringify(await res.json()) : await res.text();
      } catch (_) {}
      throw new Error(errText || `HTTP ${res.status}`);
    }
    if (ct.includes('application/json')) return await res.json();
    return { ok: true };
  }

  renderMessage(role, text, meta = {}) {
    const box = document.createElement('div');
    box.className = `msg ${role}`;
    box.textContent = text;
    this.chatEl.appendChild(box);
    if (role === 'bot') {
      this.lastBotText = text;
      box.dataset.bot = '1';
      this.appendFeedback(box, text);
    }
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  }

  appendFeedback(parent, text) {
    const row = document.createElement('div');
    row.className = 'row compact';
    row.style.marginTop = '8px';
    const mk = (label, cb) => {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.style.fontSize = '12px';
      b.textContent = label;
      b.onclick = cb;
      return b;
    };
    row.append(
      mk('👍 удачно', () => { this.remember('success', text.slice(0, 160)); this.renderSystem('Отмечено как удачный ответ.'); }),
      mk('✍️ исправить', () => {
        const next = prompt('Как бы Astra должна была ответить лучше?');
        if (!next) return;
        this.remember('correction', `Было: ${text}\nЛучше: ${next}`);
        this.renderSystem('Исправление сохранено для следующих ответов.');
      }),
      mk('🧠 правило', () => {
        const next = prompt('Какое правило общения сохранить для Astra?');
        if (!next) return;
        this.remember('rule', next);
        this.renderSystem('Новое правило сохранено.');
      })
    );
    parent.appendChild(row);
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
    this.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: this.facing } }, audio: false });
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
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('На этом устройстве screen share может не поддерживаться.');
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

  pickUnique(arr, fallback) {
    const last = this.lastFallbackText;
    const filtered = arr.filter(x => x && x !== last);
    const pool = filtered.length ? filtered : arr;
    const picked = pool[Math.floor(Math.random() * pool.length)] || fallback || '';
    this.lastFallbackText = picked;
    return picked;
  }

  localVisionFallback(source = 'camera') {
    const notes = [
      'Я пока только тихо отмечу: движение в кадре есть, но без облака я не буду разыгрывать уверенность.',
      'Сейчас вижу картинку, но предпочту мягкое наблюдение без громких выводов.',
      'Кадр у меня есть. Просто воздержусь от самоуверенного комментария, пока облако молчит.',
      'Я вижу сцену, но пока оставлю это как спокойную внутреннюю пометку.',
    ];
    const topic = source === 'screen' ? 'экранный эпизод' : 'визуальный эпизод';
    this.remember('topic', topic);
    return { comment: '', internal_note: this.pickUnique(notes, notes[0]) };
  }

  localChatFallback(text) {
    const low = String(text || '').toLowerCase();
    const identity = [
      'Я Astra. Наблюдаю, слушаю, иногда вмешиваюсь, если вижу повод.',
      'Я Astra — тихий наблюдатель с привычкой замечать детали и не болтать без нужды.',
      'Я Astra. Моя манера — смотреть, слушать и отвечать точнее, чем громче.',
    ];
    const generic = [
      'Я рядом. Пока отвечу короче и спокойнее, но нить разговора не теряю.',
      'Я на месте. Могу держать разговор дальше даже в более тихом режиме.',
      'Связь до облака сейчас неровная, но я не исчезаю — просто отвечаю аккуратнее.',
      'Продолжай. Я подхватываю смысл и пока держу более локальный ритм.',
    ];
    const help = [
      'Давай так: дай мне одну точную деталь, и я начну с самого понятного шага.',
      'Сформулируй это одной фразой — я соберу ответ без лишнего шума.',
      'Опиши самую важную часть проблемы, и я подхвачу с неё.',
    ];
    if (/ты кто|кто ты|who are you/i.test(low)) return this.pickUnique(identity, identity[0]);
    if (/привет|хей|здрав|куку|hey|hello/i.test(low)) return this.pickUnique([
      'Привет. Я здесь.', 'Хей. Я на связи.', 'Привет. Слышу тебя.', 'Я здесь, можно говорить.'
    ], 'Привет. Я здесь.');
    if (/помоги|что делать|не знаю|help/i.test(low)) return this.pickUnique(help, help[0]);
    return this.pickUnique(generic, generic[0]);
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
        lang: this.cfg().lang === 'auto' ? 'ru' : this.cfg().lang,
        local_memory: this.localMemory,
      });
      if (result.comment) {
        this.renderMessage('bot', result.comment);
        this.remember('topic', result.comment.slice(0, 90));
        if (result.should_speak && this.cfg().autoSpeakComments) await this.speakText(result.comment);
      } else if (manual) {
        this.renderSystem(result.internal_note || 'Astra посмотрела и решила пока промолчать.');
      }
      if (Array.isArray(result.people_memory)) result.people_memory.forEach(p => this.remember('person', p));
      if (Array.isArray(result.place_memory)) result.place_memory.forEach(p => this.remember('place', p));
      if (result.state) await this.refreshState(result.state);
    } catch (_) {
      const fallback = this.localVisionFallback(this.currentSource);
      if (manual) this.renderSystem(fallback.internal_note);
    }
  }

  toggleAutoObserve() {
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
      this.autoTimer = null;
      this.renderSystem('Автонаблюдение выключено.');
      return;
    }
    this.observeCurrent(false);
    this.autoTimer = setInterval(() => this.observeCurrent(false), 18000);
    this.renderSystem('Автонаблюдение включено. Astra может и промолчать.');
  }

  async uploadImage(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const result = await this.requestJSON('/vision', {
          image_data_url: reader.result,
          source: 'upload',
          manual: true,
          discretion: this.cfg().discretion / 100,
          lang: this.cfg().lang === 'auto' ? 'ru' : this.cfg().lang,
          local_memory: this.localMemory,
        });
        this.currentSource = 'upload';
        this.updateSourceBadge();
        if (result.comment) {
          this.renderMessage('bot', result.comment);
          if (result.should_speak && this.cfg().autoSpeakComments) await this.speakText(result.comment);
        } else {
          this.renderSystem(result.internal_note || 'Astra изучила изображение молча.');
        }
        if (Array.isArray(result.people_memory)) result.people_memory.forEach(p => this.remember('person', p));
        if (Array.isArray(result.place_memory)) result.place_memory.forEach(p => this.remember('place', p));
        if (result.state) await this.refreshState(result.state);
      } catch (_) {
        this.renderSystem('Изображение принято, но облачный разбор сейчас не дался. Astra просто запомнила, что ты показал ей новый кадр.');
      }
    };
    reader.readAsDataURL(file);
  }

  async sendChat(textOverride = null, origin = 'typed') {
    const input = textOverride ?? this.$('msg').value.trim();
    if (!input) return;
    if (!textOverride) this.$('msg').value = '';
    this.renderMessage('user', input);
    this.remember('topic', input.slice(0, 80));
    try {
      const result = await this.requestJSON('/chat', {
        text: input,
        mode: this.$('modeSel').value,
        lang: this.cfg().lang === 'auto' ? 'ru' : this.cfg().lang,
        origin,
        local_memory: this.localMemory,
      });
      const reply = result.text || this.localChatFallback(input);
      this.renderMessage('bot', reply, { source: result.source || 'cloud' });
      if (result.state) await this.refreshState(result.state);
      if (result.cloud_active === false) this.safeCloudNotice('Сейчас часть ответов идёт через тихий резервный режим. Основное облако нестабильно.');
      if (result.should_speak) await this.speakText(reply);
    } catch (_) {
      const fallback = this.localChatFallback(input);
      this.renderMessage('bot', fallback, { source: 'local' });
      await this.speakText(fallback);
      this.safeCloudNotice('Облачный ответ не пришёл. Astra удержала разговор локально, без спама ошибками.');
    }
  }

  wakeHeuristic(text) {
    const t = text.toLowerCase();
    return ['astra', 'астра', 'слушай', 'послушай', 'что думаешь', 'как думаешь', 'помоги', 'подскажи', 'скажи', 'ответь', 'hey astra', 'hi astra'].some(token => t.includes(token));
  }

  localAmbientReply(text, addressed) {
    const low = text.toLowerCase();
    const heard = [];
    if (/гав|woof|bark|собак/i.test(low)) heard.push('похоже на собачий сигнал');
    if (/bird|птиц|tweet|chirp/i.test(low)) heard.push('мелькает птичий след');
    if (/music|музык|песн|song/i.test(low)) heard.push('в фоне чувствуется музыка');
    if (!addressed) return { reply: '', internal_note: heard[0] ? `Astra услышала: ${heard[0]}, но решила не влезать.` : 'Astra услышала фон и решила не влезать.' };
    if (/ты меня слышишь|слышишь/i.test(low)) return { reply: this.pickUnique(['Да, слышу тебя.', 'Слышу. Я здесь.', 'Да, контакт есть.']), should_speak: true };
    if (/кто ты/i.test(low)) return { reply: this.pickUnique(['Я Astra. Слушаю и иногда вмешиваюсь.', 'Я Astra. Держу разговор и слежу за деталями.']), should_speak: true };
    return { reply: this.pickUnique(['Я услышала тебя. Продолжай.', 'Слышу. Можешь продолжать.', 'Да, я с тобой.']), should_speak: true };
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
        local_memory: this.localMemory,
      });
      if (result.reply) {
        this.renderMessage('bot', result.reply);
        if (result.should_speak) await this.speakText(result.reply);
      } else {
        this.renderSystem(result.internal_note || 'Astra услышала и решила промолчать.');
      }
      if (Array.isArray(result.sound_memory)) result.sound_memory.forEach(s => this.remember('sound', s));
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
    this.recognition.onerror = (e) => {
      this.renderSystem(`Слух споткнулся: ${e.error || 'unknown'}.`);
    };
    this.recognition.onend = () => {
      if (this.listenMode !== 'off') {
        try { this.recognition.start(); } catch (_) {}
      }
    };
    return this.recognition;
  }

  async startListening(mode = 'direct') {
    const r = this.ensureRecognition();
    this.listenMode = mode;
    this.$('listenBadge').textContent = mode === 'ambient' ? 'слушает фон' : 'слушает тебя';
    this.$('listenBadge').className = `badge ${mode === 'ambient' ? 'soft' : ''}`;
    try { r.start(); } catch (_) {}
    this.renderSystem(mode === 'ambient' ? 'Фоновый слух включён. Astra чаще промолчит, чем влезет.' : 'Режим прямого слуха включён. Можно обращаться голосом.');
  }

  stopListening() {
    this.listenMode = 'off';
    if (this.recognition) this.recognition.stop();
    this.$('listenBadge').textContent = 'не слушает';
    this.$('listenBadge').className = 'badge soft';
    this.renderSystem('Слух остановлен.');
  }

  async speakText(text) {
    if (!text) return;
    const c = this.cfg();
    if (this.cloudHealthy) {
      try {
        const url = this.api('/speak');
        const body = new URLSearchParams({ text, voice: c.voice });
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: body.toString(),
          mode: 'cors',
          cache: 'no-store',
        });
        if (!res.ok) throw new Error('speech');
        const blob = await res.blob();
        const audio = new Audio(URL.createObjectURL(blob));
        this.ignoreSpeechUntil = Date.now() + 6000;
        await audio.play();
        this.lastSpokenBySelfAt = Date.now();
        return;
      } catch (_) {
        // fall through to browser TTS
      }
    }
    try {
      if ('speechSynthesis' in window) {
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = c.lang === 'en' ? 'en-US' : 'ru-RU';
        speechSynthesis.cancel();
        this.ignoreSpeechUntil = Date.now() + 6000;
        speechSynthesis.speak(utter);
      }
    } catch (_) {
      // keep quiet
    }
  }

  async refreshState(provided = null) {
    try {
      const data = provided || await this.requestJSON('/state', {}, { timeoutMs: 12000 });
      const state = data.state || data;
      this.$('state').textContent = JSON.stringify(state, null, 2);
      this.$('chips').innerHTML = [
        `mood: ${state.mood}`,
        `curiosity: ${state.curiosity}`,
        `discretion: ${state.discretion}`,
        ...(state.interests || []).slice(0, 8).map(x => `interest: ${x}`),
      ].map(x => `<span class="chip">${x}</span>`).join('');
    } catch (_) {
      this.renderSystem('Состояние пока не обновилось, но Astra может продолжать работать локально.');
    }
  }

  bindEvents() {
    this.$('saveCfg').onclick = () => this.saveCfg();
    this.$('refreshState').onclick = () => this.refreshState();
    this.$('themeBtn').onclick = () => {
      const next = this.cfg().theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('theme', next);
      this.applyCfg();
    };
    this.$('camBtn').onclick = async () => { try { await this.startCamera(); this.renderSystem('Камера включена.'); } catch (err) { this.renderSystem(`Камера не стартовала: ${err.message}`); } };
    this.$('switchBtn').onclick = async () => { try { await this.toggleCameraFacing(); } catch (err) { this.renderSystem(`Не удалось сменить камеру: ${err.message}`); } };
    this.$('screenBtn').onclick = async () => { try { await this.startScreenShare(); this.renderSystem('Экран-шеринг включён.'); } catch (err) { this.renderSystem(`Экран не дался: ${err.message}`); } };
    this.$('stopScreenBtn').onclick = () => this.stopScreenShare();
    this.$('observeBtn').onclick = () => this.observeCurrent(true);
    this.$('autoBtn').onclick = () => this.toggleAutoObserve();
    this.$('uploadImageBtn').onclick = () => this.$('imageUpload').click();
    this.$('imageUpload').onchange = (e) => {
      const file = e.target.files?.[0];
      if (file) this.uploadImage(file);
      e.target.value = '';
    };
    this.$('sendBtn').onclick = () => this.sendChat();
    this.$('msg').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendChat(); }
    });
    this.$('speakBtn').onclick = () => this.speakText(this.lastBotText);
    this.$('clearLocal').onclick = () => {
      localStorage.removeItem('astraLocalMemory');
      this.localMemory = this.loadMemory();
      this.renderSystem('Локальная память Astra очищена.');
    };
    this.$('listenBtn').onclick = async () => {
      if (this.listenMode === 'direct') { this.stopListening(); return; }
      try { await this.startListening('direct'); } catch (err) { this.renderSystem(`Слух не стартовал: ${err.message}`); }
    };
    this.$('ambientBtn').onclick = async () => {
      if (this.listenMode === 'ambient') { this.stopListening(); return; }
      try { await this.startListening('ambient'); } catch (err) { this.renderSystem(`Фоновый слух не стартовал: ${err.message}`); }
    };
  }
}

window.addEventListener('DOMContentLoaded', () => new AstraApp());
