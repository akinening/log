/* ------------------------------------------------------------------
   アンビエントサウンドエンジン
   - D メジャーペンタトニックだけを使うことで、どの音が重なっても
     協和するようにする（不協和音の構造的な回避）
   - ゆっくり立ち上がり長く減衰するサイン波 + コンボリューション
     リバーブ + ランダムパンで立体的な音空間を作る
   - View Transitions では document が破棄されないため、この
     モジュールの状態（AudioContext）はページを跨いで生き続ける
------------------------------------------------------------------- */

export const SOUND_STORAGE_KEY = "akinen-sound";

// D2 起点のメジャーペンタトニック（D E F# A B）を 3 オクターブ分。
// 低めの音域に置くことで穏やかさを保つ
const NOTE_POOL = [];
for (let base = 38; base <= 62; base += 12) {
  for (const step of [0, 2, 4, 7, 9]) NOTE_POOL.push(base + step);
}

const midiToFreq = (m) => 440 * 2 ** ((m - 69) / 12);

// 等ラウドネス曲線の影響で、同じ音量でも高い音ほど大きく聴こえる。
// 基準周波数より上のオクターブごとにゲインを落とし、下のオクターブは
// 少し持ち上げることで、音域全体の体感音量を均していく
const LOUDNESS_REF_FREQ = 110; // A2 付近を基準に
const LOUDNESS_DB_PER_OCTAVE = 4.5;
const loudnessGain = (freq) => {
  const octaves = Math.log2(freq / LOUDNESS_REF_FREQ);
  return 10 ** ((-LOUDNESS_DB_PER_OCTAVE * octaves) / 20);
};

let ctx = null;
let dryBus = null;
let sendBus = null;
let enabled = false;
let walkIndex = 7; // 音域の中央付近から歩き始める
let idleTimer = 0;

// 発音中のボイス。上限に達したら最も古い音をフェードアウトして
// 新しい音を優先する（クリックが無音にならず、重なりすぎも防ぐ）。
// フェード中のボイスも総数に数え、連打時の膨張をハードキャップで抑える
const MAX_VOICES = 4;
const HARD_CAP = MAX_VOICES + 4;
const voices = new Set();

function stealOldestVoice() {
  let oldest = null;
  for (const v of voices) {
    if (!v.fading) {
      oldest = v;
      break;
    }
  }
  if (!oldest) return;
  oldest.fading = true;
  const t = ctx.currentTime;
  try {
    oldest.env.gain.cancelScheduledValues(t);
    oldest.env.gain.setValueAtTime(Math.max(oldest.env.gain.value, 0.0001), t);
    oldest.env.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    oldest.oscs.forEach((o) => o.stop(t + 0.5));
  } catch {
    /* 既に停止済みなら何もしない */
  }
}

export const readChoice = () => {
  try {
    return sessionStorage.getItem(SOUND_STORAGE_KEY);
  } catch {
    return null;
  }
};

export const saveChoice = (value) => {
  try {
    sessionStorage.setItem(SOUND_STORAGE_KEY, value);
  } catch {
    /* プライベートブラウズ等では記憶しない */
  }
};

function makeImpulse(seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
    }
  }
  return buf;
}

let outGain = null;
let started = false;

function buildGraph() {
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();

  // 音が重なった瞬間のピークだけを軽く抑える
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -20;
  limiter.knee.value = 24;
  limiter.ratio.value = 6;
  limiter.attack.value = 0.01;
  limiter.release.value = 0.4;
  limiter.connect(ctx.destination);

  // ON/OFF トグル専用のゲイン。他のバスには触れず、ここだけを
  // ゆっくりランプすることで無音への出入りを滑らかにする
  outGain = ctx.createGain();
  outGain.gain.value = 0.0001;
  outGain.connect(limiter);

  const master = ctx.createGain();
  master.gain.value = 1.0;
  master.connect(outGain);

  dryBus = ctx.createGain();
  dryBus.gain.value = 0.55;
  dryBus.connect(master);

  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(4.5, 2.8);
  convolver.connect(master);

  sendBus = ctx.createGain();
  sendBus.gain.value = 0.9;
  sendBus.connect(convolver);
}

function rampOutGain(target, duration) {
  if (!outGain || !ctx) return;
  const t = ctx.currentTime;
  outGain.gain.cancelScheduledValues(t);
  outGain.gain.setValueAtTime(Math.max(outGain.gain.value, 0.0001), t);
  outGain.gain.linearRampToValueAtTime(target, t + duration);
}

