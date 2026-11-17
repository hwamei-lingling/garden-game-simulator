/* =============================================================================
    SOUND EFFECTS  (Web Audio, no audio files)
    -----------------------------------------------------------------------------
    [Audio] — Sound effects — every sound is built from simple tones and filtered noise when it is played,
    so the project needs no sound files. script.js calls GardenSound.play("name") from GardenUI.
    This file keeps no game state (only the player's sound on/off and volume choice).

    Rules that matter:
    - Browsers only allow sound after the player has clicked or pressed a key. The first click/key "unlocks" audio.
    - If the browser has no Web Audio, or audio fails, play() quietly does nothing; the game still works.
    - Sound on/off, volume and the background-ambience on/off are saved in localStorage (key "pixel-garden-sound") and are NOT part
      of the game save or Undo.
    - [Audio] — Seasonal ambience — each season has its own ongoing background scene (see AMBIENCE below). GardenUI tells this file
      the season and day/night with setScene(); the scene crossfades when either changes.
============================================================================= */

const GardenSound = (() => {
  const STORE_KEY = "pixel-garden-sound";
  let ctx = null;          // the AudioContext, created on the first play()
  let master = null;       // master volume control that every sound goes through
  let noiseBuf = null;     // one second of random noise, reused by all noise-based sounds
  let enabled = true;
  let volume = 0.6;        // 0 to 1
  let ambienceOn = true;   // background season sounds (separate switch, so effects can stay on while the background is off)
  let unlocked = false;    // true after the first click / key press (browsers refuse sound before that)
  let wanted = null;       // the season + day/night GardenUI last asked for: { season, phase }
  let current = null;      // the ambience scene that is playing now (or null)
  let timer = null;        // scheduler that adds the random events (birds, hoots, ...) to the current scene

  // ---- Saved choice (on/off + volume) ---------------------------------------
  try {
    const saved = JSON.parse(globalThis.localStorage.getItem(STORE_KEY));
    if (saved && typeof saved.on === "boolean") enabled = saved.on;
    if (saved && typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1) volume = saved.volume;
    if (saved && typeof saved.ambience === "boolean") ambienceOn = saved.ambience;
  } catch (e) { /* no storage or bad data: keep the defaults */ }

  function persist() {
    try { globalThis.localStorage.setItem(STORE_KEY, JSON.stringify({ on: enabled, volume, ambience: ambienceOn })); } catch (e) { /* ignore */ }
  }

  function applyGain() {
    if (master) master.gain.value = enabled ? volume : 0;   // muted = silent, even for sounds already scheduled
  }

  // ---- Audio context ---------------------------------------------------------
  function ensure() {
    if (ctx) return ctx;
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.connect(ctx.destination);
      applyGain();
    } catch (e) { ctx = null; master = null; return null; }
    return ctx;
  }

  /** Called by the first click / key press so the browser allows sound. */
  function unlock() {
    unlocked = true;
    const c = ensure();
    if (c && c.state === "suspended" && c.resume) {
      try { const p = c.resume(); if (p && p.catch) p.catch(() => { }); } catch (e) { /* ignore */ }
    }
    applyScene();            // start the background that was waiting for the first click
  }

  function noiseBuffer() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  // ---- Building blocks --------------------------------------------------------
  // A short musical note: starts at time t0, fades in quickly, then fades out over dur seconds.
  // "to" makes the pitch slide from freq to that value.
  function tone(t0, freq, dur, { type = "sine", vol = 0.3, to = null, attack = 0.005, dest = null } = {}) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(dest || master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // A burst of filtered noise (water, wind, rustling, snips). The filter picks which part of the noise you hear.
  function noise(t0, dur, { type = "bandpass", f0 = 1000, f1 = null, q = 1, vol = 0.3, attack = 0.01, release = 0, dest = null } = {}) {
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = noiseBuffer();
    filter.type = type;
    filter.frequency.setValueAtTime(f0, t0);
    if (f1) filter.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    filter.Q.value = q;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    if (release > 0) gain.gain.setValueAtTime(vol, t0 + dur - release);   // "release": hold the level steady, then fade only at the end
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest || master);
    src.start(t0, Math.random() * 0.4);
    src.stop(t0 + dur + 0.02);
  }

  const bell = (t, f, dur = 1, vol = 0.12) => {            // a soft bell: the note plus a quiet higher overtone
    tone(t, f, dur, { vol });
    tone(t, f * 2.76, dur * 0.5, { vol: vol * 0.35 });
  };
  const chirp = (t, from, to, vol = 0.1) => tone(t, from, 0.09, { to, vol });   // a short bird-like sweep

  // ---- The sounds --------------------------------------------------------------
  // Each function receives the start time t (in audio seconds) and schedules its notes relative to it.
  const SOUNDS = {
    // --- Farming ---
    water(t) {                                              // a watering can (about 1.2 s) built from many tiny water bubbles
      // Real water sounds like a crowd of tiny bubbles. Each bubble is a very short note whose pitch rises quickly
      // ("bloop"); small bubbles are high and quiet, big bubbles are low and louder. We scatter many of them in time.
      const r = Math.random;
      const bubble = (at, f, vol) => tone(at, f, 0.015 + 45 / f, { to: f * (1.4 + r() * 0.6), vol, attack: 0.002 });
      // 1. The can tilts and water glugs out: a few big, low bubbles
      for (let i = 0; i < 7; i++) bubble(t + i * 0.035 + r() * 0.02, 380 + r() * 420, 0.2 + r() * 0.08);
      // 2. The shower: dozens of small, high bubbles, densest at the start and thinning out (the water running low)
      for (let i = 0; i < 90; i++) {
        const at = t + 0.12 + 1.0 * (1 - Math.sqrt(1 - r()));   // more bubbles early, fewer late
        const f = 1200 * Math.pow(4.5, r());                    // 1200-5400 Hz, more of the low ones
        bubble(at, f, 0.05 + 900 / f * 0.05 * r());
      }
      // 3. A very soft wet "sheen" so the bubbles blend into one stream
      noise(t + 0.1, 1.0, { type: "bandpass", f0: 3200, q: 0.5, vol: 0.08, attack: 0.1, release: 0.4 });
      // 4. A few drops landing on the soil
      for (let i = 0; i < 6; i++) {
        const at = t + 0.4 + r() * 0.9;
        noise(at, 0.035, { type: "lowpass", f0: 700 + r() * 300, q: 0.6, vol: 0.06, attack: 0.004 });
      }
    },
    harvest(t) {                                            // scissors / shears: two quick metallic snips, then a soft cut
      [0, 0.12].forEach((d) => {
        noise(t + d, 0.07, { type: "highpass", f0: 5200, q: 0.8, vol: 0.32, attack: 0.002 });
        tone(t + d, 2700, 0.06, { type: "square", to: 1900, vol: 0.05, attack: 0.002 });
      });
      tone(t + 0.22, 320, 0.1, { to: 200, vol: 0.18 });
    },
    plant(t) {                                              // seed pressed into soil
      tone(t, 230, 0.14, { to: 110, vol: 0.32 });
      noise(t, 0.12, { type: "lowpass", f0: 500, q: 0.5, vol: 0.18 });
    },
    eat(t) {                                                // three crunchy bites
      [0, 0.1, 0.2].forEach((d) => noise(t + d, 0.05, { f0: 1600, q: 2, vol: 0.3, attack: 0.002 }));
    },
    drop(t) {                                               // item falls on the ground
      tone(t, 190, 0.13, { to: 90, vol: 0.28 });
      noise(t, 0.08, { type: "lowpass", f0: 320, vol: 0.15 });
    },

    // --- Coins and levels ---
    coin(t) {                                               // earning coins: a bright two-note ding
      tone(t, 1175, 0.09, { type: "square", vol: 0.1 });
      tone(t + 0.08, 1568, 0.35, { vol: 0.2 });
      tone(t + 0.1, 2349, 0.25, { vol: 0.07 });
    },
    coins(t) {                                              // a bigger payday: a quick run of dings
      [0, 0.07, 0.14, 0.21].forEach((d, i) => tone(t + d, 1175 + i * 180, 0.12, { type: "triangle", vol: 0.16 }));
      tone(t + 0.3, 2093, 0.4, { vol: 0.16 });
    },
    buy(t) {                                                // spending coins: a small falling two-note
      tone(t, 659, 0.08, { type: "square", vol: 0.09 });
      tone(t + 0.07, 523, 0.2, { type: "triangle", vol: 0.18 });
    },
    levelup(t) {                                            // rising arpeggio
      [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.09, f, i === 3 ? 0.5 : 0.14, { type: "triangle", vol: 0.16 }));
    },

    // --- Menus and movement ---
    select(t) { tone(t, 900, 0.035, { vol: 0.08 }); },     // hotbar / backpack tick
    undo(t) { tone(t, 660, 0.18, { type: "triangle", to: 330, vol: 0.2 }); },
    error(t) { tone(t, 200, 0.14, { to: 150, vol: 0.14 }); },   // "that did not work" (soft on purpose)
    step(t) { noise(t, 0.06, { type: "lowpass", f0: 600, vol: 0.18 }); },
    arrive(t) {
      tone(t, 523, 0.15, { vol: 0.16 });
      tone(t + 0.12, 784, 0.32, { vol: 0.16 });
    },

    // --- Day and night ---
    day(t) {                                                // sunrise: rising chime and two bird chirps
      [523, 659, 784].forEach((f, i) => bell(t + i * 0.14, f, 0.9, 0.12));
      chirp(t + 0.55, 2500, 3500);
      chirp(t + 0.68, 2800, 3900);
    },
    night(t) {                                              // sundown: falling notes and crickets
      [392, 330, 262].forEach((f, i) => tone(t + i * 0.2, f, 0.7, { vol: 0.13 }));
      [0.6, 0.68, 0.76, 1.05, 1.13, 1.21].forEach((d) => tone(t + d, 4200, 0.045, { vol: 0.045 }));
    },
  };


  // =============================================================================
  // [Audio] — Seasonal ambience — an ongoing background scene for each season (and a night version of it)
  // How a scene is made:
  //   1. LAYERS (optional): a very soft tone that is held (autumn and winter), whose volume slowly swells and fades (an LFO).
  //      There are no looping noise layers: nothing hisses or rustles all the time.
  //   2. EVENTS: random one-off sounds (a bird call, an owl hoot, a wind gust, a cicada song, a bell twinkle). A small timer
  //      schedules them a little ahead of time on the audio clock, at random gaps, so there are quiet stretches between them.
  //   3. CROSSFADE: when the season or day/night changes, the new scene fades in while the old one fades out.
  // =============================================================================
  const FADE = 2;                                           // seconds to crossfade between scenes
  const AMBIENCE_LEVEL = 2.2;                               // loudness of the background; the layer volumes below are small on purpose, and this lifts them so they are audible but still quieter than the action sounds
  const rand = (a, b) => a + Math.random() * (b - a);

  let ambNoiseBuf = null;                                   // 4 seconds of noise (longer than the effects noise so the loop is not noticeable)
  function ambNoiseBuffer() {
    if (!ambNoiseBuf) {
      ambNoiseBuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
      const data = ambNoiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return ambNoiseBuf;
  }

  // (Currently unused: the scenes no longer use looping noise. Kept as a helper for a looping texture.)
  // One looping layer. lfoRate (Hz) + lfoDepth wobble the loudness; filterLfo wobbles the filter pitch by that many Hz.
  function loop(dest, nodes, { type = "lowpass", f0 = 800, q = 0.7, vol = 0.1, lfoRate = 0, lfoDepth = 0, filterLfo = 0 }) {
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = ambNoiseBuffer();
    src.loop = true;
    filter.type = type;
    filter.frequency.value = f0;
    filter.Q.value = q;
    gain.gain.value = vol;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    if (lfoRate > 0) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = lfoRate;
      depth.gain.value = lfoDepth;
      lfo.connect(depth);
      depth.connect(gain.gain);                             // the wobble is added to the loudness
      if (filterLfo) {
        const fd = ctx.createGain();
        fd.gain.value = filterLfo;
        lfo.connect(fd);
        fd.connect(filter.frequency);
      }
      lfo.start();
      nodes.push(lfo);
    }
    src.start(0, Math.random() * 3);                        // start at a random place in the noise
    nodes.push(src);
  }

  // Random one-off sounds used by the scenes. Each receives the start time t and the scene's volume bus d.
  const EVENTS = {
    bird(t, d) {                                            // a short bird call: 1-4 quick upward chirps
      const f = rand(2000, 3800), n = 1 + Math.floor(rand(0, 4)), gap = rand(0.1, 0.15);
      for (let i = 0; i < n; i++) tone(t + i * gap, f, rand(0.06, 0.1), { to: f * rand(1.2, 1.6), vol: 0.035, dest: d });
    },
    farBird(t, d) { tone(t, rand(1400, 2000), 0.12, { to: rand(1900, 2500), vol: 0.025, dest: d }); },   // quieter, lower, "far away"
    leaf(t, d) { noise(t, rand(0.3, 0.7), { f0: 2600, f1: 1500, q: 0.9, vol: 0.04, attack: 0.08, dest: d }); },
    gust(t, d, strength = 1, withLeaves = false) {          // wind that comes for a while: swells slowly, then fades (4-8 s), and is gone
      const dur = rand(4, 8);
      noise(t, dur, { type: "lowpass", f0: rand(350, 500), f1: rand(600, 800), q: 0.6, vol: 0.05 * strength, attack: dur * 0.45, dest: d });
      if (withLeaves) {                                     // leaves only rustle while the wind blows
        const n = Math.floor(rand(3, 7));
        for (let i = 0; i < n; i++) EVENTS.leaf(t + dur * rand(0.25, 0.75), d);
      }
    },
    gustLeaves(t, d) { EVENTS.gust(t, d, 1, true); },
    gustWinter(t, d) { EVENTS.gust(t, d, 1.3); },           // a little stronger and lower in winter
    cicada(t, d) {                                          // a short buzzing phrase (3-5 s) that swells and fades; then silence
      const n = Math.floor(rand(70, 120));
      for (let i = 0; i < n; i++) {
        const env = Math.sin(Math.PI * (i + 0.5) / n);      // swells in the middle of the phrase
        noise(t + i * 0.04, 0.035, { type: "highpass", f0: 5500, q: 1, vol: 0.02 * env, attack: 0.004, dest: d });
      }
    },
    pluck(t, d) {                                           // one soft, short note (like a gentle kalimba)
      const f = [294, 330, 392, 440, 523][Math.floor(rand(0, 5))];
      tone(t, f, 1.1, { vol: 0.03, attack: 0.008, dest: d });
    },
    hoot(t, d) {                                            // an owl: "hoo ... hoo-hoo"
      [0, 0.55, 0.85].forEach((o) => tone(t + o, 330, 0.35, { to: 290, vol: 0.03, attack: 0.06, dest: d }));
    },
    twinkle(t, d) {                                         // a tiny high bell, like frost glinting
      const f = rand(2200, 3300);
      tone(t, f, 1.3, { vol: 0.03, attack: 0.01, dest: d });
      tone(t, f * 2.76, 0.5, { vol: 0.01, attack: 0.01, dest: d });
    },
    cricket(t, d) { for (let i = 0; i < 3; i++) tone(t + i * 0.07, 4200 + rand(-150, 150), 0.04, { vol: 0.04, dest: d }); },
  };

  // A very soft, slowly swelling tone (two notes together). Used instead of wind in autumn and winter: it gives a calm
  // "bed" under the random events without any hissing noise.
  function pad(dest, nodes, freqs, vol, swellRate = 0.07) {
    const gain = ctx.createGain();
    gain.gain.value = vol;
    gain.connect(dest);
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f * (i ? 1.003 : 1);            // a tiny detune so the two notes shimmer slightly
      osc.connect(gain);
      osc.start();
      nodes.push(osc);
    });
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = swellRate;
    depth.gain.value = vol * 0.6;
    lfo.connect(depth);
    depth.connect(gain.gain);                               // the volume slowly rises and falls
    lfo.start();
    nodes.push(lfo);
  }

  // The scenes. Each returns its events: [name, shortest gap, longest gap] in seconds. They are meant to be SUBTLE and natural:
  // wind and cicadas come only for a while and then stop (nothing hisses or rustles all the time); autumn and winter keep a
  // very quiet tone underneath.
  const AMBIENCE = {
    Spring(d, nodes, night) {                               // sparse birdsong, now and then a gentle breeze (crickets and an owl at night)
      return night ? [["cricket", 0.8, 2], ["hoot", 10, 20], ["gust", 25, 55]] : [["bird", 1.5, 5], ["farBird", 3, 8], ["gust", 22, 50]];
    },
    Summer(d, nodes, night) {                               // short cicada songs with silence between; crickets at night
      return night ? [["cricket", 0.4, 1]] : [["cicada", 6, 16], ["farBird", 5, 12]];
    },
    Autumn(d, nodes, night) {                               // a quiet warm tone; wind gusts that rustle leaves, a few soft notes, a far owl
      pad(d, nodes, [147, 220], 0.004);
      return night ? [["hoot", 6, 14], ["gustLeaves", 22, 45], ["cricket", 2, 5]] : [["gustLeaves", 16, 36], ["pluck", 3, 8], ["hoot", 10, 22]];
    },
    Winter(d, nodes, night) {                               // a cold, calm tone; wind that comes and goes; rare icy twinkles
      pad(d, nodes, [196, 294], 0.005, 0.06);
      return night ? [["twinkle", 4, 9], ["gustWinter", 22, 45]] : [["twinkle", 2, 5], ["gustWinter", 18, 40]];
    },
  };

  function startScene(season, phase) {
    const build = AMBIENCE[season];
    if (!build) return;
    const now = ctx.currentTime;
    const bus = ctx.createGain();                           // this scene's own volume control (used for the fade)
    bus.gain.setValueAtTime(0.0001, now);
    bus.gain.linearRampToValueAtTime(AMBIENCE_LEVEL, now + FADE);
    bus.connect(master);
    const nodes = [];
    const events = build(bus, nodes, phase === "Night").map(([name, min, max]) => ({ name, min, max, next: now + rand(0.2, min) }));
    current = { season, phase, bus, nodes, events };
  }

  function stopScene(scene, fade) {
    const now = ctx.currentTime;
    scene.bus.gain.cancelScheduledValues(now);
    scene.bus.gain.setValueAtTime(Math.max(scene.bus.gain.value, 0.0001), now);
    scene.bus.gain.linearRampToValueAtTime(0.0001, now + fade);
    scene.nodes.forEach((n) => { try { n.stop(now + fade + 0.1); } catch (e) { /* already stopped */ } });
  }

  // Runs about 4 times a second: add any random events that fall in the next second of audio.
  function tick() {
    if (!current || !ctx) return;
    const horizon = ctx.currentTime + 1;
    current.events.forEach((ev) => {
      while (ev.next < horizon) {
        try { EVENTS[ev.name](ev.next, current.bus); } catch (e) { /* ignore one bad event */ }
        ev.next += rand(ev.min, ev.max);
      }
    });
  }

  /** Make the playing scene match what we want: right season + day/night, and only when sound and ambience are on. */
  function applyScene() {
    const should = unlocked && enabled && ambienceOn && wanted;
    if (!should) {
      if (current && ctx) { stopScene(current, 0.6); current = null; }
      if (timer) { clearInterval(timer); timer = null; }
      return;
    }
    if (current && current.season === wanted.season && current.phase === wanted.phase) return;   // already playing the right one
    if (!ensure()) return;
    if (current) stopScene(current, FADE);                  // old scene fades out while the new one fades in
    startScene(wanted.season, wanted.phase);
    if (!timer) {
      timer = setInterval(tick, 250);
      if (timer.unref) timer.unref();                       // (Node only) do not keep a test process alive
    }
    tick();
  }

  /** GardenUI calls this on every redraw with the current season and phase ("Day" / "Night"). Cheap when nothing changed. */
  function setScene(season, phase) {
    wanted = { season, phase };
    applyScene();
  }

  // ---- Public functions ---------------------------------------------------------
  /** Play a sound by name. delay (seconds) starts it later. Returns true if it was scheduled. */
  function play(name, delay = 0) {
    if (!enabled || !SOUNDS[name]) return false;
    const c = ensure();
    if (!c) return false;
    unlock();
    try { SOUNDS[name](c.currentTime + delay + 0.01); } catch (e) { return false; }
    return true;
  }

  function setEnabled(on) { enabled = !!on; applyGain(); persist(); applyScene(); }
  function setAmbience(on) { ambienceOn = !!on; persist(); applyScene(); }
  function setVolume(v) {
    const n = Number(v);
    volume = Math.min(1, Math.max(0, Number.isFinite(n) ? n : volume));
    applyGain(); persist();
  }

  // The first click or key press unlocks audio (browser rule).
  if (typeof document !== "undefined") {
    ["pointerdown", "keydown"].forEach((evt) => document.addEventListener(evt, unlock, { passive: true }));
    // Pause everything while the tab is hidden, so the background does not play on in a tab you are not looking at.
    document.addEventListener("visibilitychange", () => {
      if (!ctx) return;
      try {
        const p = document.hidden ? ctx.suspend() : (unlocked ? ctx.resume() : null);
        if (p && p.catch) p.catch(() => { });
      } catch (e) { /* ignore */ }
    });
  }

  return {
    play, unlock, setEnabled, setVolume, setAmbience, setScene,
    get enabled() { return enabled; },
    get ambience() { return ambienceOn; },
    scene: () => (current ? { season: current.season, phase: current.phase } : null),
    _tick: tick,                                            // for tests
    get volume() { return volume; },
    names: () => Object.keys(SOUNDS),
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = GardenSound;
}