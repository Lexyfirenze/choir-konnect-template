import React, { useState, useRef, useEffect, useCallback } from "react";
import { Music, Mic, MicOff, Play, Minus, Plus, RotateCcw } from "lucide-react";

/* ---------- Choir Konnect brand tokens (matches App.jsx's C object) ---------- */
const C = {
  ink: "#0B2635",
  ink2: "#123449",
  ink3: "#1A4258",
  turquoise: "#14B8A6",
  turquoiseLight: "#8FEDE0",
  sand: "#F1EAD9",
  card: "#FFFDF8",
  slate: "#5B7480",
  inkText: "#102B39",
  rose: "#E0637A",
  amber: "#E0B34D",
};

/* ---------- Music theory ---------- */
const CHROMATIC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const SCALES = {
  major: { offsets: [0, 2, 4, 5, 7, 9, 11, 12], labels: ["Do", "Re", "Mi", "Fa", "Sol", "La", "Ti", "Do"] },
  minor: { offsets: [0, 2, 3, 5, 7, 8, 10, 12], labels: ["Do", "Re", "Me", "Fa", "Sol", "Le", "Te", "Do"] },
  chromatic: {
    offsets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    labels: ["Do", "Di", "Re", "Ri", "Mi", "Fa", "Fi", "Sol", "Si", "La", "Li", "Ti", "Do"],
  },
};

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

/* Autocorrelation pitch detection (ACF2+ pattern) */
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) {
    const val = buf[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.012) return -1;

  let r1 = 0,
    r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) {
    if (Math.abs(buf[i]) < thres) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < SIZE / 2; i++) {
    if (Math.abs(buf[SIZE - i]) < thres) {
      r2 = SIZE - i;
      break;
    }
  }
  const trimmed = buf.slice(r1, r2);
  const TSIZE = trimmed.length;
  if (TSIZE < 8) return -1;

  const c = new Array(TSIZE).fill(0);
  for (let i = 0; i < TSIZE; i++) {
    for (let j = 0; j < TSIZE - i; j++) {
      c[i] += trimmed[j] * trimmed[j + i];
    }
  }

  let d = 0;
  while (d < TSIZE - 1 && c[d] > c[d + 1]) d++;

  let maxval = -1,
    maxpos = -1;
  for (let i = d; i < TSIZE; i++) {
    if (c[i] > maxval) {
      maxval = c[i];
      maxpos = i;
    }
  }
  let T0 = maxpos;
  if (T0 <= 0) return -1;

  const x1 = c[T0 - 1] || 0,
    x2 = c[T0],
    x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);

  if (T0 <= 0) return -1;
  const freq = sampleRate / T0;
  if (freq < 60 || freq > 1200) return -1;
  return freq;
}

