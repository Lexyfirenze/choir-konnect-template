// scoreEngine.js — MusicXML parsing + a small Web Audio choir-style player.
// No UI in here: ScoreReader.jsx draws the sheet music (OpenSheetMusicDisplay)
// and uses this file to work out which notes to play and to play them.

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const BEAT_UNITS = { whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25 };

const kids = (el) => Array.from(el.children || []);
const kid = (el, tag) => kids(el).find((c) => c.tagName === tag) || null;
const kidText = (el, tag) => {
  const k = kid(el, tag);
  return k ? (k.textContent || "").trim() : null;
};

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

// Decode raw bytes to text (handles UTF-8 and UTF-16 with byte-order marks).
export function decodeXmlBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

// A .mxl file is a zip archive. Find the score inside it.
export async function readMxl(buffer) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);
  let rootPath = null;
  const container = zip.file("META-INF/container.xml");
  if (container) {
    const doc = new DOMParser().parseFromString(await container.async("string"), "application/xml");
    const rf = doc.getElementsByTagName("rootfile")[0];
    rootPath = rf ? rf.getAttribute("full-path") : null;
  }
  let entry = rootPath ? zip.file(rootPath) : null;
  if (!entry) {
    entry = zip.file(/\.(xml|musicxml)$/i).find((f) => !f.name.startsWith("META-INF")) || null;
  }
  if (!entry) throw new Error("Could not find a score inside that .mxl file.");
  return decodeXmlBytes(await entry.async("uint8array"));
}

// Turn raw file bytes (plain XML or a zipped .mxl) into MusicXML text.
export async function readScoreBuffer(buffer) {
  const head = new Uint8Array(buffer.slice(0, 2));
  const isZip = head[0] === 0x50 && head[1] === 0x4b; // "PK"
  return isZip ? readMxl(buffer) : decodeXmlBytes(buffer);
}

export async function readScoreFile(file) {
  return readScoreBuffer(await file.arrayBuffer());
}

