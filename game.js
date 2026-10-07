(() => {
  "use strict";

  const ROUND_SIZE = 10;
  const TINY_KM2 = 6000; // 이보다 작은 나라는 탭하기 어려우니 점 마커로 표시
  const EARTH_R = 6371;

  const MODES = [
    { id: "find", emoji: "📍", title: "나라 찾기", desc: "나라 이름을 보고 지도에서 찾아 눌러요" },
    { id: "capital-find", emoji: "🏛️", title: "수도로 나라 찾기", desc: "수도 이름을 보고 그 나라를 지도에서 눌러요" },
    { id: "capital-quiz", emoji: "✏️", title: "수도 맞히기", desc: "지도에 표시된 나라의 수도를 골라요" },
  ];
  const LEVELS = [
    { id: 1, label: "😊 쉬움" },
    { id: 2, label: "🙂 보통" },
    { id: 3, label: "🔥 어려움" },
  ];

  const byKey = new Map(COUNTRIES.map((c) => [c.key, c]));
  const $ = (id) => document.getElementById(id);

  // 받침 유무에 따라 조사 고르기: josa("브라질", "이에요", "예요") → "브라질이에요"
  function josa(word, withFinal, withoutFinal) {
    const code = word.charCodeAt(word.length - 1) - 0xac00;
    const hasFinal = code >= 0 && code <= 11171 && code % 28 !== 0;
    return word + (hasFinal ? withFinal : withoutFinal);
  }
  const ieyo = (w) => josa(w, "이에요", "예요");
  const eunneun = (w) => josa(w, "은", "는");

  // ---------- 저장(기기 안에만) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("wmq:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("wmq:" + k, JSON.stringify(v)); } catch { /* 무시 */ } },
  };

  const settings = Object.assign(
    { mode: "find", region: "ALL", level: 1, voice: true },
    store.get("settings", {})
  );

  // ---------- 음성 ----------
  let koVoice = null;
  function pickVoice() {
    if (!("speechSynthesis" in window)) return;
    const voices = speechSynthesis.getVoices();
    koVoice = voices.find((v) => v.lang === "ko-KR") || voices.find((v) => v.lang && v.lang.startsWith("ko")) || null;
  }
  if ("speechSynthesis" in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }
  function speak(text) {
    if (!settings.voice || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    if (koVoice) u.voice = koVoice;
    u.rate = 0.9;
    speechSynthesis.speak(u);
  }

  // ---------- 지도 ----------
  const svg = d3.select("#map");
  const root = svg.append("g");
  const gCountries = root.append("g");
  const gDots = root.append("g");
  const projection = d3.geoNaturalEarth1().rotate([-11, 0]); // 날짜변경선을 태평양 섬들 동쪽으로
  const path = d3.geoPath(projection);
  let features = [];
  let tinyFeatures = [];
  let W = 0, H = 0;
  let currentK = 1;

  const zoom = d3.zoom()
    .scaleExtent([1, 60])
    .on("zoom", (e) => {
      currentK = e.transform.k;
      root.attr("transform", e.transform);
      gDots.selectAll("circle.dot").attr("r", 5 / currentK);
      gDots.selectAll("circle.hit").attr("r", 16 / currentK);
    });
  svg.call(zoom).on("dblclick.zoom", null); // 더블탭 확대는 끔 (빠른 연타 오작동 방지)

  // SVG는 viewBox 없이 실제 픽셀 좌표를 씀 → 하단 바 높이가 바뀌어도 지도가 찌그러지지 않음
  function measure() {
    W = Math.max(svg.node().clientWidth, 200);
    H = Math.max(svg.node().clientHeight, 200);
  }

  function layout() {
    measure();
    projection.fitExtent([[8, 8], [W - 8, H - 8]], { type: "FeatureCollection", features });
    gCountries.selectAll("path").attr("d", path);
    tinyFeatures = features.filter((f) => byKey.has(f.properties.name) && d3.geoArea(f) * EARTH_R ** 2 < TINY_KM2);
    const dots = gDots.selectAll("g.tiny").data(tinyFeatures, (f) => f.properties.name);
    dots.exit().remove();
    const enter = dots.enter().append("g").attr("class", "tiny");
    enter.append("circle").attr("class", "dot").attr("data-key", (f) => f.properties.name);
    enter.append("circle").attr("class", "hit").on("click", (e, f) => onMapClick(f.properties.name));
    gDots.selectAll("g.tiny").each(function (f) {
      const [x, y] = projection(d3.geoCentroid(f));
      d3.select(this).selectAll("circle").attr("cx", x).attr("cy", y);
    });
    zoom.translateExtent([[-W * 0.25, -H * 0.25], [W * 1.25, H * 1.25]]);
    gDots.selectAll("circle.dot").attr("r", 5 / currentK);
    gDots.selectAll("circle.hit").attr("r", 16 / currentK);
  }

  function drawMap(topo) {
    features = topojson.feature(topo, topo.objects.countries).features
      .filter((f) => f.properties.name !== "Antarctica");
    gCountries.selectAll("path")
      .data(features)
      .join("path")
      .attr("class", (f) => "country" + (byKey.has(f.properties.name) ? "" : " other"))
      .attr("data-key", (f) => f.properties.name)
      .on("click", (e, f) => onMapClick(f.properties.name));
    layout();
  }

  function zoomToBox([[x0, y0], [x1, y1]], maxK = 60, duration = 750) {
    measure();
    const dx = Math.max(x1 - x0, 1), dy = Math.max(y1 - y0, 1);
    const k = Math.max(1, Math.min(maxK, 0.92 / Math.max(dx / W, dy / H)));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const t = d3.zoomIdentity.translate(W / 2 - k * cx, H / 2 - k * cy).scale(k);
    if (duration === 0) svg.interrupt().call(zoom.transform, t);
    else svg.transition().duration(duration).call(zoom.transform, t);
  }

  function regionBox(regionId) {
    const r = REGIONS.find((x) => x.id === regionId);
    if (!r || !r.box) return [[0, 0], [W, H]];
    const [lon0, lat0, lon1, lat1] = r.box;
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        pts.push(projection([lon0 + ((lon1 - lon0) * i) / 8, lat0 + ((lat1 - lat0) * j) / 8]));
      }
    }
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
  }

  function resetView(duration = 750) {
    zoomToBox(regionBox(settings.region), 60, duration);
  }

  // 정답 나라가 화면에서 잘 보이도록 이동 (이미 충분히 크게 보이면 그대로)
  function focusCountry(key) {
    const f = features.find((x) => x.properties.name === key);
    if (!f) return;
    let [[x0, y0], [x1, y1]] = path.bounds(f);
    if (x1 - x0 > W * 0.5) { // 날짜변경선에 걸쳐 갈라진 나라
      const [cx, cy] = projection(d3.geoCentroid(f));
      x0 = cx - 40; x1 = cx + 40; y0 = cy - 40; y1 = cy + 40;
    }
    measure();
    const t = d3.zoomTransform(svg.node());
    const sx0 = t.applyX(x0), sx1 = t.applyX(x1), sy0 = t.applyY(y0), sy1 = t.applyY(y1);
    const visible = sx0 >= 0 && sy0 >= 0 && sx1 <= W && sy1 <= H;
    const bigEnough = Math.max(sx1 - sx0, sy1 - sy0) > 40;
    if (visible && bigEnough) return;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const half = Math.max(x1 - x0, y1 - y0, 12) * 2;
    zoomToBox([[cx - half, cy - half], [cx + half, cy + half]], 14);
  }

  function mark(key, cls, on = true) {
    document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach((el) => el.classList.toggle(cls, on));
  }
  function clearMarks() {
    document.querySelectorAll(".country, .dot").forEach((el) => el.classList.remove("correct", "missed", "wrong", "target", "blink"));
  }

  // ---------- 게임 상태 ----------
  const game = {
    queue: [], idx: 0, points: 0, firstTry: 0, attempts: 0, missed: [], locked: true, active: false,
  };

  function buildPool() {
    const inRegion = COUNTRIES.filter((c) => settings.region === "ALL" || c.regions.includes(settings.region));
    let level = settings.level;
    let pool = inRegion.filter((c) => c.level <= level);
    while (pool.length < ROUND_SIZE && level < 3) {
      level++;
      pool = inRegion.filter((c) => c.level <= level);
    }
    return pool;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startRound(list) {
    game.queue = list;
    game.idx = 0;
    game.points = 0;
    game.firstTry = 0;
    game.missed = [];
    game.active = true;
    clearMarks();
    $("home").hidden = true;
    $("result").hidden = true;
    $("topbar").hidden = false;
    $("bottom").hidden = false;
    layout(); ask();
  }

  function current() { return game.queue[game.idx]; }

  function ask() {
    const c = current();
    game.attempts = 0;
    game.locked = false;
    $("q-progress").textContent = `${game.idx + 1} / ${game.queue.length}`;
    $("q-score").textContent = `⭐ ${game.points}점`;
    $("btn-next").hidden = true;
    $("choices").innerHTML = "";
    document.querySelectorAll(".target, .wrong").forEach((el) => el.classList.remove("target", "wrong"));

    if (settings.mode === "find") {
      $("q-sub").textContent = "이 나라는 어디에 있을까요?";
      $("q-main").textContent = c.name;
      setFeedback("지도에서 찾아 눌러 보세요 👆");
      speak(c.name);
      resetView(game.idx > 0 ? 750 : 0);
    } else if (settings.mode === "capital-find") {
      $("q-sub").textContent = "어느 나라의 수도일까요?";
      $("q-main").textContent = c.capital;
      setFeedback("그 나라를 지도에서 눌러 보세요 👆");
      speak(`${eunneun(c.capital)} 어느 나라의 수도일까요?`);
      resetView(game.idx > 0 ? 750 : 0);
    } else {
      $("q-sub").textContent = "노란색 나라의 수도는?";
      $("q-main").textContent = c.name;
      setFeedback("아래에서 수도를 골라 보세요");
      mark(c.key, "target");
      renderChoices(c); // 보기를 먼저 그려서 지도 영역 크기가 확정된 뒤 이동
      resetView(0);
      focusCountry(c.key);
      speak(`${c.name}의 수도는 어디일까요?`);
    }
  }

  function setFeedback(html) { $("fb-text").innerHTML = html; }

  function capitalLine(c) { return `<span class="cap">· 수도 ${c.capital}</span>`; }

  function onMapClick(key) {
    if (!game.active || game.locked || settings.mode === "capital-quiz") return;
    const c = current();
    const picked = byKey.get(key);
    if (!picked) {
      const name = OTHER_PLACES[key];
      setFeedback(name ? `거기는 ${ieyo(name)}. 문제에는 안 나오는 곳이에요.` : "거기는 문제에 안 나오는 지역이에요.");
      return;
    }
    if (key === c.key) return answerCorrect();

    mark(key, "wrong");
    setTimeout(() => mark(key, "wrong", false), 1200);
    game.attempts++;
    if (game.attempts === 1) {
      setFeedback(`<span class="bad">거긴 ${ieyo(picked.name)}.</span> 한 번 더! 💪`);
      speak(`거긴 ${ieyo(picked.name)}. 한 번 더!`);
    } else {
      answerMissed(`<span class="bad">거긴 ${ieyo(picked.name)}.</span> 정답은 여기, <b>${c.name}</b> ${capitalLine(c)}`);
    }
  }

  function answerCorrect() {
    const c = current();
    game.locked = true;
    const first = game.attempts === 0;
    game.points += first ? 10 : 5;
    if (first) game.firstTry++;
    mark(c.key, "target", false);
    mark(c.key, "correct");
    $("q-score").textContent = `⭐ ${game.points}점`;
    const cheer = first ? "정답! 🎉" : "맞았어요! 👍";
    setFeedback(`<span class="good">${cheer}</span> <b>${c.name}</b> ${capitalLine(c)}`);
    speak(`${cheer.replace(/[^가-힣! ]/g, "")} ${c.name}의 수도는 ${c.capital}`);
    showNext();
  }

  function answerMissed(html) {
    const c = current();
    game.locked = true;
    game.missed.push(c);
    mark(c.key, "target", false);
    mark(c.key, "missed");
    mark(c.key, "blink");
    focusCountry(c.key);
    setFeedback(html);
    speak(`정답은 ${c.name}. 수도는 ${c.capital}`);
    showNext();
  }

  function showNext() {
    const btn = $("btn-next");
    btn.textContent = game.idx + 1 < game.queue.length ? "다음 ▶" : "결과 보기 🏁";
    btn.hidden = false;
  }

  function next() {
    if (!game.active) return;
    game.idx++;
    if (game.idx < game.queue.length) ask();
    else finish();
  }

  // 수도 맞히기 보기 4개
  function renderChoices(c) {
    const sameRegion = COUNTRIES.filter((x) => x.key !== c.key && x.regions.some((r) => c.regions.includes(r)));
    const others = COUNTRIES.filter((x) => x.key !== c.key);
    const picks = new Set();
    for (const x of shuffle(sameRegion).concat(shuffle(others))) {
      if (picks.size >= 3) break;
      if (x.capital !== c.capital) picks.add(x.capital);
    }
    const options = shuffle([c.capital, ...picks]);
    const box = $("choices");
    box.innerHTML = "";
    options.forEach((cap) => {
      const b = document.createElement("button");
      b.textContent = cap;
      b.addEventListener("click", () => onChoice(b, cap));
      box.appendChild(b);
    });
  }

  function onChoice(btn, cap) {
    if (game.locked) return;
    const c = current();
    if (cap === c.capital) {
      btn.classList.add("correct");
      $("choices").querySelectorAll("button").forEach((b) => (b.disabled = true));
      return answerCorrect();
    }
    btn.classList.add("wrong");
    btn.disabled = true;
    game.attempts++;
    const owner = COUNTRIES.find((x) => x.capital === cap);
    if (game.attempts === 1) {
      setFeedback(`<span class="bad">${eunneun(cap)} ${owner ? owner.name + "의 수도예요" : "정답이 아니에요"}.</span> 한 번 더! 💪`);
      speak("한 번 더!");
    } else {
      $("choices").querySelectorAll("button").forEach((b) => {
        b.disabled = true;
        if (b.textContent === c.capital) b.classList.add("correct");
      });
      answerMissed(`<span class="bad">아쉬워요!</span> <b>${c.name}</b>의 수도는 <b>${c.capital}</b>${ieyo(c.capital).slice(c.capital.length)}.`);
    }
  }

  function bestKey() { return `best:${settings.mode}:${settings.region}:${settings.level}`; }

  function finish() {
    game.active = false;
    const total = game.queue.length;
    const pct = Math.round((game.points / (total * 10)) * 100);
    const stars = pct >= 90 ? 3 : pct >= 60 ? 2 : pct >= 30 ? 1 : 0;
    const best = store.get(bestKey(), 0);
    const isFull = total >= Math.min(ROUND_SIZE, buildPool().length);
    let newBest = false;
    if (isFull && pct > best) { store.set(bestKey(), pct); newBest = true; }

    $("res-stars").textContent = "★".repeat(stars) + "☆".repeat(3 - stars);
    $("res-score").textContent = `${pct}점`;
    const msg = pct === 100 ? "완벽해요! 지리 박사 🎓" : pct >= 80 ? "아주 잘했어요! 👏" : pct >= 50 ? "좋아요, 조금만 더! 🙂" : "다시 해 보면 더 잘할 거예요 💪";
    $("res-msg").textContent = `${total}문제 중 ${game.firstTry}개를 한 번에 맞혔어요 · ${msg}` + (newBest ? " 🏆 최고 기록!" : "");

    const missed = $("res-missed");
    if (game.missed.length) {
      missed.innerHTML = "<h3>다시 볼 나라</h3><ul>" +
        game.missed.map((c) => `<li><b>${c.name}</b> <span>· 수도 ${c.capital}</span></li>`).join("") + "</ul>";
    } else {
      missed.innerHTML = "";
    }
    $("btn-retry-missed").hidden = game.missed.length === 0;
    $("result").hidden = false;
    speak(`${pct}점! ${msg.replace(/[^가-힣!,. ]/g, "")}`);
  }

  function goHome() {
    game.active = false;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    clearMarks();
    $("topbar").hidden = true;
    $("bottom").hidden = true;
    $("result").hidden = true;
    $("home").hidden = false;
    renderHome();
    layout(); resetView();
  }

  // ---------- 시작 화면 ----------
  function renderHome() {
    const modeList = $("mode-list");
    modeList.innerHTML = "";
    MODES.forEach((m) => {
      const b = document.createElement("button");
      b.className = "card" + (settings.mode === m.id ? " on" : "");
      b.innerHTML = `<span class="emoji">${m.emoji}</span><span><b>${m.title}</b><small>${m.desc}</small></span>`;
      b.addEventListener("click", () => { settings.mode = m.id; saveSettings(); renderHome(); });
      modeList.appendChild(b);
    });

    const regionList = $("region-list");
    regionList.innerHTML = "";
    REGIONS.forEach((r) => {
      const b = document.createElement("button");
      b.className = "chip" + (settings.region === r.id ? " on" : "");
      b.textContent = r.label;
      b.addEventListener("click", () => { settings.region = r.id; saveSettings(); renderHome(); resetView(); });
      regionList.appendChild(b);
    });

    const levelList = $("level-list");
    levelList.innerHTML = "";
    LEVELS.forEach((l) => {
      const b = document.createElement("button");
      b.className = "chip" + (settings.level === l.id ? " on" : "");
      b.textContent = l.label;
      b.addEventListener("click", () => { settings.level = l.id; saveSettings(); renderHome(); });
      levelList.appendChild(b);
    });

    $("opt-voice").checked = settings.voice;
    $("pool-info").textContent = `나라 ${buildPool().length}개 중에서 출제`;
    const best = store.get(bestKey(), 0);
    $("best-info").textContent = best ? `🏆 이 설정 최고 기록: ${best}점` : "";
  }

  function saveSettings() { store.set("settings", settings); }

  // ---------- 이벤트 ----------
  $("btn-start").addEventListener("click", () => {
    startRound(shuffle(buildPool()).slice(0, ROUND_SIZE));
  });
  $("btn-again").addEventListener("click", () => startRound(shuffle(buildPool()).slice(0, ROUND_SIZE)));
  $("btn-retry-missed").addEventListener("click", () => startRound(shuffle(game.missed)));
  $("btn-to-home").addEventListener("click", goHome);
  $("btn-home").addEventListener("click", goHome);
  $("btn-next").addEventListener("click", next);
  $("btn-speak").addEventListener("click", () => {
    const c = current();
    if (!c) return;
    if (settings.mode === "find") speak(c.name);
    else if (settings.mode === "capital-find") speak(`${eunneun(c.capital)} 어느 나라의 수도일까요?`);
    else speak(`${c.name}의 수도는 어디일까요?`);
  });
  $("opt-voice").addEventListener("change", (e) => { settings.voice = e.target.checked; saveSettings(); });
  $("zoom-in").addEventListener("click", () => svg.transition().duration(300).call(zoom.scaleBy, 1.8));
  $("zoom-out").addEventListener("click", () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.8));
  $("zoom-reset").addEventListener("click", () => resetView());

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (features.length) { layout(); resetView(0); } }, 150);
  });

  // ---------- 시작 ----------
  renderHome();
  if (window.WORLD_TOPO) {
    $("loading").remove();
    drawMap(window.WORLD_TOPO);
    resetView(0);
  } else {
    $("loading").textContent = "지도를 불러오지 못했어요. 새로고침 해 주세요.";
  }
})();