/* ---------- Component ---------- */
export default function SolfegeSinger() {
  const [rootOffset, setRootOffset] = useState(0);
  const [scaleType, setScaleType] = useState("major");
  const [voiceRange, setVoiceRange] = useState("high");
  const [mode, setMode] = useState("find");
  const [view, setView] = useState("piano");

  const [targetIndex, setTargetIndex] = useState(2);
  const [foundSet, setFoundSet] = useState(new Set());
  const [isListening, setIsListening] = useState(false);
  const [micError, setMicError] = useState(null);
  const [detectedCents, setDetectedCents] = useState(null);
  const [detectedLabel, setDetectedLabel] = useState(null);
  const [justCorrect, setJustCorrect] = useState(false);
  const [timeLeft, setTimeLeft] = useState(6);
  const [missed, setMissed] = useState(false);
  const [warmupStep, setWarmupStep] = useState(-1);

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const dataRef = useRef(null);
  const lastMatchTimeRef = useRef(null);
  const timerRef = useRef(null);

  const scale = SCALES[scaleType];
  const baseMidi = (voiceRange === "low" ? 48 : 60) + rootOffset;
  const rootName = CHROMATIC_NAMES[((rootOffset % 12) + 12) % 12];
  const degreeMidi = (i) => baseMidi + scale.offsets[i];
  const targetMidi = degreeMidi(targetIndex);

  const playTone = useCallback((midi, duration = 0.55) => {
    const ctx = audioCtxRef.current || new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = midiToFreq(midi);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.05);
  }, []);

  const stopListening = useCallback(() => {
    setIsListening(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setDetectedCents(null);
    setDetectedLabel(null);
    lastMatchTimeRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const nearestDegreeInfo = (midi) => {
    let best = { dist: Infinity, label: "", cents: 0 };
    for (let i = 0; i < scale.offsets.length; i++) {
      const dm = degreeMidi(i);
      const diff = midi - dm;
      if (Math.abs(diff) < Math.abs(best.dist)) {
        best = { dist: diff, label: scale.labels[i], cents: Math.round(diff * 100) };
      }
    }
    return best;
  };

  function handleCorrect() {
    setJustCorrect(true);
    setFoundSet((prev) => new Set(prev).add(scale.labels[targetIndex] + targetIndex));
    lastMatchTimeRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    setTimeout(() => {
      setJustCorrect(false);
      pickNewTarget(targetIndex);
    }, 700);
  }

  const tick = useCallback(() => {
    const analyser = analyserRef.current;
    const ctx = audioCtxRef.current;
    if (!analyser || !ctx) return;
    const buf = dataRef.current;
    analyser.getFloatTimeDomainData(buf);
    const freq = autoCorrelate(buf, ctx.sampleRate);

    if (freq !== -1) {
      const midi = freqToMidi(freq);
      if (mode === "free" || mode === "warmup") {
        const info = nearestDegreeInfo(midi);
        setDetectedLabel(info.label);
        setDetectedCents(info.cents);
      } else {
        const cents = Math.round((midi - targetMidi) * 100);
        setDetectedCents(cents);
        setDetectedLabel(scale.labels[targetIndex]);
        if (Math.abs(cents) <= 45) {
          const now = performance.now();
          if (lastMatchTimeRef.current === null) lastMatchTimeRef.current = now;
          const streak = now - lastMatchTimeRef.current;
          if (streak > 350) handleCorrect();
        } else {
          lastMatchTimeRef.current = null;
        }
      }
    } else {
      setDetectedCents(null);
      setDetectedLabel(null);
      lastMatchTimeRef.current = null;
    }
    rafRef.current = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, targetIndex, targetMidi, scale]);

  const startListening = useCallback(async () => {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      streamRef.current = stream;
      const ctx = audioCtxRef.current || new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = ctx;
      if (ctx.state === "suspended") await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      dataRef.current = new Float32Array(analyser.fftSize);
      source.connect(analyser);
      analyserRef.current = analyser;
      setIsListening(true);
    } catch (err) {
      setMicError("Couldn't access your microphone. Check your browser's mic permission for this page.");
    }
  }, []);

  useEffect(() => {
    if (isListening) rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isListening, tick]);

  useEffect(() => stopListening, [stopListening]);

  function pickNewTarget(excludeIndex) {
    const singable = scale.offsets.length - 1;
    let idx;
    do {
      idx = Math.floor(Math.random() * (singable + 1));
    } while (idx === excludeIndex && singable > 0);
    setTargetIndex(idx);
    lastMatchTimeRef.current = null;
    setMissed(false);
    if (mode === "timed") setTimeLeft(6);
  }

  function newSequence() {
    setFoundSet(new Set());
    pickNewTarget(null);
  }

  useEffect(() => {
    if (mode !== "timed" || !isListening || justCorrect) return;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          setMissed(true);
          clearInterval(timerRef.current);
          setTimeout(() => pickNewTarget(targetIndex), 900);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isListening, targetIndex, justCorrect]);

  function runWarmup() {
    stopListening();
    const seq = [...Array(scale.offsets.length).keys()].concat([...Array(scale.offsets.length).keys()].reverse().slice(1));
    let i = 0;
    setWarmupStep(seq[0]);
    playTone(degreeMidi(seq[0]));
    const interval = setInterval(() => {
      i++;
      if (i >= seq.length) {
        clearInterval(interval);
        setTimeout(() => setWarmupStep(-1), 600);
        return;
      }
      setWarmupStep(seq[i]);
      playTone(degreeMidi(seq[i]));
    }, 750);
  }

  function changeMode(m) {
    stopListening();
    setMode(m);
    setMissed(false);
    setJustCorrect(false);
    setWarmupStep(-1);
    if (m === "find" || m === "timed") {
      setFoundSet(new Set());
      pickNewTarget(null);
    }
  }

  const blackSemitoneAfter = { 0: 1, 2: 3, 5: 6, 7: 8, 9: 10 };
  const isTargetActive = mode === "find" || mode === "timed";

  return (
    <div style={{ background: C.ink, minHeight: "100%", padding: "20px 16px 40px", fontFamily: "'Outfit', sans-serif", color: C.turquoiseLight }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <div style={{ width: 34, height: 34, borderRadius: 9, background: C.ink2, border: `1px solid ${C.turquoise}`, display: "flex", alignItems: "center", justifyContent: "center", color: C.turquoise }}>
          <Music size={17} />
        </div>
        <div>
          <div style={{ fontFamily: "'Playfair Display', serif", fontStyle: "italic", fontSize: 19, color: C.turquoiseLight }}>Solfège Singer</div>
          <div style={{ fontSize: 11, color: C.slate }}>Practice pitch, ear, and sight-singing</div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <button onClick={() => setRootOffset((r) => r - 1)} style={pillBtn(false)}>
          <Minus size={14} />
        </button>
        <div style={{ ...pillBtn(true), minWidth: 84, textAlign: "center", cursor: "default" }}>Do = {rootName}</div>
        <button onClick={() => setRootOffset((r) => r + 1)} style={pillBtn(false)}>
          <Plus size={14} />
        </button>
        <div style={{ width: 1, height: 22, background: "rgba(143,237,224,0.2)", margin: "0 4px" }} />
        <button onClick={() => setView("piano")} style={pillBtn(view === "piano")}>Piano</button>
        <button onClick={() => setView("staff")} style={pillBtn(view === "staff")}>Staff</button>
      </div>

      {view === "piano" ? (
        <PianoView
          scale={scale}
          targetIndex={isTargetActive ? targetIndex : warmupStep >= 0 ? warmupStep : null}
          justCorrect={justCorrect}
          missed={missed}
          onKeyPress={(semitone, idx) => {
            if (idx !== null) playTone(baseMidi + semitone);
          }}
        />
      ) : (
        <StaffView degree={isTargetActive ? targetIndex : 0} scale={scale} baseMidi={baseMidi} justCorrect={justCorrect} />
      )}

      <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
        {["major", "minor", "chromatic"].map((s) => (
          <button key={s} onClick={() => setScaleType(s)} style={pillBtn(scaleType === s)}>
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
        <div style={{ width: 1, height: 22, background: "rgba(143,237,224,0.2)", margin: "0 4px" }} />
        {["low", "high"].map((v) => (
          <button key={v} onClick={() => setVoiceRange(v)} style={pillBtn(voiceRange === v)}>
            {v[0].toUpperCase() + v.slice(1)} voice
          </button>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {[["warmup", "Warm-up"], ["find", "Find"], ["free", "Free"], ["timed", "Timed"]].map(([key, label]) => (
          <button key={key} onClick={() => changeMode(key)} style={pillBtn(mode === key)}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 22, background: C.ink2, borderRadius: 16, padding: "16px 18px", border: "1px solid rgba(20,184,166,0.18)" }}>
        <div style={{ fontSize: 12, color: C.slate, marginBottom: 10, textAlign: "center" }}>
          {mode === "warmup" ? "Listen and echo each note back" : mode === "free" ? "Sing anything — see what you're singing" : "Find the glowing note with your voice"}
        </div>
        <Tuner cents={detectedCents} label={detectedLabel} active={isListening} />
      </div>

      {mode === "timed" && isListening && !justCorrect && (
        <div style={{ textAlign: "center", marginTop: 10, fontSize: 13, color: missed ? C.rose : C.slate }}>
          {missed ? "Missed — next note coming up" : `${timeLeft}s to match the note`}
        </div>
      )}

      {isTargetActive && (
        <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
          {scale.labels.slice(0, scale.offsets.length - 1).map((label, i) => {
            const key = label + i;
            const found = foundSet.has(key);
            return (
              <div
                key={key}
                style={{
                  padding: "8px 14px",
                  borderRadius: 10,
                  fontSize: 13,
                  fontWeight: 600,
                  background: found ? "rgba(20,184,166,0.16)" : "transparent",
                  border: `1px solid ${found ? C.turquoise : "rgba(143,237,224,0.25)"}`,
                  color: found ? C.turquoiseLight : C.slate,
                }}
              >
                {label} {found ? "✓" : ""}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 24 }}>
        {mode === "warmup" ? (
          <button onClick={runWarmup} style={primaryBtn()}>
            <Play size={15} style={{ marginRight: 6 }} /> Play scale
          </button>
        ) : (
          <>
            {(mode === "find" || mode === "timed") && (
              <button onClick={newSequence} style={ghostBtn()}>
                <RotateCcw size={14} style={{ marginRight: 6 }} /> New sequence
              </button>
            )}
            {!isListening ? (
              <button onClick={startListening} style={primaryBtn()}>
                <Mic size={15} style={{ marginRight: 6 }} /> Start listening
              </button>
            ) : (
              <button onClick={stopListening} style={dangerBtn()}>
                <MicOff size={15} style={{ marginRight: 6 }} /> Stop
              </button>
            )}
          </>
        )}
      </div>

      {micError && (
        <div style={{ textAlign: "center", marginTop: 14, fontSize: 12.5, color: C.rose, maxWidth: 360, marginLeft: "auto", marginRight: "auto" }}>
          {micError}
        </div>
      )}
    </div>
  );
}

function pillBtn(active) {
  return {
    padding: "8px 16px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 500,
    border: `1px solid ${active ? "transparent" : "rgba(143,237,224,0.25)"}`,
    background: active ? C.turquoise : "transparent",
    color: active ? C.ink : C.turquoiseLight,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  };
}
function primaryBtn() {
  return {
    padding: "12px 22px",
    borderRadius: 999,
    fontSize: 14.5,
    fontWeight: 600,
    border: "none",
    background: C.turquoise,
    color: C.ink,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  };
}
function ghostBtn() {
  return {
    padding: "12px 20px",
    borderRadius: 999,
    fontSize: 14.5,
    fontWeight: 500,
    border: "1px solid rgba(143,237,224,0.3)",
    background: "transparent",
    color: C.turquoiseLight,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  };
}
function dangerBtn() {
  return {
    padding: "12px 22px",
    borderRadius: 999,
    fontSize: 14.5,
    fontWeight: 600,
    border: "none",
    background: C.rose,
    color: "#fff",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
  };
}

function Tuner({ cents, label, active }) {
  const clamped = cents === null ? 0 : Math.max(-50, Math.min(50, cents));
  const pct = 50 + clamped;
  const inTune = cents !== null && Math.abs(cents) <= 12;
  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: 8 }}>
        <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, color: cents === null ? C.slate : inTune ? C.turquoiseLight : C.amber }}>
          {label || (active ? "Listening…" : "—")}
        </span>
      </div>
      <div style={{ position: "relative", height: 8, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, background: "rgba(255,255,255,0.25)" }} />
        {cents !== null && (
          <div
            style={{
              position: "absolute",
              left: `${pct}%`,
              top: -3,
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: inTune ? C.turquoise : C.amber,
              transform: "translateX(-50%)",
              transition: "left 0.08s linear",
            }}
          />
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.slate, marginTop: 4 }}>
        <span>flat</span>
        <span>in tune</span>
        <span>sharp</span>
      </div>
    </div>
  );
}

function PianoView({ scale, targetIndex, justCorrect, missed, onKeyPress }) {
  const whiteSemitones = [0, 2, 4, 5, 7, 9, 11];
  const blackSemitone = { 0: 1, 2: 3, 5: 6, 7: 8, 9: 10 };
  const whiteWidth = 42;

  function labelForSemitone(semi) {
    const idx = scale.offsets.findIndex((o) => o === semi);
    if (idx === -1) return null;
    return scale.labels[idx];
  }
  function isTarget(semi) {
    if (targetIndex === null) return false;
    return scale.offsets[targetIndex] === semi;
  }

  return (
    <div style={{ display: "flex", justifyContent: "center", overflowX: "auto", padding: "4px 0" }}>
      <div style={{ position: "relative", display: "flex" }}>
        {whiteSemitones.concat([12]).map((semi, i) => {
          const label = labelForSemitone(semi);
          const active = isTarget(semi);
          const idx = scale.offsets.findIndex((o) => o === semi);
          return (
            <div
              key={i}
              onClick={() => onKeyPress(semi, idx === -1 ? null : idx)}
              style={{
                width: whiteWidth,
                height: 120,
                background: active ? (justCorrect ? C.turquoise : missed ? C.rose : C.amber) : C.sand,
                border: `1px solid ${C.ink}`,
                borderRadius: "0 0 6px 6px",
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
                paddingBottom: 8,
                fontSize: 12,
                fontWeight: 600,
                color: C.inkText,
                cursor: "pointer",
                flexShrink: 0,
                transition: "background 0.15s ease",
              }}
            >
              {label || ""}
            </div>
          );
        })}
        {whiteSemitones.map((semi, i) => {
          const bSemi = blackSemitone[semi];
          if (bSemi === undefined) return null;
          const label = labelForSemitone(bSemi);
          const active = isTarget(bSemi);
          const idx = scale.offsets.findIndex((o) => o === bSemi);
          return (
            <div
              key={"b" + i}
              onClick={(e) => {
                e.stopPropagation();
                onKeyPress(bSemi, idx === -1 ? null : idx);
              }}
              style={{
                position: "absolute",
                left: whiteWidth * (i + 1) - 13,
                width: 26,
                height: 72,
                background: active ? (justCorrect ? C.turquoise : missed ? C.rose : C.amber) : C.ink,
                border: `1px solid ${C.ink}`,
                borderRadius: "0 0 4px 4px",
                zIndex: 2,
                cursor: "pointer",
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
                paddingBottom: 6,
                fontSize: 9.5,
                color: active ? C.ink : C.turquoiseLight,
                fontWeight: 600,
              }}
            >
              {label || ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StaffView({ degree, scale, baseMidi, justCorrect }) {
  const midi = baseMidi + scale.offsets[degree];
  const noteNames = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
  const letterIndex = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
  const octave = Math.floor(midi / 12) - 1;
  const letter = noteNames[midi % 12];
  const diatonicPos = letterIndex[letter] + octave * 7;
  const middleCPos = letterIndex["C"] + 4 * 7;
  const stepsFromMiddleC = diatonicPos - middleCPos;
  const y = 90 - stepsFromMiddleC * 5.2;

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}>
      <svg width={220} height={160} style={{ background: C.sand, borderRadius: 12 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <line key={i} x1={30} x2={190} y1={40 + i * 14} y2={40 + i * 14} stroke={C.inkText} strokeWidth={1} />
        ))}
        <text x={12} y={70} fontSize={34} fill={C.inkText} fontFamily="serif">𝄞</text>
        {y < 40 &&
          Array.from({ length: Math.ceil((40 - y) / 14) }).map((_, i) => {
            const ly = 40 - (i + 1) * 14;
            if (ly < y - 6) return null;
            return <line key={i} x1={95} x2={115} y1={ly} y2={ly} stroke={C.inkText} strokeWidth={1} />;
          })}
        {y > 96 &&
          Array.from({ length: Math.ceil((y - 96) / 14) }).map((_, i) => {
            const ly = 96 + (i + 1) * 14;
            if (ly > y + 6) return null;
            return <line key={i} x1={95} x2={115} y1={ly} y2={ly} stroke={C.inkText} strokeWidth={1} />;
          })}
        <ellipse cx={105} cy={y} rx={8} ry={6} fill={justCorrect ? C.turquoise : C.amber} />
        <text x={90} y={140} fontSize={13} fill={C.inkText} fontWeight={600} textAnchor="middle">
          {scale.labels[degree]}
        </text>
      </svg>
    </div>
  );
}