// Load a score stored online (e.g. attached to a Library piece).
export async function readScoreUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Couldn't download that score.");
  return readScoreBuffer(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Parsing MusicXML
// ---------------------------------------------------------------------------

export function parseMusicXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("That file isn't valid XML.");
  }
  const root = doc.documentElement;
  if (!root || root.tagName !== "score-partwise") {
    throw new Error("Only 'score-partwise' MusicXML is supported (that's what MuseScore, Finale and Sibelius export).");
  }

  const title = kidText(kid(root, "work") || root, "work-title") || kidText(root, "movement-title") || "Untitled score";

  // part id -> display name
  const partNames = {};
  const partList = kid(root, "part-list");
  if (partList) {
    kids(partList).filter((c) => c.tagName === "score-part").forEach((sp) => {
      partNames[sp.getAttribute("id")] = kidText(sp, "part-name") || kidText(sp, "part-abbreviation") || "";
    });
  }

  const tempoChanges = []; // { beat, bpm } from <sound tempo>
  const metroChanges = []; // fallback from <metronome>
  const measureMarks = []; // { num, beat } (taken from the first part)
  const rawTracks = [];    // { name, events:[{start,d,midi}] } in quarter-note beats
  let maxBeat = 0;

  kids(root).filter((c) => c.tagName === "part").forEach((part, pi) => {
    const partName = partNames[part.getAttribute("id")] || `Part ${pi + 1}`;
    let divisions = 1;
    let transpose = 0;
    let curKey = { fifths: 0, mode: "major" };
    let curTime = { beats: 4, beatType: 4 };
    let pos = 0;      // current position in quarter-note beats
    let maxPos = 0;
    let lastStart = 0;
    const events = [];
    const tied = new Map();

    kids(part).filter((c) => c.tagName === "measure").forEach((measure, mi) => {
      let mark = null;
      if (pi === 0) {
        const raw = measure.getAttribute("number");
        const n = parseInt(raw, 10);
        mark = { num: Number.isFinite(n) ? n : mi + 1, beat: pos, key: { ...curKey }, time: { ...curTime } };
        measureMarks.push(mark);
      }
      kids(measure).forEach((el) => {
        const tag = el.tagName;
        if (tag === "attributes") {
          const d = parseFloat(kidText(el, "divisions"));
          if (d > 0) divisions = d;
          const tr = kid(el, "transpose");
          if (tr) {
            const chroma = parseFloat(kidText(tr, "chromatic")) || 0;
            const oct = parseFloat(kidText(tr, "octave-change")) || 0;
            transpose = chroma + 12 * oct;
          }
          const keyEl = kid(el, "key");
          if (keyEl) {
            const f = parseInt(kidText(keyEl, "fifths"), 10);
            if (Number.isFinite(f)) curKey = { fifths: f, mode: (kidText(keyEl, "mode") || "major").toLowerCase() };
          }
          const timeEl = kid(el, "time");
          if (timeEl) {
            const b = parseInt(kidText(timeEl, "beats"), 10);
            const bt = parseInt(kidText(timeEl, "beat-type"), 10);
            if (b > 0 && bt > 0) curTime = { beats: b, beatType: bt };
            else if (timeEl.getAttribute("symbol") === "cut") curTime = { beats: 2, beatType: 2 };
          }
          if (mark) { mark.key = { ...curKey }; mark.time = { ...curTime }; }
        } else if (tag === "note") {
          if (kid(el, "grace")) return;
          const dur = (parseFloat(kidText(el, "duration")) || 0) / divisions;
          const isChord = !!kid(el, "chord");
          const start = isChord ? lastStart : pos;
          if (!isChord) lastStart = pos;
          const pitch = kid(el, "pitch");
          if (pitch && !kid(el, "cue") && dur > 0) {
            const step = kidText(pitch, "step");
            const octave = parseInt(kidText(pitch, "octave"), 10);
            const alter = Math.round(parseFloat(kidText(pitch, "alter")) || 0);
            if (step in STEP_SEMITONES && Number.isFinite(octave)) {
              const midi = 12 * (octave + 1) + STEP_SEMITONES[step] + alter + transpose;
              const voice = kidText(el, "voice") || "1";
              const ties = kids(el).filter((c) => c.tagName === "tie").map((c) => c.getAttribute("type"));
              const tieStop = ties.includes("stop");
              const tieStart = ties.includes("start");
              const key = `${voice}|${midi}`;
              const open = tied.get(key);
              if (tieStop && open && Math.abs(open.end - start) < 1e-3) {
                open.d += dur;
                open.end = start + dur;
                if (!tieStart) tied.delete(key);
              } else {
                const ev = { start, d: dur, end: start + dur, midi, voice, alter };
                events.push(ev);
                if (tieStart) tied.set(key, ev); else tied.delete(key);
              }
            }
          }
          if (!isChord) pos += dur;
          if (pos > maxPos) maxPos = pos;
        } else if (tag === "backup") {
          pos -= (parseFloat(kidText(el, "duration")) || 0) / divisions;
          if (pos < 0) pos = 0;
        } else if (tag === "forward") {
          pos += (parseFloat(kidText(el, "duration")) || 0) / divisions;
          if (pos > maxPos) maxPos = pos;
        } else if (tag === "direction" || tag === "sound") {
          const sounds = tag === "sound" ? [el] : Array.from(el.getElementsByTagName("sound"));
          sounds.forEach((s) => {
            const bpm = parseFloat(s.getAttribute("tempo"));
            if (bpm > 0) tempoChanges.push({ beat: pos, bpm });
          });
          if (tag === "direction") {
            Array.from(el.getElementsByTagName("metronome")).forEach((m) => {
              const unit = kidText(m, "beat-unit");
              const perMin = parseFloat(kidText(m, "per-minute"));
              if (unit in BEAT_UNITS && perMin > 0) {
                const dotted = kid(m, "beat-unit-dot") ? 1.5 : 1;
                metroChanges.push({ beat: pos, bpm: perMin * BEAT_UNITS[unit] * dotted });
              }
            });
          }
        }
      });
      pos = maxPos;
    });

    if (maxPos > maxBeat) maxBeat = maxPos;

    // A part that holds 2–4 voices (e.g. S+A on one staff) becomes one track per voice.
    const voices = [...new Set(events.map((e) => e.voice))].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    if (voices.length >= 2 && voices.length <= 4) {
      voices.forEach((v) => {
        rawTracks.push({ name: `${partName} · voice ${v}`, events: events.filter((e) => e.voice === v) });
      });
    } else if (events.length) {
      rawTracks.push({ name: partName, events });
    }
  });

  if (!rawTracks.length) throw new Error("No pitched notes were found in that score.");

  // Tempo map: quarter-note beats -> seconds
  let changes = tempoChanges.length ? tempoChanges : metroChanges;
  const byBeat = new Map();
  changes.forEach((c) => { const k = Math.round(c.beat * 1000); if (!byBeat.has(k)) byBeat.set(k, c); });
  changes = [...byBeat.values()].sort((a, b) => a.beat - b.beat);
  const baseTempo = changes.length ? changes[0].bpm : 90;
  const segs = [];
  let secs = 0;
  let prevBeat = 0;
  let prevBpm = baseTempo;
  changes.forEach((c) => {
    if (c.beat > prevBeat) { secs += ((c.beat - prevBeat) * 60) / prevBpm; prevBeat = c.beat; }
    prevBpm = c.bpm;
    segs.push({ beat: c.beat, sec: secs, bpm: c.bpm });
  });
  if (!segs.length || segs[0].beat > 0) segs.unshift({ beat: 0, sec: 0, bpm: baseTempo });
  const beatToSec = (beat) => {
    let s = segs[0];
    for (let i = 0; i < segs.length && segs[i].beat <= beat + 1e-9; i++) s = segs[i];
    return s.sec + ((beat - s.beat) * 60) / s.bpm;
  };
  const secToBeat = (sec) => {
    let s = segs[0];
    for (let i = 0; i < segs.length && segs[i].sec <= sec + 1e-9; i++) s = segs[i];
    return s.beat + ((sec - s.sec) * s.bpm) / 60;
  };

  const tracks = rawTracks.map((t, i) => ({ id: String(i), name: t.name }));
  const events = [];
  rawTracks.forEach((t, i) => {
    t.events.forEach((e) => {
      const a = beatToSec(e.start);
      const b = beatToSec(e.end);
      events.push({ t: a, d: Math.max(0.05, b - a), midi: e.midi, track: String(i) });
    });
  });
  events.sort((x, y) => x.t - y.t);

  const solfa = {
    measures: measureMarks.map((m, i) => ({
      num: m.num,
      start: m.beat,
      end: i + 1 < measureMarks.length ? measureMarks[i + 1].beat : maxBeat,
      key: m.key,
      time: m.time,
    })),
    tracks: rawTracks.map((t, i) => ({
      id: String(i),
      name: t.name,
      events: t.events.map((e) => ({ start: e.start, end: e.end, midi: e.midi, alter: e.alter })),
    })),
  };

  return {
    title,
    tracks,
    solfa,
    events,
    totalSec: beatToSec(maxBeat),
    baseTempo,
    measures: measureMarks.map((m) => ({ num: m.num, sec: beatToSec(m.beat) })),
    secToWhole: (sec) => secToBeat(sec) / 4, // whole-note units, as used by OSMD
  };
}