function playTone(midi, opts = {}) {
  if (!ctx || !enabled || voices.size >= HARD_CAP) return;
  let live = 0;
  for (const v of voices) if (!v.fading) live++;
  if (live >= MAX_VOICES) stealOldestVoice();
  const {
    peak = 0.06,
    attack = 0.8,
    release = 4.5,
    pan = Math.random() * 1.4 - 0.7
  } = opts;

  const t = ctx.currentTime;
  const freq = midiToFreq(midi);
  const targetPeak = peak * loudnessGain(freq);

  // わずかにデチューンした 2 本のサイン波でゆらぎを作る
  const oscA = ctx.createOscillator();
  const oscB = ctx.createOscillator();
  oscA.type = "sine";
  oscB.type = "sine";
  oscA.frequency.value = freq;
  oscB.frequency.value = freq;
  oscB.detune.value = 4 + Math.random() * 4;

  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = Math.min(freq * 3.5, 4200);
  filter.Q.value = 0.4;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(targetPeak, t + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);

  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;

  oscA.connect(filter);
  oscB.connect(filter);
  filter.connect(env);
  env.connect(panner);
  panner.connect(dryBus);
  panner.connect(sendBus);

  const voice = { env, oscs: [oscA, oscB], fading: false };
  voices.add(voice);

  const end = t + attack + release + 0.1;
  oscA.start(t);
  oscB.start(t);
  oscA.stop(end);
  oscB.stop(end);
  oscA.onended = () => {
    voices.delete(voice);
    panner.disconnect();
  };
}

// 直前の音から動くランダムウォークで旋律的なつながりを保ちつつ、
// 時々大きく跳躍させることで単調な近似音の繰り返しを避ける
function nextNote(spread = 4) {
  if (Math.random() < 0.22) {
    walkIndex = Math.floor(Math.random() * NOTE_POOL.length);
  } else {
    walkIndex += Math.round((Math.random() * 2 - 1) * spread);
    walkIndex = Math.max(0, Math.min(NOTE_POOL.length - 1, walkIndex));
  }
  return NOTE_POOL[walkIndex];
}

function startDrone() {
  const t = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.linearRampToValueAtTime(0.02, t + 8); // 気付かないくらいゆっくり立ち上げる
  out.connect(dryBus);
  out.connect(sendBus);

  // D2 と A2 のルート + 5 度。呼吸のような超低速 LFO で揺らす
  [38, 45].forEach((midi, i) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = midiToFreq(midi);

    const g = ctx.createGain();
    g.gain.value = i === 0 ? 1 : 0.55;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05 + i * 0.03;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.35;
    lfo.connect(lfoDepth);
    lfoDepth.connect(g.gain);

    osc.connect(g);
    g.connect(out);
    osc.start(t);
    lfo.start(t);
  });
}

// クリックが無くても時折まばらに鳴らす
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (enabled && ctx && !document.hidden) {
      playTone(nextNote(6), {
        peak: 0.028 + Math.random() * 0.02,
        attack: 1.8 + Math.random() * 1.6,
        release: 6 + Math.random() * 3
      });
    }
    scheduleIdle();
  }, 7000 + Math.random() * 9000);
}

export function enableAmbient({ greet = false } = {}) {
  const wasEnabled = enabled;
  if (!started) {
    started = true;
    buildGraph();
    startDrone();
    scheduleIdle();
  }
  ctx.resume().catch(() => {});
  enabled = true;
  rampOutGain(1, 1.2);

  if (greet && !wasEnabled) {
    // ON を選んだ瞬間に立ちのぼる、ゆっくりしたアルペジオ
    [50, 54, 57, 62].forEach((midi, i) => {
      setTimeout(() => {
        playTone(midi, {
          peak: 0.045,
          attack: 0.9 + i * 0.15,
          release: 5.5,
          pan: -0.5 + i * 0.33
        });
      }, i * 380);
    });
  }
}

// トグル OFF: ゆっくり無音までフェードし、その後 AudioContext を
// suspend してリソースを解放する（ドローンや進行中の音は破棄しない
// ので、再度 ON にすればそのまま音空間へ戻れる）
export function disableAmbient() {
  enabled = false;
  if (!ctx) return;
  rampOutGain(0.0001, 0.8);
  setTimeout(() => {
    if (!enabled && ctx) ctx.suspend().catch(() => {});
  }, 850);
}

export const isAmbientOn = () => enabled;

document.addEventListener("click", () => {
  if (!enabled || !ctx) return;
  playTone(nextNote(), {
    peak: 0.05 + Math.random() * 0.03,
    attack: 0.5 + Math.random() * 0.6,
    release: 3.5 + Math.random() * 2
  });
  // ときどき 5 度相当（ペンタトニック 3 つ上）を薄く重ねて広がりを出す
  if (Math.random() < 0.3) {
    const midi = NOTE_POOL[Math.min(walkIndex + 3, NOTE_POOL.length - 1)];
    setTimeout(
      () => playTone(midi, { peak: 0.028, attack: 1.2, release: 5 }),
      150 + Math.random() * 200
    );
  }
});

// 同一セッションでのリロード時は、最初の操作をきっかけに自動再開する
// （ブラウザの自動再生制限のためユーザー操作が必要）
if (readChoice() === "on") {
  const resume = () => enableAmbient();
  window.addEventListener("pointerdown", resume, { once: true });
  window.addEventListener("keydown", resume, { once: true });
}
