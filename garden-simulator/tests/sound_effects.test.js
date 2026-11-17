/* Unit tests for sound-effects.js using a fake AudioContext (no real sound is played).
   Run from the project folder:  node tests/sound_effects.test.js   (or all tests: node tests/run_all.js) */
const assert = require("assert");
const path = require("path");
let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("ok -", name); } catch (e) { console.log("FAIL -", name, "\n", e.message); process.exitCode = 1; } };

// ---- A fake Web Audio API that only counts what is created and records parameter calls ----
const log = { osc: 0, noise: 0, started: 0, masterGain: null, resumes: 0, badRamp: 0, sources: [], oscs: [], timed: 0, time: 10 };
const param = (name) => ({
  value: 1,
  setValueAtTime(v) { if (!(v > 0) && name !== "gain") log.badRamp++; },
  exponentialRampToValueAtTime(v) { if (!(v > 0)) log.badRamp++; },     // real browsers throw on zero or negative ramps
  linearRampToValueAtTime() {},
  cancelScheduledValues() {},
});
class FakeContext {
  get currentTime() { return log.time; }   // the test moves this clock forward
  constructor() { this.sampleRate = 8000; this.destination = {}; this.state = "suspended"; }
  resume() { log.resumes++; this.state = "running"; return Promise.resolve(); }
  suspend() { this.state = "suspended"; return Promise.resolve(); }
  createGain() { const g = { gain: param("gain"), connect() {} }; if (!log.masterGain) log.masterGain = g; return g; }   // the first gain made is the master
  createOscillator() {
    log.osc++;
    const o = { type: "sine", frequency: param("freq"), stopTime: null, timed: false, connect() {}, start(t) { log.started++; if (t !== undefined) { log.timed++; o.timed = true; } }, stop(t) { o.stopTime = t; } };
    log.oscs.push(o);
    return o;
  }
  createBiquadFilter() { return { type: "", frequency: param("freq"), Q: { value: 0 }, connect() {} }; }
  createBuffer(ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource() { log.noise++; const src = { buffer: null, loop: false, stopTime: null, connect() {}, start(t) { log.started++; src.startTime = t; }, stop(t) { src.stopTime = t; } }; log.sources.push(src); return src; }
}
const fresh = () => {
  delete require.cache[require.resolve(path.join(__dirname, "..", "sound-effects.js"))];
  Object.assign(log, { osc: 0, noise: 0, started: 0, masterGain: null, resumes: 0, badRamp: 0, sources: [], oscs: [], timed: 0, time: 10 });
  return require(path.join(__dirname, "..", "sound-effects.js"));
};

test("without Web Audio, play() returns false and does not throw", () => {
  delete globalThis.AudioContext; delete globalThis.webkitAudioContext;
  const S = fresh();
  assert.strictEqual(S.play("water"), false);
  S.unlock();
});

globalThis.AudioContext = FakeContext;

test("every sound the game uses exists", () => {
  const S = fresh();
  const needed = ["water", "harvest", "plant", "eat", "drop", "coin", "coins", "buy", "levelup", "select", "undo", "error", "step", "arrive",
                  "day", "night"];
  needed.forEach((n) => assert.ok(S.names().includes(n), "missing sound: " + n));
});

test("each sound plays, creates audio nodes, and never makes an invalid (zero or negative) ramp", () => {
  const S = fresh();
  S.names().forEach((n) => {
    const before = log.osc + log.noise;
    assert.strictEqual(S.play(n), true, n);
    assert.ok(log.osc + log.noise > before, n + " should create at least one oscillator or noise source");
  });
  assert.strictEqual(log.badRamp, 0);
  assert.strictEqual(log.osc + log.noise, log.started, "every source that was created was also started");
});

test("water is built from many bubbles over about 1.2 s, not a short blip", () => {
  const S = fresh();
  S.play("water");
  const t0 = log.time + 0.01;
  const bubbles = log.oscs.filter((o) => o.timed).length;
  assert.ok(bubbles >= 80, "dozens of bubble notes (" + bubbles + ")");
  const ends = [...log.sources, ...log.oscs].map((x) => x.stopTime).filter((v) => v !== null);
  const end = Math.max(...ends) - t0;
  assert.ok(end >= 1.0 && end <= 1.8, "whole sound lasts about 1-1.8 s (" + end.toFixed(2) + ")");
  assert.strictEqual(log.badRamp, 0);
});

test("harvest uses noise (snips)", () => {
  const S = fresh();
  S.play("harvest"); assert.ok(log.noise >= 2, "two snips");
});

test("an unknown sound name returns false", () => {
  const S = fresh();
  assert.strictEqual(S.play("nope"), false);
});

test("the first play unlocks a suspended context", () => {
  const S = fresh();
  S.play("select");
  assert.ok(log.resumes >= 1);
});

test("muting stops new sounds and silences the master volume", () => {
  const S = fresh();
  S.play("coin");
  const made = log.osc;
  S.setEnabled(false);
  assert.strictEqual(S.enabled, false);
  assert.strictEqual(log.masterGain.gain.value, 0);
  assert.strictEqual(S.play("coin"), false);
  assert.strictEqual(log.osc, made, "nothing new is created while muted");
  S.setEnabled(true);
  assert.strictEqual(log.masterGain.gain.value, S.volume);
  assert.strictEqual(S.play("coin"), true);
});

test("volume is clamped between 0 and 1 and ignores junk", () => {
  const S = fresh();
  S.setVolume(5); assert.strictEqual(S.volume, 1);
  S.setVolume(-2); assert.strictEqual(S.volume, 0);
  S.setVolume(0.4); S.setVolume("abc"); assert.strictEqual(S.volume, 0.4);
});

test("a delayed sound is scheduled later, not played immediately", () => {
  const S = fresh();
  const times = [];
  const orig = FakeContext.prototype.createOscillator;
  FakeContext.prototype.createOscillator = function () { const o = orig.call(this); o.start = (t) => times.push(t); return o; };
  S.play("select", 2);
  FakeContext.prototype.createOscillator = orig;
  assert.ok(times[0] >= 12, "start time should be currentTime + delay");
});

test("saved choice is restored when the file loads again", () => {
  const store = {};
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  let S = fresh();
  S.setEnabled(false); S.setVolume(0.25);
  S = fresh();
  assert.strictEqual(S.enabled, false);
  assert.strictEqual(S.volume, 0.25);
  delete globalThis.localStorage;
});

test("bad saved data falls back to defaults", () => {
  globalThis.localStorage = { getItem: () => "{not json", setItem() {} };
  const S = fresh();
  assert.strictEqual(S.enabled, true);
  assert.strictEqual(S.volume, 0.6);
  delete globalThis.localStorage;
});

// ---------------- Seasonal ambience ----------------
// The always-on parts of a scene: looping noise sources, plus pads and wobbles (oscillators started without a time).
const loops = () => [...log.sources.filter((x) => x.loop), ...log.oscs.filter((o) => !o.timed)];

test("ambience waits for the first click: nothing plays before unlock", () => {
  const S = fresh();
  S.setScene("Autumn", "Day");
  assert.strictEqual(S.scene(), null);
  assert.strictEqual(log.osc + log.noise, 0, "no audio nodes yet");
  S.unlock();
  assert.deepStrictEqual(S.scene(), { season: "Autumn", phase: "Day" });
  assert.ok(loops().length >= 1, "an always-on layer was started");
  S.setEnabled(false);
});

test("every season, day and night, starts looping layers, and its events can be scheduled", () => {
  ["Spring", "Summer", "Autumn", "Winter"].forEach((season) => ["Day", "Night"].forEach((phase) => {
    const S = fresh();
    S.unlock();
    S.setScene(season, phase);
    assert.deepStrictEqual(S.scene(), { season, phase }, season + " " + phase);
    const timed0 = log.timed;
    for (let i = 0; i < 120; i++) { log.time += 0.25; S._tick(); }    // 30 seconds of audio time
    assert.ok(log.timed > timed0, season + " " + phase + " schedules random events over time (birds, hoots, twinkles...)");
    assert.strictEqual(log.badRamp, 0, season + " " + phase + " makes no invalid ramps");
    S.setEnabled(false);
  }));
});

test("no scene has an always-on noise or rustling layer", () => {
  ["Spring", "Summer", "Autumn", "Winter"].forEach((season) => ["Day", "Night"].forEach((phase) => {
    const S = fresh(); S.unlock(); S.setScene(season, phase);
    assert.strictEqual(log.sources.filter((x) => x.loop).length, 0, season + " " + phase);
    S.setEnabled(false);
  }));
});

test("each scene has its own character", () => {
  const layers = (season, phase) => { const S = fresh(); S.unlock(); S.setScene(season, phase); const n = loops().length; S.setEnabled(false); return n; };
  assert.strictEqual(layers("Spring", "Day"), 0, "spring: only random events");
  assert.strictEqual(layers("Summer", "Day"), 0, "summer: cicada songs are events, not a constant buzz");
  assert.strictEqual(layers("Autumn", "Day"), 3, "autumn: a soft two-note tone (2 notes + swell)");
  assert.strictEqual(layers("Winter", "Day"), 3, "winter: a soft two-note tone (2 notes + swell)");
});

test("wind comes only for some of the time (gusts with quiet gaps)", () => {
  ["Spring", "Autumn", "Winter"].forEach((season) => {
    const S = fresh(); S.unlock(); S.setScene(season, "Day");
    for (let i = 0; i < 1200; i++) { log.time += 0.25; S._tick(); }          // 300 seconds of audio time
    const gusts = log.sources.filter((x) => x.stopTime !== null && x.startTime !== undefined && x.stopTime - x.startTime >= 3.5 && x.stopTime - x.startTime <= 9);
    assert.ok(gusts.length >= 3, season + ": gusts do happen (" + gusts.length + ")");
    const covered = gusts.reduce((sum, x) => sum + (x.stopTime - x.startTime), 0);
    assert.ok(covered < 300 * 0.3, season + ": wind is heard less than 30% of the time (" + Math.round(covered) + " s of 300)");
    S.setEnabled(false);
  });
});

test("summer cicadas sing in phrases with silence between them", () => {
  const S = fresh(); S.unlock(); S.setScene("Summer", "Day");
  for (let i = 0; i < 1200; i++) { log.time += 0.25; S._tick(); }
  const pulses = log.sources.filter((x) => !x.loop && x.stopTime !== null && x.stopTime - x.startTime < 0.1 && x.stopTime - x.startTime > 0.03);
  assert.ok(pulses.length > 100, "cicada pulses were scheduled");
  const times = pulses.map((x) => x.startTime).sort((a, b) => a - b);
  const gaps = times.slice(1).map((v, i) => v - times[i]);
  assert.ok(gaps.some((g) => g > 3), "there are silent gaps of more than 3 seconds between phrases");
  S.setEnabled(false);
});

test("changing season crossfades: the old layers are told to stop, new ones start", () => {
  const S = fresh(); S.unlock();
  S.setScene("Autumn", "Day");
  const old = loops().slice();
  assert.ok(old.length >= 2);
  S.setScene("Winter", "Day");
  assert.ok(old.every((x) => x.stopTime !== null), "old layers scheduled to stop");
  assert.deepStrictEqual(S.scene(), { season: "Winter", phase: "Day" });
  assert.ok(loops().length > old.length, "new layers started");
  S.setEnabled(false);
});

test("asking for the same scene again does nothing (cheap on every redraw)", () => {
  const S = fresh(); S.unlock();
  S.setScene("Winter", "Day");
  const n = log.sources.length;
  for (let i = 0; i < 20; i++) S.setScene("Winter", "Day");
  assert.strictEqual(log.sources.length, n);
  S.setEnabled(false);
});

test("a day/night change switches to that season's night scene", () => {
  const S = fresh(); S.unlock();
  S.setScene("Spring", "Day");
  S.setScene("Spring", "Night");
  assert.deepStrictEqual(S.scene(), { season: "Spring", phase: "Night" });
  S.setEnabled(false);
});

test("muting stops the background; unmuting brings it back", () => {
  const S = fresh(); S.unlock();
  S.setScene("Autumn", "Day");
  const layers = loops().slice();
  S.setEnabled(false);
  assert.strictEqual(S.scene(), null);
  assert.ok(layers.length >= 2 && layers.every((x) => x.stopTime !== null));
  S.setEnabled(true);
  assert.deepStrictEqual(S.scene(), { season: "Autumn", phase: "Day" });
  S.setEnabled(false);
});

test("the ambience switch is separate from the effects switch", () => {
  const S = fresh(); S.unlock();
  S.setScene("Autumn", "Day");
  S.setAmbience(false);
  assert.strictEqual(S.scene(), null);
  assert.strictEqual(S.ambience, false);
  assert.strictEqual(S.enabled, true);
  assert.strictEqual(S.play("coin"), true, "effects still play");
  S.setAmbience(true);
  assert.deepStrictEqual(S.scene(), { season: "Autumn", phase: "Day" });
  S.setEnabled(false);
});

test("an unknown season is ignored without crashing", () => {
  const S = fresh(); S.unlock();
  S.setScene("Monsoon", "Day");
  assert.strictEqual(S.scene(), null);
});

test("the ambience choice is saved and restored", () => {
  const store = {};
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  let S = fresh();
  S.setAmbience(false);
  S = fresh();
  assert.strictEqual(S.ambience, false);
  delete globalThis.localStorage;
});

console.log(`\n${passed} sound-effects tests passed`);