// Which track should be the singer's "own" one, given e.g. "Soprano I" or "Bass II"?
export function guessMyTrackId(tracks, memberPart) {
  if (!memberPart) return null;
  const base = String(memberPart).trim().slice(0, 3).toLowerCase();
  if (!base) return null;
  const hit = tracks.find((t) => t.name.toLowerCase().includes(base));
  return hit ? hit.id : null;
}

// ---------------------------------------------------------------------------
// Playback (Web Audio, soft "ooh" sound so there are no sound files to download)
// ---------------------------------------------------------------------------

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class ScorePlayer {
  constructor(score, onEnded) {
    this.score = score;
    this.onEnded = onEnded || (() => {});
    this.rate = 1;
    this.volumes = {};
    this.pos = 0;
    this.playing = false;
    this.ctx = null;
    this.master = null;
    this.trackGains = new Map();
    this.timer = null;
    this.nextIdx = 0;
    this.startCtx = 0;
    this.offset = 0;
    this.active = new Set();
  }

  _ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      this.score.tracks.forEach((t) => {
        const filter = this.ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 2200;
        const g = this.ctx.createGain();
        g.gain.value = this.volumes[t.id] ?? 1;
        g.connect(filter);
        filter.connect(this.master);
        this.trackGains.set(t.id, g);
      });
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  setTrackVolume(id, v) {
    this.volumes[id] = v;
    const g = this.trackGains.get(id);
    if (g && this.ctx) g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  position() {
    if (!this.playing) return this.pos;
    const p = this.offset + (this.ctx.currentTime - this.startCtx) * this.rate;
    return Math.min(this.score.totalSec, Math.max(this.offset, p));
  }

  play() {
    this._ensureCtx();
    if (this.pos >= this.score.totalSec - 0.05) this.pos = 0;
    this.offset = this.pos;
    this.startCtx = this.ctx.currentTime + 0.05;
    const ev = this.score.events;
    let i = 0;
    while (i < ev.length && ev[i].t < this.offset - 1e-6) i++;
    this.nextIdx = i;
    // Notes that were already sounding at the resume point continue for their remaining length.
    for (let k = 0; k < i; k++) {
      const e = ev[k];
      if (e.t + e.d > this.offset + 0.08) this._note({ ...e, t: this.offset, d: e.t + e.d - this.offset }, this.startCtx);
    }
    this.playing = true;
    this.timer = setInterval(() => this._tick(), 30);
    this._tick();
  }

  _tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const horizon = now + 0.2;
    const ev = this.score.events;
    while (this.nextIdx < ev.length) {
      const e = ev[this.nextIdx];
      const when = this.startCtx + (e.t - this.offset) / this.rate;
      if (when > horizon) break;
      this._note(e, Math.max(when, now));
      this.nextIdx++;
    }
    if (this.position() >= this.score.totalSec - 1e-3 && this.nextIdx >= ev.length) {
      this.pause();
      this.pos = this.score.totalSec;
      this.onEnded();
    }
  }

  _note(e, when) {
    const ctx = this.ctx;
    const dest = this.trackGains.get(e.track);
    if (!dest) return;
    const dur = Math.max(0.06, e.d / this.rate - 0.03);
    const stopT = when + dur;
    const att = Math.min(0.04, dur * 0.3);
    const rel = Math.min(0.09, dur * 0.4);
    const peak = 0.16;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + att);
    g.gain.setValueAtTime(peak, Math.max(when + att, stopT - rel));
    g.gain.linearRampToValueAtTime(0, stopT + 0.02);
    g.connect(dest);
    const f = midiToFreq(e.midi);
    const oscs = [["sine", 0], ["triangle", 5]].map(([type, detune]) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(g);
      o.start(when);
      o.stop(stopT + 0.06);
      return o;
    });
    const rec = { g, oscs };
    this.active.add(rec);
    oscs[0].onended = () => { this.active.delete(rec); try { g.disconnect(); } catch { /* already gone */ } };
  }

  _halt() {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.active.forEach(({ g, oscs }) => {
      try {
        g.gain.cancelScheduledValues(now);
        g.gain.setTargetAtTime(0, now, 0.015);
        oscs.forEach((o) => o.stop(now + 0.08));
      } catch { /* note already finished */ }
    });
    this.active.clear();
  }

  pause() {
    if (!this.playing) return;
    this.pos = this.position();
    this._halt();
  }

  seek(sec) {
    const s = Math.min(this.score.totalSec, Math.max(0, sec));
    if (this.playing) { this._halt(); this.pos = s; this.play(); }
    else this.pos = s;
  }

  setRate(r) {
    if (this.playing) { const p = this.position(); this._halt(); this.pos = p; this.rate = r; this.play(); }
    else this.rate = r;
  }

  dispose() {
    this._halt();
    if (this.ctx) { try { this.ctx.close(); } catch { /* ignore */ } this.ctx = null; }
  }
}

