/* 採点ロジック（3ゲーム共通） */
(function (root) {
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

  /* ① 笑顔アップ：MediaPipeのブレンドシェイプ(0〜1)から0〜100点 */
  function smileScore(bs) {
    const g = (k) => bs[k] || 0;
    const smile = (g('mouthSmileLeft') + g('mouthSmileRight')) / 2;
    const cheek = (g('cheekSquintLeft') + g('cheekSquintRight')) / 2;
    const eye = (g('eyeSquintLeft') + g('eyeSquintRight')) / 2;
    const jaw = clamp(g('jawOpen') / 0.4);
    const frown = (g('mouthFrownLeft') + g('mouthFrownRight')) / 2;
    const raw = 0.65 * smile + 0.15 * cheek + 0.1 * eye + 0.1 * jaw * smile - 0.3 * frown;
    return Math.round(100 * Math.pow(clamp(raw), 1.5)); // 厳しめ：思いっきりの笑顔でないと高得点にならない
  }

  /* ② まん丸：線を等間隔に並べ直し → 最小二乗で円を当てはめ → 半径のばらつき・一周したか・閉じているか */
  function resample(pts, n = 128) {
    const d = [0];
    for (let i = 1; i < pts.length; i++) d.push(d[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const L = d[d.length - 1], out = [];
    if (L === 0) return { pts: [], length: 0 };
    let j = 0;
    for (let k = 0; k < n; k++) {
      const t = (L * k) / (n - 1);
      while (j < d.length - 2 && d[j + 1] < t) j++;
      const seg = d[j + 1] - d[j] || 1, u = (t - d[j]) / seg;
      out.push({ x: pts[j].x + (pts[j + 1].x - pts[j].x) * u, y: pts[j].y + (pts[j + 1].y - pts[j].y) * u });
    }
    return { pts: out, length: L };
  }

  function fitCircle(p) {
    // x²+y²+Dx+Ey+F=0 を最小二乗で解く（Kasa法）
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
    const n = p.length;
    for (const { x, y } of p) {
      const z = x * x + y * y;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z;
    }
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], b = [-sxz, -syz, -sz];
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D0 = det(A);
    if (Math.abs(D0) < 1e-9) return null;
    const sol = [0, 1, 2].map((c) => det(A.map((row, r) => row.map((v, k) => (k === c ? b[r] : v)))) / D0);
    const cx = -sol[0] / 2, cy = -sol[1] / 2, r2 = cx * cx + cy * cy - sol[2];
    return r2 > 0 ? { cx, cy, r: Math.sqrt(r2) } : null;
  }

  function circleScore(raw) {
    const { pts, length } = resample(raw);
    if (length < 120 || pts.length < 10) return { ok: false, reason: 'short' };
    const c = fitCircle(pts);
    if (!c) return { ok: false, reason: 'short' };
    const rs = pts.map((q) => Math.hypot(q.x - c.cx, q.y - c.cy));
    const mean = rs.reduce((a, v) => a + v, 0) / rs.length;
    const sd = Math.sqrt(rs.reduce((a, v) => a + (v - mean) ** 2, 0) / rs.length);
    const cv = sd / mean;
    let swept = 0;
    for (let i = 1; i < pts.length; i++) {
      let a = Math.atan2(pts[i].y - c.cy, pts[i].x - c.cx) - Math.atan2(pts[i - 1].y - c.cy, pts[i - 1].x - c.cx);
      if (a > Math.PI) a -= 2 * Math.PI;
      if (a < -Math.PI) a += 2 * Math.PI;
      swept += a;
    }
    const coverage = clamp(Math.abs(swept) / (2 * Math.PI));
    const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) / mean;
    const closure = coverage >= 0.999 ? 1 : 1 - 0.5 * clamp(gap);
    const roundness = clamp(1 - cv * 6); // 厳しめ：少しのゆがみでも減点
    const score = Math.round(100 * roundness * coverage * coverage * closure);
    return { ok: true, score, circle: c, cv, coverage, gap };
  }

  /* ③ タイムアタック：15秒・0.01秒単位（切り捨て）で採点 */
  function timeScore(ms) {
    const c = Math.floor(ms / 10); // センチ秒
    if (c === 1500) return 130; // 15.00秒ピッタリ：100点＋ボーナス30点
    if (c >= 1411 && c <= 1499) return 100 - (1500 - c);
    if (c >= 1300 && c <= 1410) return 10;
    if (c >= 1501 && c <= 1700) return 10;
    return 0;
  }

  /* ④ 宝箱：8箱の中身をシャッフル（'again' は「もう一回」） */
  const TREASURE = [50, 30, 20, 10, 0, 0, -30, 'again'];
  const counted = (t) => t.picks.filter((i) => t.boxes[i] !== 'again');
  const treasureScore = (t) => counted(t).reduce((a, i) => a + t.boxes[i], 0);
  function shuffleTreasure(rand = Math.random) {
    const a = TREASURE.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /* ⑤ 玉転がし：ゴールタイム順に 100/80/60/40/20、6位以下とタイムオーバーは10点。同タイムは同順位 */
  function ballPoints(players) {
    const PTS = [100, 80, 60, 40, 20];
    const fin = players.filter((p) => p.ball && p.ball.cs != null).sort((a, b) => a.ball.cs - b.ball.cs);
    const out = {};
    let rank = 0;
    fin.forEach((p, i) => {
      if (i === 0 || p.ball.cs !== fin[i - 1].ball.cs) rank = i + 1;
      out[p.id] = { rank, score: rank <= 5 ? PTS[rank - 1] : 10 };
    });
    players.forEach((p) => { if (!out[p.id]) out[p.id] = { rank: null, score: p.ball && !p.ball.pending ? 10 : 0 }; });
    return out;
  }

  const api = { smileScore, circleScore, timeScore, shuffleTreasure, ballPoints, TREASURE, counted, treasureScore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scoring = api;
})(this);
