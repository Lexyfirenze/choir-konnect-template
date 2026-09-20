import React, { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, RotateCcw, Upload } from "lucide-react";
import { parseMusicXml, readScoreFile, readScoreUrl, ScorePlayer, sampleScoreXml, guessMyTrackId, buildSolfa } from "../lib/scoreEngine";

const fmtTime = (s) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

const RATES = [0.5, 0.75, 1, 1.25];

// Score reader: opens a MusicXML file, draws the sheet music (OpenSheetMusicDisplay),
// and plays it back with a part selector so a singer can hear their own line louder.
export default function ScoreReader({ C, gradient, myPart, initialUrl, initialView }) {
  const [score, setScore] = useState(null);
  const [xml, setXml] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sheetStatus, setSheetStatus] = useState("idle"); // idle | loading | ready | error
  const [focus, setFocus] = useState("all");
  const [soft, setSoft] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [rate, setRate] = useState(1);
  const [fromBar, setFromBar] = useState("");
  const [zoom, setZoom] = useState(0.8);
  const [view, setView] = useState(initialView || "staff"); // staff | solfa
  const [barsPerLine, setBarsPerLine] = useState(() => (typeof window !== "undefined" && window.innerWidth < 560 ? 2 : 4));
  const [copied, setCopied] = useState(false);

  const containerRef = useRef(null);
  const osmdRef = useRef(null);
  const playerRef = useRef(null);
  const cursorMapRef = useRef([]);
  const cursorIdxRef = useRef(0);
  const scoreRef = useRef(null);
  scoreRef.current = score;
  const zoomRef = useRef(0.8);

  /* ---------- loading a file ---------- */
  const loadText = (text) => {
    try {
      const parsed = parseMusicXml(text);
      setError("");
      setPlaying(false);
      setPos(0);
      setRate(1);
      setFocus(guessMyTrackId(parsed.tracks, myPart) || "all");
      setScore(parsed);
      setXml(text);
    } catch (e) {
      setError(e.message || "Could not read that file.");
    }
  };

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { setError("That file is too large (12 MB max)."); return; }
    setBusy(true);
    try {
      loadText(await readScoreFile(file));
    } catch (err) {
      setError(err.message || "Could not read that file.");
    } finally {
      setBusy(false);
    }
  };

  // When opened for a stored score (e.g. from the Library), load it straight away.
  useEffect(() => {
    if (!initialUrl) return undefined;
    let cancelled = false;
    setBusy(true);
    setError("");
    readScoreUrl(initialUrl)
      .then((text) => { if (!cancelled) loadText(text); })
      .catch((e) => { if (!cancelled) setError(e.message || "Could not open that score."); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [initialUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- audio player lifecycle ---------- */
  useEffect(() => {
    if (!score) return undefined;
    const player = new ScorePlayer(score, () => { setPlaying(false); setPos(score.totalSec); });
    playerRef.current = player;
    return () => { player.dispose(); playerRef.current = null; };
  }, [score]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !score) return;
    score.tracks.forEach((t) => {
      const v = focus === "all" ? 1 : t.id === focus ? 1 : soft ? 0.22 : 0;
      player.setTrackVolume(t.id, v);
    });
  }, [score, focus, soft]);

  useEffect(() => {
    if (playerRef.current) playerRef.current.setRate(rate);
  }, [rate, score]);

  /* ---------- sheet music (OpenSheetMusicDisplay, loaded only when needed) ---------- */
  const buildCursorMap = (osmd) => {
    const map = [];
    try {
      const it = osmd.cursor.Iterator;
      osmd.cursor.reset();
      let steps = 0;
      let last = -1;
      let guard = 0;
      while (!it.EndReached && guard++ < 20000) {
        const ts = it.CurrentSourceTimestamp || it.currentTimeStamp;
        const v = ts && typeof ts.RealValue === "number" ? ts.RealValue : null;
        if (v === null) { map.length = 0; break; }
        if (v > last + 1e-9) { map.push({ whole: v, steps }); last = v; }
        osmd.cursor.next();
        steps++;
      }
      osmd.cursor.reset();
      osmd.cursor.show();
    } catch {
      map.length = 0;
    }
    cursorMapRef.current = map;
    cursorIdxRef.current = 0;
  };

  const syncCursor = (sec) => {
    const osmd = osmdRef.current;
    const map = cursorMapRef.current;
    const sc = scoreRef.current;
    if (!osmd || !sc || !map.length) return;
    const w = sc.secToWhole(sec) + 1e-6;
    let lo = 0;
    let hi = map.length - 1;
    let idx = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (map[mid].whole <= w) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx === cursorIdxRef.current) return;
    try {
      if (idx < cursorIdxRef.current) { osmd.cursor.reset(); cursorIdxRef.current = 0; }
      let need = map[idx].steps - map[cursorIdxRef.current].steps;
      for (; need > 0; need--) osmd.cursor.next();
      cursorIdxRef.current = idx;
    } catch {
      cursorMapRef.current = [];
    }
  };

  useEffect(() => {
    if (!xml || !containerRef.current) return undefined;
    let cancelled = false;
    setSheetStatus("loading");
    (async () => {
      try {
        const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = "";
        const osmd = new OpenSheetMusicDisplay(containerRef.current, {
          autoResize: true, backend: "svg", drawTitle: true, followCursor: true,
        });
        osmd.zoom = zoomRef.current;
        await osmd.load(xml);
        if (cancelled) return;
        osmd.render();
        osmdRef.current = osmd;
        buildCursorMap(osmd);
        setSheetStatus("ready");
      } catch (e) {
        if (!cancelled) setSheetStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      try { if (osmdRef.current) osmdRef.current.clear(); } catch { /* ignore */ }
      osmdRef.current = null;
      cursorMapRef.current = [];
    };
  }, [xml]);

  const changeZoom = (z) => {
    const next = Math.min(1.6, Math.max(0.4, z));
    setZoom(next);
    zoomRef.current = next;
    const osmd = osmdRef.current;
    if (!osmd) return;
    try {
      osmd.zoom = next;
      osmd.render();
      buildCursorMap(osmd);
      syncCursor(playerRef.current ? playerRef.current.position() : 0);
    } catch { /* ignore */ }
  };

  /* ---------- transport ---------- */
  useEffect(() => {
    if (!playing) return undefined;
    let raf;
    let lastUi = 0;
    const loop = (ts) => {
      const p = playerRef.current ? playerRef.current.position() : 0;
      syncCursor(p);
      if (ts - lastUi > 100) { setPos(p); lastUi = ts; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.playing) { p.pause(); setPlaying(false); setPos(p.position()); }
    else { p.play(); setPlaying(true); }
  };

  const seekTo = (sec) => {
    const p = playerRef.current;
    if (!p) return;
    p.seek(sec);
    setPos(sec);
    syncCursor(sec);
  };

  const goToBar = () => {
    if (!score) return;
    const n = parseInt(fromBar, 10);
    if (!Number.isFinite(n)) return;
    const m = score.measures.find((x) => x.num === n) || score.measures.find((x) => x.num > n);
    if (m) seekTo(m.sec);
  };

  /* ---------- solfa ---------- */
  const solfa = useMemo(() => (score ? buildSolfa(score, barsPerLine) : null), [score, barsPerLine]);
  let curBar = -1;
  if (score && (playing || pos > 0)) {
    for (let i = 0; i < score.measures.length; i++) {
      if (score.measures[i].sec <= pos + 0.01) curBar = i; else break;
    }
  }
  const showSolfa = view === "solfa" || sheetStatus === "error";
  const solfaFont = Math.min(20, Math.max(9, Math.round((12 * zoom) / 0.8)));

  const copySolfa = async () => {
    if (!solfa) return;
    try {
      await navigator.clipboard.writeText(`${score.title}\n\n${solfa.plain}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked */ }
  };

  /* ---------- styles ---------- */
  const card = { background: C.card, border: `1.4px solid ${C.lilacLine}`, borderRadius: 16, padding: 14, marginBottom: 12 };
  const chip = (active) => ({
    border: "none", cursor: "pointer", borderRadius: 999, padding: "8px 14px", fontSize: 12, fontWeight: 700,
    flexShrink: 0, background: active ? gradient() : C.lilacSoft, color: active ? "#fff" : C.inkSoft, whiteSpace: "nowrap",
  });
  const smallLabel = { fontSize: 10.5, fontWeight: 700, letterSpacing: 1, color: C.inkSoft, textTransform: "uppercase", marginBottom: 6 };

  return (
    <div style={{ padding: "18px 24px 0" }}>
      {/* Open a file */}
      <div style={card}>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: C.ink, marginBottom: 4 }}>
          {score ? score.title : initialUrl ? "Score" : "Score reader"}
        </div>
        <div style={{ fontSize: 11.5, color: C.inkSoft, lineHeight: 1.5, marginBottom: 10 }}>
          {score
            ? `${score.tracks.length} part${score.tracks.length === 1 ? "" : "s"} · ${score.measures.length} bars`
            : initialUrl ? ""
            : "Open a MusicXML file (.musicxml, .xml or .mxl) exported from MuseScore, Finale or Sibelius. Pick your part to hear it louder."}
        </div>
        {initialUrl && busy && <div style={{ fontSize: 12, color: C.inkSoft }}>Loading score…</div>}
        {!initialUrl && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label
            className="dvbc-tap"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: gradient(), color: "#fff", fontWeight: 700, fontSize: 12.5, padding: "10px 16px", borderRadius: 12, cursor: "pointer" }}
          >
            <Upload size={14} /> {busy ? "Opening…" : score ? "Open another score" : "Open score"}
            <input type="file" accept=".xml,.musicxml,.mxl" onChange={onFile} style={{ display: "none" }} />
          </label>
          <button
            onClick={() => loadText(sampleScoreXml())} className="dvbc-tap"
            style={{ background: C.lilacSoft, color: C.plum, fontWeight: 700, fontSize: 12.5, padding: "10px 16px", borderRadius: 12, border: "none", cursor: "pointer" }}
          >
            Try a sample
          </button>
        </div>
        )}
        {error && <div style={{ color: C.roseDeep, fontSize: 11.5, marginTop: 10 }}>{error}</div>}
      </div>

      {score && (
        <>
          {/* Part selector */}
          <div style={card}>
            <div style={smallLabel}>Hear this part</div>
            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
              <button onClick={() => setFocus("all")} className="dvbc-tap" style={chip(focus === "all")}>All parts</button>
              {score.tracks.map((t) => (
                <button key={t.id} onClick={() => setFocus(t.id)} className="dvbc-tap" style={chip(focus === t.id)}>{t.name}</button>
              ))}
            </div>
            {focus !== "all" && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                <span style={{ fontSize: 11.5, color: C.inkSoft }}>Other parts:</span>
                <button onClick={() => setSoft(true)} className="dvbc-tap" style={{ ...chip(soft), padding: "6px 12px" }}>Quiet</button>
                <button onClick={() => setSoft(false)} className="dvbc-tap" style={{ ...chip(!soft), padding: "6px 12px" }}>Off</button>
              </div>
            )}
          </div>

          {/* Transport */}
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                onClick={togglePlay} className="dvbc-tap" aria-label={playing ? "Pause" : "Play"}
                style={{ width: 44, height: 44, borderRadius: "50%", border: "none", cursor: "pointer", background: gradient(), display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
              >
                {playing ? <Pause size={18} color="#fff" fill="#fff" /> : <Play size={18} color="#fff" fill="#fff" />}
              </button>
              <button
                onClick={() => seekTo(0)} className="dvbc-tap" aria-label="Back to start"
                style={{ background: "none", border: "none", cursor: "pointer", color: C.inkSoft, display: "flex", padding: 4 }}
              >
                <RotateCcw size={18} />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  type="range" min={0} max={Math.max(0.1, score.totalSec)} step={0.05} value={Math.min(pos, score.totalSec)}
                  onChange={(e) => seekTo(parseFloat(e.target.value))}
                  style={{ width: "100%", accentColor: C.plum }}
                  aria-label="Position"
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: C.inkSoft }}>
                  <span>{fmtTime(pos)}</span><span>{fmtTime(score.totalSec)}</span>
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
              <div>
                <div style={smallLabel}>Tempo · ♩ = {Math.round(score.baseTempo * rate)}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {RATES.map((r) => (
                    <button key={r} onClick={() => setRate(r)} className="dvbc-tap" style={{ ...chip(rate === r), padding: "6px 10px" }}>{Math.round(r * 100)}%</button>
                  ))}
                </div>
              </div>
              <div>
                <div style={smallLabel}>Start from bar</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="number" inputMode="numeric" value={fromBar} onChange={(e) => setFromBar(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") goToBar(); }}
                    placeholder="e.g. 9"
                    style={{ width: 70, border: `1.4px solid ${C.lilacLine}`, borderRadius: 10, padding: "6px 8px", fontSize: 12.5, color: C.ink, background: C.card }}
                  />
                  <button onClick={goToBar} className="dvbc-tap" style={{ ...chip(false), padding: "6px 12px" }}>Go</button>
                </div>
              </div>
            </div>
          </div>

          {/* Sheet music / solfa */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => setView("staff")} className="dvbc-tap" style={{ ...chip(!showSolfa), padding: "6px 12px" }}>Staff</button>
              <button onClick={() => setView("solfa")} className="dvbc-tap" style={{ ...chip(showSolfa), padding: "6px 12px" }}>Solfa</button>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => changeZoom(zoom - 0.15)} className="dvbc-tap" style={{ ...chip(false), padding: "4px 10px" }} aria-label="Smaller">A−</button>
              <button onClick={() => changeZoom(zoom + 0.15)} className="dvbc-tap" style={{ ...chip(false), padding: "4px 10px" }} aria-label="Larger">A+</button>
            </div>
          </div>
          {sheetStatus === "loading" && !showSolfa && <div style={{ fontSize: 11.5, color: C.inkSoft, marginBottom: 8 }}>Drawing the score…</div>}
          {sheetStatus === "error" && (
            <div style={{ fontSize: 11.5, color: C.roseDeep, marginBottom: 8 }}>
              Couldn't draw the staff notation, so the solfa is shown instead. You can still play the score.
            </div>
          )}

          <div
            ref={containerRef}
            style={{ background: "#fff", borderRadius: 14, border: `1.4px solid ${C.lilacLine}`, height: 380, overflow: "auto", display: showSolfa ? "none" : "block" }}
          />

          {showSolfa && solfa && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11.5, color: C.inkSoft }}>Bars per line:</span>
                {[1, 2, 3, 4].map((n) => (
                  <button key={n} onClick={() => setBarsPerLine(n)} className="dvbc-tap" style={{ ...chip(barsPerLine === n), padding: "5px 11px" }}>{n}</button>
                ))}
                <button onClick={copySolfa} className="dvbc-tap" style={{ ...chip(false), padding: "5px 12px", marginLeft: "auto" }}>{copied ? "Copied" : "Copy text"}</button>
              </div>
              <div
                style={{
                  background: "#fff", color: "#111", borderRadius: 14, border: `1.4px solid ${C.lilacLine}`, padding: "12px 14px",
                  maxHeight: 460, overflow: "auto", fontFamily: "'Courier New', ui-monospace, Menlo, monospace", fontSize: solfaFont, lineHeight: 1.55,
                }}
              >
                {solfa.systems.map((sys) => (
                  <div key={sys.startNum + "-" + sys.lines[0].bars[0].idx} style={{ marginBottom: 16 }}>
                    <div style={{ fontFamily: "system-ui, sans-serif", fontSize: Math.max(9, solfaFont - 2), color: "#777", marginBottom: 2 }}>
                      Bar {sys.startNum} · {sys.keyLabel}
                    </div>
                    {sys.lines.map((ln, li) => (
                      <div key={li} style={{ whiteSpace: "pre" }}>
                        <span style={{ fontWeight: 700 }}>{ln.label} </span>
                        {ln.bars.map((b) => (
                          <React.Fragment key={b.idx}>
                            <span>| </span>
                            <span style={{ background: b.idx === curBar ? "#FFE9A8" : "transparent" }}>{b.text}</span>
                            <span> </span>
                          </React.Fragment>
                        ))}
                        <span>{ln.last ? "||" : "|"}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          <div style={{ fontSize: 10.5, color: C.inkSoft, marginTop: 8, lineHeight: 1.5 }}>
            Playback uses a simple choir-style synth and plays repeats once.
            {showSolfa ? " Solfa is worked out from the key signature (movable doh); a small mark above or below a letter shows the octave." : ""}
          </div>
        </>
      )}
    </div>
  );
}
