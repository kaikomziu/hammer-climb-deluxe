// 地形生成: 山の輪郭を1本の折れ線として表現する。
// 進行方向を基準に「右側=岩(実体)」「左側=空気(プレイヤー側)」という規約で一貫して作図する。
// これにより凹み(オーバーハング)やV字谷も、単純な折れ線の蛇行として表現できる。

const Terrain = (() => {
  const CELL = 240;

  function buildPath() {
    let x = 0, y = 0;
    let friction = 0.90;
    const pts = [{ x, y, friction }];
    const seg = (dx, dyUp) => {
      x += dx;
      y -= dyUp;
      pts.push({ x, y, friction });
    };
    const rnd = mulberry32(20260916);

    // --- セクションA: チュートリアル斜面 ---
    for (let i = 0; i < 6; i++) seg(70 + rnd() * 30, 60 + rnd() * 20);

    // --- セクションB: 最初の小さいオーバーハング ---
    seg(40, 10);
    seg(-60, 20);
    seg(-20, 90);
    seg(90, 40);

    // --- セクションC: 休憩の足場 ---
    seg(130, 4);
    seg(60, -2);

    // --- セクションD: 急な壁 + フック引っかけ ---
    for (let i = 0; i < 3; i++) {
      seg(20, 130 + rnd() * 30);
      seg(-70, 30);
      seg(-30, 100);
      seg(100, 20);
    }

    // --- セクションE: V字ファネル(滑り落ちる罠) ---
    seg(90, 40);
    seg(60, 220);
    seg(-160, 40);
    seg(-10, -230);
    seg(180, 30);
    seg(70, 260);

    // --- セクションF: 休憩の足場 ---
    seg(150, 6);
    seg(80, -4);

    // --- セクションG: 天井下のトラバース(横振り) ---
    seg(30, 40);
    seg(220, 5);
    seg(-40, 60);
    seg(200, -10);
    seg(60, 180);

    // --- セクションH: 滑りやすい長い斜面 ---
    friction = 0.988;
    for (let i = 0; i < 5; i++) seg(110 + rnd() * 20, 150 + rnd() * 15);
    friction = 0.90;

    // --- セクションI: 狭いチムニー(左右ジグザグ) ---
    for (let i = 0; i < 4; i++) {
      seg(-90, 110);
      seg(90, 110);
    }

    // --- セクションJ: 山頂直前の最後のオーバーハング ---
    seg(60, 40);
    seg(-100, 30);
    seg(-40, 160);
    seg(160, 60);

    // --- セクションK: 山頂の足場 ---
    seg(120, 30);
    seg(160, 10);

    return pts;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function subdivideAndRoughen(rawPts) {
    const rnd = mulberry32(777);
    const out = [{ x: rawPts[0].x, y: rawPts[0].y, friction: rawPts[0].friction }];
    for (let i = 0; i < rawPts.length - 1; i++) {
      const a = rawPts[i], b = rawPts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.round(len / 45));
      const nx = -dy / (len || 1), ny = dx / (len || 1);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + dx * t, py = a.y + dy * t;
        const wobble = s === steps ? 0 : (rnd() - 0.5) * Math.min(10, len / steps * 0.35);
        out.push({ x: px + nx * wobble, y: py + ny * wobble, friction: b.friction });
      }
    }
    return out;
  }

  function buildSegments(pts) {
    const segments = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      // 「進行方向の右手側=実体」の規約から、外側(空気側)法線は (dy,-dx)
      const nx = dy / len, ny = -dx / len;
      segments.push({ a, b, nx, ny, idx: i, friction: a.friction });
    }
    return segments;
  }

  function buildGrid(segments) {
    const grid = new Map();
    const key = (cx, cy) => cx + ',' + cy;
    for (const s of segments) {
      const minX = Math.min(s.a.x, s.b.x), maxX = Math.max(s.a.x, s.b.x);
      const minY = Math.min(s.a.y, s.b.y), maxY = Math.max(s.a.y, s.b.y);
      const c0x = Math.floor(minX / CELL), c1x = Math.floor(maxX / CELL);
      const c0y = Math.floor(minY / CELL), c1y = Math.floor(maxY / CELL);
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let cy = c0y; cy <= c1y; cy++) {
          const k = key(cx, cy);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(s);
        }
      }
    }
    return grid;
  }

  function closestPointOnSegment(px, py, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const abLen2 = abx * abx + aby * aby || 1;
    let t = ((px - a.x) * abx + (py - a.y) * aby) / abLen2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t, cy = a.y + aby * t;
    return { x: cx, y: cy, t };
  }

  function create() {
    const raw = buildPath();
    const pts = subdivideAndRoughen(raw);
    const segments = buildSegments(pts);
    const grid = buildGrid(segments);
    const start = pts[0];
    const summit = pts[pts.length - 1];
    const totalRise = start.y - summit.y;
    const fillPolygon = pts.concat([
      { x: summit.x + 2000, y: summit.y - 200 },
      { x: summit.x + 2000, y: start.y + 3000 },
      { x: start.x - 800, y: start.y + 3000 },
    ]);

    function nearbySegments(x, y, radius) {
      const result = [];
      const c0x = Math.floor((x - radius) / CELL), c1x = Math.floor((x + radius) / CELL);
      const c0y = Math.floor((y - radius) / CELL), c1y = Math.floor((y + radius) / CELL);
      const seen = new Set();
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let cy = c0y; cy <= c1y; cy++) {
          const arr = grid.get(cx + ',' + cy);
          if (!arr) continue;
          for (const s of arr) {
            if (seen.has(s.idx)) continue;
            seen.add(s.idx);
            result.push(s);
          }
        }
      }
      return result;
    }

    // 円(x,y,radius)が地形にめり込んでいれば、押し出しベクトルと接地情報を返す
    function resolveCircle(x, y, radius) {
      const candidates = nearbySegments(x, y, radius + 40);
      let best = null;
      for (const s of candidates) {
        const cp = closestPointOnSegment(x, y, s.a, s.b);
        const dx = x - cp.x, dy = y - cp.y;
        const dist = Math.hypot(dx, dy);
        if (dist < radius) {
          const pen = radius - dist;
          if (!best || pen > best.pen) {
            best = { pen, nx: s.nx, ny: s.ny, cpx: cp.x, cpy: cp.y, friction: s.friction, seg: s };
          }
        }
      }
      return best;
    }

    return {
      pts, segments, grid, start, summit, totalRise, fillPolygon,
      nearbySegments, resolveCircle, closestPointOnSegment,
    };
  }

  return { create };
})();