// ---------------------------------------------------------------------------
// A short 4-bar SATB chorale (original, public domain) so people can try the reader.
// ---------------------------------------------------------------------------

function sampleMeasure(num, parts) {
  // parts: array of [step, octave, type] per quarter-note beat, for one voice
  return parts.map(([step, octave, type]) =>
    `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${type === "half" ? 2 : 1}</duration><voice>1</voice><type>${type}</type></note>`
  ).join("");
}

export function sampleScoreXml() {
  const voices = {
    Soprano: { clef: "<sign>G</sign><line>2</line>", bars: [
      [["E", 5, "quarter"], ["E", 5, "quarter"], ["D", 5, "quarter"], ["C", 5, "quarter"]],
      [["D", 5, "quarter"], ["E", 5, "quarter"], ["D", 5, "half"]],
      [["E", 5, "quarter"], ["G", 5, "quarter"], ["F", 5, "quarter"], ["E", 5, "quarter"]],
      [["D", 5, "quarter"], ["B", 4, "quarter"], ["C", 5, "half"]],
    ] },
    Alto: { clef: "<sign>G</sign><line>2</line>", bars: [
      [["C", 5, "quarter"], ["B", 4, "quarter"], ["B", 4, "quarter"], ["G", 4, "quarter"]],
      [["G", 4, "quarter"], ["G", 4, "quarter"], ["G", 4, "half"]],
      [["C", 5, "quarter"], ["C", 5, "quarter"], ["C", 5, "quarter"], ["B", 4, "quarter"]],
      [["G", 4, "quarter"], ["G", 4, "quarter"], ["E", 4, "half"]],
    ] },
    Tenor: { clef: "<sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change>", bars: [
      [["G", 4, "quarter"], ["G", 4, "quarter"], ["F", 4, "quarter"], ["E", 4, "quarter"]],
      [["B", 3, "quarter"], ["C", 4, "quarter"], ["B", 3, "half"]],
      [["G", 4, "quarter"], ["E", 4, "quarter"], ["F", 4, "quarter"], ["G", 4, "quarter"]],
      [["G", 3, "quarter"], ["D", 4, "quarter"], ["C", 4, "half"]],
    ] },
    Bass: { clef: "<sign>F</sign><line>4</line>", bars: [
      [["C", 3, "quarter"], ["G", 2, "quarter"], ["G", 2, "quarter"], ["C", 3, "quarter"]],
      [["G", 2, "quarter"], ["C", 3, "quarter"], ["G", 2, "half"]],
      [["C", 3, "quarter"], ["C", 3, "quarter"], ["A", 2, "quarter"], ["E", 3, "quarter"]],
      [["G", 2, "quarter"], ["G", 2, "quarter"], ["C", 3, "half"]],
    ] },
  };
  const names = Object.keys(voices);
  const partList = names.map((n, i) => `<score-part id="P${i + 1}"><part-name>${n}</part-name></score-part>`).join("");
  const parts = names.map((n, i) => {
    const v = voices[n];
    const measures = v.bars.map((b, bi) => {
      const attrs = bi === 0
        ? `<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef>${v.clef}</clef></attributes>` +
          (i === 0 ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>84</per-minute></metronome></direction-type><sound tempo="84"/></direction>` : "")
        : "";
      return `<measure number="${bi + 1}">${attrs}${sampleMeasure(bi + 1, b)}</measure>`;
    }).join("");
    return `<part id="P${i + 1}">${measures}</part>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="3.1"><work><work-title>Sample chorale</work-title></work><part-list>${partList}</part-list>${parts}</score-partwise>`;
}


// ---------------------------------------------------------------------------
// Tonic sol-fa (movable doh): converts the parsed score to a stacked solfa sheet.
// ---------------------------------------------------------------------------

const SOLFA_NATURAL = { 0: "d", 2: "r", 4: "m", 5: "f", 7: "s", 9: "l", 11: "t" };
const SOLFA_SHARP = { 1: "di", 3: "ri", 6: "fi", 8: "si", 10: "li" };
const SOLFA_FLAT = { 1: "ra", 3: "ma", 6: "se", 8: "le", 10: "te" };
const SUP = ["", "¹", "²", "³", "⁴"];
const SUB = ["", "₁", "₂", "₃", "₄"];
const MAJOR_NAMES = { "-7": "C♭", "-6": "G♭", "-5": "D♭", "-4": "A♭", "-3": "E♭", "-2": "B♭", "-1": "F", 0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F♯", 7: "C♯" };
const MINOR_NAMES = { "-7": "A♭", "-6": "E♭", "-5": "B♭", "-4": "F", "-3": "C", "-2": "G", "-1": "D", 0: "A", 1: "E", 2: "B", 3: "F♯", 4: "C♯", 5: "G♯", 6: "D♯", 7: "A♯" };

const mod12 = (n) => ((n % 12) + 12) % 12;

function keyInfo(key) {
  const f = Math.max(-7, Math.min(7, key.fifths || 0));
  const dohPc = mod12(f * 7);
  // the doh nearest to middle C (ties go lower): its octave is the unmarked one
  const lower = 60 - mod12(60 - dohPc);
  const base = 60 - lower <= lower + 12 - 60 ? lower : lower + 12;
  const minor = key.mode === "minor";
  return { dohPc, base, label: `Doh is ${MAJOR_NAMES[f]}${minor ? ` · Lah is ${MINOR_NAMES[f]}` : ""}` };
}

function toSolfa(e, info) {
  const off = mod12(e.midi - info.dohPc);
  const name = SOLFA_NATURAL[off] || (e.alter > 0 ? SOLFA_SHARP[off] : SOLFA_FLAT[off]);
  const oct = Math.floor((e.midi - info.base) / 12);
  return name + (oct > 0 ? SUP[Math.min(oct, 4)] : oct < 0 ? SUB[Math.min(-oct, 4)] : "");
}

function shortLabel(name) {
  const split = name.match(/^(.*) · voice (\d+)$/);
  if (split) return split[1].slice(0, 3) + split[2];
  const lower = name.trim().toLowerCase();
  const num = name.match(/\s(\d)\s*$/);
  const base = /^sop/.test(lower) ? "S" : /^(alt|con)/.test(lower) ? "A" : /^ten/.test(lower) ? "T" : /^bas/.test(lower) ? "B" : null;
  return base ? base + (num ? num[1] : "") : name.trim().slice(0, 4);
}

const GRIDS = [1, 2, 3, 4, 6, 8, 12, 16];

export function buildSolfa(score, barsPerLine = 4) {
  const sf = score && score.solfa;
  if (!sf || !sf.measures.length) return { systems: [], plain: "" };
  const { measures, tracks } = sf;
  const labels = tracks.map((t) => shortLabel(t.name));
  const labelW = Math.max(...labels.map((l) => l.length));
  const eps = 1e-3;

  const built = measures.map((m, mi) => {
    const { beats, beatType } = m.time;
    const compound = beatType === 8 && beats >= 6 && beats % 3 === 0;
    const P = compound ? 1.5 : 4 / beatType;
    const full = (beats * 4) / beatType;
    const L = m.end - m.start;
    const pickup = mi === 0 && L < full - eps;
    const vStart = pickup ? m.end - full : m.start;
    const nP = pickup ? Math.max(1, Math.round(full / P)) : Math.max(1, Math.ceil((L - eps) / P));
    const info = keyInfo(m.key);
    const evs = tracks.map((t) => t.events.filter((e) => e.end > m.start + eps && e.start < m.end - eps));
    const cells = tracks.map(() => []);

    for (let p = 0; p < nP; p++) {
      const ps = vStart + p * P;
      let d = 16;
      for (const cand of GRIDS) {
        const unit = P / cand;
        let ok = true;
        for (let ti = 0; ti < evs.length && ok; ti++) {
          for (const e of evs[ti]) {
            for (const tt of [e.start, e.end]) {
              if (tt <= ps - eps || tt >= ps + P + eps) continue;
              const k = (tt - ps) / unit;
              if (Math.abs(k - Math.round(k)) > 0.02) { ok = false; break; }
            }
            if (!ok) break;
          }
        }
        if (ok) { d = cand; break; }
      }
      tracks.forEach((t, ti) => {
        const toks = [];
        for (let i = 0; i < d; i++) {
          const at = ps + (i * P) / d;
          let best = null;
          for (const e of evs[ti]) {
            if (e.start <= at + eps && e.end > at + eps && (!best || e.midi > best.midi)) best = e;
          }
          toks.push(best ? (Math.abs(best.start - at) < eps ? toSolfa(best, info) : "-") : "");
        }
        let str = "";
        toks.forEach((tok, i) => {
          if (i > 0) str += d === 3 ? "." : i === d / 2 ? "." : ",";
          str += tok;
        });
        cells[ti].push(toks.every((x) => x === "") ? "" : str);
      });
    }

    const widths = [];
    for (let p = 0; p < nP; p++) widths.push(Math.max(...cells.map((c) => c[p].length)));
    const texts = cells.map((c) => {
      let out = "";
      c.forEach((cell, p) => {
        if (p > 0) out += ` ${nP === 4 && p === 2 ? "!" : ":"} `;
        out += cell.padEnd(widths[p]);
      });
      return out;
    });
    return { idx: mi, num: m.num, key: m.key, keyLabel: info.label, texts };
  });

  const systems = [];
  for (let s = 0; s < built.length; s += barsPerLine) {
    const bars = built.slice(s, s + barsPerLine);
    const changes = bars.slice(1).filter((b, i) => b.keyLabel !== bars[i].keyLabel);
    const keyLabel = bars[0].keyLabel + changes.map((b) => `  → bar ${b.num}: ${b.keyLabel}`).join("");
    systems.push({
      startNum: bars[0].num,
      keyLabel,
      lines: tracks.map((t, ti) => ({
        label: labels[ti].padEnd(labelW),
        last: s + barsPerLine >= built.length,
        bars: bars.map((b) => ({ idx: b.idx, text: b.texts[ti] })),
      })),
    });
  }

  const plain = systems.map((sys) => {
    const head = `Bar ${sys.startNum} — ${sys.keyLabel}`;
    const rows = sys.lines.map((ln) => `${ln.label} ${ln.bars.map((b) => `| ${b.text} `).join("")}${ln.last ? "||" : "|"}`);
    return [head, ...rows].join("\n");
  }).join("\n\n");

  return { systems, plain };
}
