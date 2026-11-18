(() => {
  "use strict";

  const C = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);
  const LS_TOP = "mc_top10_v1";
  const LS_ME = "mc_me_v1";
  const LS_MINE = "mc_mine_v1";
  const LS_EMP = "mc_employees_v1";
  // รายชื่อพนักงานมาจากแท็บ Employees ใน Google Sheet (จำไว้ในเครื่อง แล้วอัปเดตเบื้องหลัง)
  let DEPTS = {};

  const els = {
    title: $("title"), subtitle: $("subtitle"),
    form: $("entry-form"),
    department: $("department"), name: $("name"), location: $("location"), area: $("area"),
    locationOther: $("location-other"), locationOtherField: $("location-other-field"),
    brand: $("brand"), product: $("product"),
    photos: $("photos"), previews: $("previews"), photoHint: $("photo-hint"),
    submit: $("submit-btn"), status: $("form-status"),
    boardList: $("board-list"), boardUpdated: $("board-updated"), boardRefresh: $("board-refresh"),
    toast: $("toast"),
  };

  // images: [{ id, promise, result: {base64, previewUrl, kb} | null, error }]
  let images = [];
  let submitting = false;
  let pendingId = null; // ใช้ ID เดิมเมื่อกดส่งซ้ำหลังเน็ตหลุด กันรายการซ้ำ

  /* ---------------- Storage helpers (never throw) ---------------- */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  /* ---------------- Dropdowns ---------------- */
  function fillSelect(select, items, placeholder) {
    const frag = document.createDocumentFragment();
    const ph = new Option(placeholder, "");
    ph.disabled = true; ph.selected = true;
    frag.appendChild(ph);
    items.forEach((v) => frag.appendChild(new Option(v, v)));
    select.replaceChildren(frag);
    select.disabled = items.length === 0;
  }

  function fillGroupedSelect(select, groups, placeholder) {
    const frag = document.createDocumentFragment();
    const ph = new Option(placeholder, "");
    ph.disabled = true; ph.selected = true;
    frag.appendChild(ph);
    Object.keys(groups).forEach((label) => {
      const og = document.createElement("optgroup");
      og.label = label;
      groups[label].forEach((v) => og.appendChild(new Option(v, v)));
      frag.appendChild(og);
    });
    select.replaceChildren(frag);
  }

  function isOther() { return els.location.value === C.OTHER_OPTION; }

  function toggleLocationOther() {
    const show = isOther();
    els.locationOtherField.hidden = !show;
    if (show) els.locationOther.focus();
    else { els.locationOther.value = ""; els.locationOther.classList.remove("invalid"); }
  }

  function initDropdowns() {
    fillSelect(els.department, [], "กำลังโหลดรายชื่อ…");
    fillSelect(els.name, [], "เลือก department ก่อน");
    fillSelect(els.location, C.LOCATIONS, "เลือกสถานที่");
    fillGroupedSelect(els.area, C.AREAS, "เลือกเขต / จังหวัด");
    els.location.addEventListener("change", toggleLocationOther);
    els.locationOther.addEventListener("input", () => { els.locationOther.classList.remove("invalid"); pendingId = null; });
    fillSelect(els.brand, Object.keys(C.BRANDS), "เลือกแบรนด์");
    fillSelect(els.product, [], "เลือกแบรนด์ก่อน");

    els.department.addEventListener("change", () => {
      fillSelect(els.name, DEPTS[els.department.value] || [], "เลือกชื่อ");
    });
    // ชื่อสินค้ายาว ช่องเลือกจะตัดท้าย จึงแสดงชื่อเต็มใต้ช่องให้ตรวจก่อนส่ง
    // แสดงชื่อเต็มใต้ช่องเฉพาะเมื่อชื่อยาวเกินช่องจนถูกตัด
    const measure = document.createElement("canvas").getContext("2d");
    const showProduct = () => {
      const v = els.product.value || "";
      let cut = false;
      if (v) {
        const cs = getComputedStyle(els.product);
        measure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = els.product.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        cut = measure.measureText(v).width > room;
      }
      $("product-full").textContent = cut ? v : "";
    };
    window.addEventListener("resize", showProduct);
    els.brand.addEventListener("change", () => {
      fillSelect(els.product, C.BRANDS[els.brand.value] || [], "เลือกสินค้า");
      showProduct();
    });
    els.product.addEventListener("change", showProduct);
    els.name.addEventListener("change", () => {
      store.set(LS_ME, { department: els.department.value, name: els.name.value });
      renderBoard(store.get(LS_TOP));
    });
    [els.department, els.name, els.location, els.area, els.brand, els.product].forEach((s) =>
      s.addEventListener("change", () => { s.classList.remove("invalid"); pendingId = null; })
    );

  }

  // ใส่รายชื่อลง dropdown โดยคงค่าที่เลือกอยู่ (หรือชื่อที่เคยส่งไว้) ถ้ายังมีในรายชื่อ
  function applyEmployees(depts) {
    DEPTS = depts || {};
    const me = store.get(LS_ME) || {};
    const keepDept = els.department.value || me.department;
    const keepName = els.name.value || me.name;
    const names = Object.keys(DEPTS);
    fillSelect(els.department, names, names.length ? "เลือก department" : "ยังไม่มีรายชื่อ");
    if (keepDept && DEPTS[keepDept]) {
      els.department.value = keepDept;
      fillSelect(els.name, DEPTS[keepDept], "เลือกชื่อ");
      if (DEPTS[keepDept].includes(keepName)) els.name.value = keepName;
    } else {
      fillSelect(els.name, [], "เลือก department ก่อน");
    }
  }

  async function loadEmployees() {
    const cached = store.get(LS_EMP);
    if (cached && cached.departments) applyEmployees(cached.departments);
    try {
      const res = await fetch(`${C.API_URL}?action=employees&t=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) return;
      if (!cached || cached.version !== data.version) {
        store.set(LS_EMP, { departments: data.departments, version: data.version });
        applyEmployees(data.departments);
        if (isMineView()) renderMine(store.get(LS_MINE));
      }
    } catch {
      if (!cached) fillSelect(els.department, [], "โหลดรายชื่อไม่สำเร็จ ลองเปิดใหม่");
    }
  }

  /* ---------------- Image compression ---------------- */
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("เปิดไฟล์รูปนี้ไม่ได้ ลองถ่ายใหม่หรือเลือกรูป JPG/PNG")); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("บีบอัดรูปไม่สำเร็จ"))), "image/jpeg", quality)
    );
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1]);
      r.onerror = () => reject(new Error("อ่านรูปไม่สำเร็จ"));
      r.readAsDataURL(blob);
    });
  }

  async function compressImage(file) {
    const { img, url } = await loadImage(file);
    try {
      const max = C.IMAGE_MAX_DIMENSION;
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // PNG โปร่งใส -> พื้นขาว
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h); // เบราว์เซอร์ปัจจุบันหมุนรูปตาม EXIF ให้อัตโนมัติ

      let q = C.IMAGE_QUALITY;
      let blob = await canvasToBlob(canvas, q);
      const target = C.IMAGE_TARGET_KB * 1024;
      while (blob.size > target && q > 0.45) {
        q = Math.round((q - 0.08) * 100) / 100;
        blob = await canvasToBlob(canvas, q);
      }
      const base64 = await blobToBase64(blob);
      return { base64, previewUrl: URL.createObjectURL(blob), kb: Math.round(blob.size / 1024) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function updatePhotoHint() {
    els.photoHint.textContent = `(${images.length}/${C.MAX_IMAGES} รูป)`;
  }

  function renderPreviews() {
    const frag = document.createDocumentFragment();
    images.forEach((item) => {
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.alt = "รูปที่แนบ";
      const meta = document.createElement("span");
      meta.className = "meta";
      if (item.result) {
        img.src = item.result.previewUrl;
        meta.textContent = `${item.result.kb} KB`;
      } else if (item.error) {
        meta.textContent = "ใช้รูปนี้ไม่ได้";
      } else {
        li.classList.add("busy");
        meta.textContent = "กำลังย่อรูป…";
      }
      const rm = document.createElement("button");
      rm.type = "button"; rm.className = "remove"; rm.textContent = "×";
      rm.setAttribute("aria-label", "ลบรูปนี้");
      rm.addEventListener("click", () => removeImage(item.id));
      li.append(img, meta, rm);
      frag.appendChild(li);
    });
    els.previews.replaceChildren(frag);
    updatePhotoHint();
  }

  function removeImage(id) {
    const item = images.find((i) => i.id === id);
    if (item && item.result) URL.revokeObjectURL(item.result.previewUrl);
    images = images.filter((i) => i.id !== id);
    renderPreviews();
  }

  function clearImages() {
    images.forEach((i) => i.result && URL.revokeObjectURL(i.result.previewUrl));
    images = [];
    renderPreviews();
  }

  // เริ่มย่อรูปทันทีที่เลือก -> ตอนกดส่งรูปพร้อมแล้ว ไม่ต้องรอ
  els.photos.addEventListener("change", () => {
    pendingId = null;
    const files = Array.from(els.photos.files || []);
    els.photos.value = "";
    const room = C.MAX_IMAGES - images.length;
    if (files.length > room) showToast(`แนบได้สูงสุด ${C.MAX_IMAGES} รูป`);
    files.slice(0, Math.max(0, room)).forEach((file) => {
      const item = { id: Math.random().toString(36).slice(2), result: null, error: null };
      item.promise = compressImage(file)
        .then((r) => { item.result = r; })
        .catch((e) => { item.error = e.message; showToast(e.message); })
        .finally(renderPreviews);
      images.push(item);
    });
    renderPreviews();
  });

  /* ---------------- Leaderboard ---------------- */
  function formatTime(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
    } catch { return ""; }
  }

  function renderBoard(data) {
    if (!data || !Array.isArray(data.top)) return;
    const me = store.get(LS_ME) || {};
    if (data.top.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "ยังไม่มีใครส่ง ส่งรายการแรกแล้วขึ้นอันดับ 1 ได้เลย";
      els.boardList.replaceChildren(li);
    } else {
      const frag = document.createDocumentFragment();
      data.top.slice(0, C.LEADERBOARD_SIZE).forEach((p, i) => {
        const li = document.createElement("li");
        li.className = "row" + (i < 3 ? " podium" : "") +
          (p.name === me.name && p.department === me.department ? " me" : "");
        const rank = document.createElement("span");
        rank.className = "rank"; rank.textContent = String(i + 1);
        const who = document.createElement("span");
        who.className = "who";
        const b = document.createElement("b"); b.textContent = p.name;
        const s = document.createElement("small"); s.textContent = p.department;
        who.append(b, s);
        const score = document.createElement("span");
        score.className = "score";
        const n = document.createElement("b"); n.textContent = String(p.count);
        const u = document.createElement("small"); u.textContent = "รายการ";
        score.append(n, u);
        li.append(rank, who, score);
        frag.appendChild(li);
      });
      els.boardList.replaceChildren(frag);
    }
    const t = formatTime(data.updatedAt);
    els.boardUpdated.textContent = t ? `อัปเดตล่าสุด ${t} น.` : "";
  }

  let boardLoading = false;
  async function loadBoard() {
    if (boardLoading) return;
    boardLoading = true;
    try {
      const res = await fetch(`${C.API_URL}?action=top10&t=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      if (data.ok) {
        const payload = { top: data.top10, departments: data.departments, updatedAt: data.updatedAt };
        store.set(LS_TOP, payload);
        renderBoard(payload);
      }
    } catch {
      if (!store.get(LS_TOP)) els.boardUpdated.textContent = "โหลด Top 10 ไม่สำเร็จ กดรีเฟรชเพื่อลองใหม่";
    } finally {
      boardLoading = false;
    }
  }

  /* ---------------- Submit ---------------- */
  function setStatus(msg, kind) {
    els.status.textContent = msg || "";
    els.status.className = "status" + (kind ? " " + kind : "");
  }

  let toastTimer;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3500);
  }

  function validate() {
    const fields = [
      [els.department, "department"], [els.name, "ชื่อ"], [els.location, "สถานที่ที่เจอ"], [els.area, "เขต / จังหวัด"],
      [els.brand, "แบรนด์"], [els.product, "ชื่อสินค้า"],
    ];
    const missing = fields.filter(([s]) => !s.value);
    missing.forEach(([s]) => s.classList.add("invalid"));
    const otherMissing = isOther() && !els.locationOther.value.trim();
    if (otherMissing) els.locationOther.classList.add("invalid");
    if (missing.length || otherMissing) {
      (missing.length ? missing[0][0] : els.locationOther).focus();
      const parts = [];
      if (missing.length) parts.push(`เลือก ${missing.map(([, label]) => label).join(", ")}`);
      if (otherMissing) parts.push("พิมพ์ชื่อสถานที่");
      return `กรุณา${parts.join(" และ")}`;
    }
    if (images.length === 0) return "กรุณาแนบรูปอย่างน้อย 1 รูป";
    return "";
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  /* ---------------- ส่งแบบเบื้องหลัง: กดส่งแล้วกรอกรายการถัดไปได้ทันที ----------------
     รายการเข้าคิว แล้วทยอยส่งทีละรายการ ถ้าเน็ตหลุดจะลองใหม่เอง
     ID เดิมทุกครั้งที่ลองใหม่ เซิร์ฟเวอร์จึงไม่บันทึกซ้ำ */
  const LS_QUEUE = "mc_queue_v1";
  let queue = store.get(LS_QUEUE) || [];
  let sending = false;
  let retryTimer = null;
  const queueEl = $("queue-status");

  function saveQueue() {
    try { localStorage.setItem(LS_QUEUE, JSON.stringify(queue)); }
    catch { /* พื้นที่ในเครื่องเต็ม: คิวยังอยู่ในหน่วยความจำ ส่งต่อได้ตราบที่ไม่ปิดแอป */ }
  }

  function renderQueue(note) {
    if (!queue.length) { queueEl.hidden = true; return; }
    queueEl.hidden = false;
    queueEl.textContent = note || `กำลังส่ง ${queue.length} รายการ… กรอกรายการถัดไปได้เลย`;
  }

  function onSent(item, data) {
    if (Array.isArray(data.top10)) {
      const board = { top: data.top10, departments: data.departments, updatedAt: data.updatedAt };
      store.set(LS_TOP, board);
      renderBoard(board);
    }
    showToast(`ส่งแล้ว: ${item.payload.product} (คุณมี ${data.myCount} รายการ)`);
    loadMine();
  }

  async function processQueue() {
    if (sending || !queue.length) return;
    sending = true;
    clearTimeout(retryTimer);
    renderQueue();
    while (queue.length) {
      const item = queue[0];
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        // ไม่ใส่ Content-Type -> เป็น "simple request" ไม่มี CORS preflight จึงเร็วกว่า
        const res = await fetch(C.API_URL, { method: "POST", body: JSON.stringify(item.payload), signal: ctrl.signal });
        clearTimeout(timer);
        const data = await res.json();
        queue.shift(); saveQueue();
        if (data.ok) onSent(item, data);
        else {
          // เซิร์ฟเวอร์ปฏิเสธ (เช่น รูปซ้ำ) ส่งซ้ำก็ไม่ผ่าน จึงเอาออกจากคิวแล้วแจ้งชัดๆ
          setStatus(`ไม่ได้บันทึก "${item.payload.product}": ${data.message || "ส่งไม่สำเร็จ"}`, "error");
          showToast(`ไม่ได้บันทึก: ${item.payload.product}`);
        }
        item.tries = 0;
      } catch {
        // เน็ตหลุดหรือช้า: เก็บไว้ในคิว ลองใหม่อีกครั้ง (รอนานขึ้นเรื่อยๆ สูงสุด 30 วินาที)
        item.tries = (item.tries || 0) + 1;
        saveQueue();
        const wait = Math.min(30, 3 * item.tries);
        renderQueue(`ยังส่งไม่ได้ ${queue.length} รายการ (สัญญาณอ่อน) จะลองใหม่ใน ${wait} วินาที อย่าปิดแอป`);
        sending = false;
        retryTimer = setTimeout(processQueue, wait * 1000);
        return;
      }
    }
    sending = false;
    renderQueue();
  }

  window.addEventListener("online", processQueue);
  window.addEventListener("beforeunload", (e) => {
    if (queue.length) { e.preventDefault(); e.returnValue = ""; }
  });

  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitting) return;

    const err = validate();
    if (err) { setStatus(err, "error"); return; }

    submitting = true;
    els.submit.disabled = true;
    setStatus("");
    try {
      // รูปถูกย่อไว้ตั้งแต่ตอนเลือก ปกติขั้นนี้เสร็จทันที
      await Promise.all(images.map((i) => i.promise));
      const ready = images.filter((i) => i.result);
      if (ready.length === 0) throw new Error("ไม่มีรูปที่ใช้ได้ กรุณาแนบรูปใหม่");

      const payload = {
        action: "submit",
        submissionId: (pendingId = pendingId || uuid()),
        department: els.department.value,
        name: els.name.value,
        location: els.location.value,
        locationOther: isOther() ? els.locationOther.value.trim() : "",
        area: els.area.value,
        brand: els.brand.value,
        product: els.product.value,
        images: ready.map((i) => i.result.base64),
      };
      queue.push({ payload, tries: 0 });
      saveQueue();
      pendingId = null;
      store.set(LS_ME, { department: payload.department, name: payload.name });

      // เก็บ department/ชื่อ/สถานที่/เขตไว้ (มักถ่ายหลายสินค้าในร้านเดียวกัน)
      els.brand.selectedIndex = 0;
      fillSelect(els.product, [], "เลือกแบรนด์ก่อน");
      $("product-full").textContent = "";
      clearImages();
      showToast("รับรายการแล้ว กำลังส่ง…");
      processQueue();
    } catch (ex) {
      setStatus(ex.message, "error");
    } finally {
      submitting = false;
      els.submit.disabled = false;
    }
  });

  /* ---------------- PWA (ติดตั้งผ่านเมนูของเบราว์เซอร์) ---------------- */
  function initInstall() {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  /* ---------------- ภาพหัวเว็บ ---------------- */
  function initHero() {
    // CSS เลือกใช้ภาพตามขนาดจอ เบราว์เซอร์จึงดาวน์โหลดแค่ไฟล์เดียว
    const root = document.body.style;
    if (C.BACKGROUND_MOBILE) root.setProperty("--bg-mobile", `url("${C.BACKGROUND_MOBILE}")`);
    if (C.BACKGROUND_DESKTOP) root.setProperty("--bg-desktop", `url("${C.BACKGROUND_DESKTOP}")`);
  }

  /* ---------------- แท็บ "ของฉัน": คะแนน แผนก ประวัติ ---------------- */
  const mineEls = {
    view: $("view-mine"), send: $("view-send"),
    empty: $("mine-empty"), content: $("mine-content"),
    name: $("mine-name"), dept: $("mine-dept"),
    count: $("mine-count"), rank: $("mine-rank"), rankLabel: $("mine-rank-label"), deptRank: $("mine-dept-rank"),
    updated: $("mine-updated"), deptMembersH: $("dept-members-h"), deptMembers: $("dept-members"),
    deptRankList: $("dept-rank"), history: $("history-list"), historyCount: $("history-count"),
  };
  const meKey = (me) => `${me.department}|${me.name}`;
  const isMineView = () => location.hash === "#mine";

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function formatDateTime(iso) {
    try {
      return new Date(iso).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " น.";
    } catch { return ""; }
  }

  // ลิงก์ Google Drive -> รูปย่อ (แสดงได้เมื่อแชร์โฟลเดอร์รูปแบบ "ทุกคนที่มีลิงก์")
  function thumbUrl(u) {
    if (!u) return null;
    if (u.startsWith("data:")) return u;
    const m = u.match(/\/d\/([\w-]+)/) || u.match(/[?&]id=([\w-]+)/);
    return m ? `https://drive.google.com/thumbnail?id=${m[1]}&sz=w200` : null;
  }

  function renderDepartments(list) {
    const me = store.get(LS_ME) || {};
    const byName = {};
    (list || []).forEach((d) => { byName[d.department] = d; });
    const all = Object.keys(DEPTS).map((name) => ({
      department: name,
      count: byName[name] ? byName[name].count : 0,
      people: byName[name] ? byName[name].people : 0,
      members: DEPTS[name].length,
    }));
    Object.keys(byName).forEach((name) => {
      if (!DEPTS[name]) all.push({ ...byName[name], members: byName[name].people });
    });
    all.sort((a, b) => b.count - a.count || a.department.localeCompare(b.department, "th"));
    const max = Math.max(1, ...all.map((d) => d.count));
    const frag = document.createDocumentFragment();
    all.forEach((d, i) => {
      const li = el("li", "dept-item" + (d.department === me.department ? " mine-dept" : ""));
      li.append(el("span", "rank", d.count > 0 ? String(i + 1) : "–"), el("span", "dept-name", d.department));
      const total = el("span", "dept-total", String(d.count));
      total.append(" ", el("small", null, "รายการ"));
      li.append(total);
      const bar = el("span", "bar");
      const fill = el("span");
      fill.style.width = `${(d.count / max) * 100}%`;
      bar.append(fill);
      li.append(bar, el("span", "people", `ส่งแล้ว ${d.people} จาก ${d.members} คน`));
      frag.append(li);
    });
    mineEls.deptRankList.replaceChildren(frag);
  }

  function renderDeptMembers(me, members) {
    mineEls.deptMembersH.textContent = `อันดับในแผนก ${me.department}`;
    const counts = {};
    (members || []).forEach((m) => { counts[m.name] = m.count; });
    const ranked = (members || []).map((m) => m.name);
    const zeros = (DEPTS[me.department] || []).filter((n) => !(n in counts));
    const frag = document.createDocumentFragment();
    ranked.concat(zeros).forEach((name, i) => {
      const c = counts[name] || 0;
      const li = el("li", "row" + (c === 0 ? " zero" : "") + (name === me.name ? " me" : ""));
      const who = el("span", "who");
      who.append(el("b", null, name), el("small", null, c === 0 ? "ยังไม่ได้ส่ง" : ""));
      const score = el("span", "score");
      score.append(el("b", null, String(c)), el("small", null, "รายการ"));
      li.append(el("span", "rank", c > 0 ? String(i + 1) : "–"), who, score);
      frag.append(li);
    });
    mineEls.deptMembers.replaceChildren(frag);
  }

  function renderHistory(list) {
    const frag = document.createDocumentFragment();
    if (!list.length) {
      frag.append(el("li", "empty", "ยังไม่มีรายการ ส่งรายการแรกได้ที่แท็บส่งรายการ"));
    }
    list.forEach((h) => {
      const li = el("li", h.rejected ? "rejected" : "");
      const imgs = h.images || [];
      const first = imgs[0];
      const thumb = el(first && !first.startsWith("data:") ? "a" : "span", "thumb");
      if (thumb.tagName === "A") { thumb.href = first; thumb.target = "_blank"; thumb.rel = "noopener"; thumb.setAttribute("aria-label", "เปิดรูป"); }
      const src = thumbUrl(first);
      if (src) {
        const img = new Image();
        img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.src = src;
        img.onerror = () => { img.remove(); thumb.prepend("ดูรูป"); };
        thumb.append(img);
      } else {
        thumb.append("ไม่มีรูป");
      }
      if (imgs.length > 1) thumb.append(el("span", "more", `+${imgs.length - 1}`));
      const body = el("div");
      body.append(el("div", "h-product", `${h.product} (${h.brand})`));
      const place = h.locationOther ? `${h.location}: ${h.locationOther}` : h.location;
      body.append(el("div", "h-where", `${place}, ${h.area}`));
      body.append(el("div", "h-time", formatDateTime(h.ts)));
      if (h.rejected) body.append(el("span", "badge", "ไม่นับคะแนน"));
      li.append(thumb, body);
      frag.append(li);
    });
    mineEls.history.replaceChildren(frag);
    mineEls.historyCount.textContent = list.length ? `${list.length} รายการล่าสุด` : "";
  }

  function renderMine(cached) {
    const me = store.get(LS_ME);
    const has = !!(me && me.name && me.department);
    mineEls.empty.hidden = has;
    mineEls.content.hidden = !has;
    if (!has) return;
    mineEls.name.textContent = me.name;
    mineEls.dept.textContent = me.department;
    const d = cached && cached.key === meKey(me) ? cached.data : null;
    const board = store.get(LS_TOP);
    renderDepartments((d && d.departments) || (board && board.departments) || []);
    if (!d) {
      [mineEls.count, mineEls.rank, mineEls.deptRank].forEach((x) => { x.textContent = "–"; });
      renderDeptMembers(me, []);
      mineEls.history.replaceChildren(el("li", "empty", "กำลังโหลดประวัติ…"));
      mineEls.historyCount.textContent = "";
      return;
    }
    mineEls.count.textContent = String(d.me.count);
    mineEls.rank.textContent = d.me.rank ? `#${d.me.rank}` : "–";
    mineEls.rankLabel.textContent = d.me.totalPeople ? `อันดับรวม จาก ${d.me.totalPeople} คน` : "อันดับรวม";
    mineEls.deptRank.textContent = d.me.deptRank ? `#${d.me.deptRank}` : "–";
    renderDeptMembers(me, d.deptMembers);
    renderHistory(d.history || []);
    const t = formatTime(d.updatedAt);
    mineEls.updated.textContent = t ? `อัปเดตล่าสุด ${t} น.` : "";
  }

  let mineLoading = false;
  async function loadMine() {
    const me = store.get(LS_ME);
    if (!me || !me.name || !me.department || mineLoading) return;
    mineLoading = true;
    try {
      const url = `${C.API_URL}?action=me&name=${encodeURIComponent(me.name)}` +
        `&department=${encodeURIComponent(me.department)}&t=${Date.now()}`;
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.message);
      const cached = { key: meKey(me), data };
      store.set(LS_MINE, cached);
      if (isMineView()) renderMine(cached);
    } catch {
      if (isMineView()) mineEls.updated.textContent = "โหลดข้อมูลไม่สำเร็จ ลองเปิดแท็บนี้ใหม่อีกครั้ง";
    } finally {
      mineLoading = false;
    }
  }

  function showView() {
    const mine = isMineView();
    mineEls.view.hidden = !mine;
    mineEls.send.hidden = mine;
    document.querySelectorAll(".tab").forEach((t) => {
      if ((t.dataset.view === "mine") === mine) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    window.scrollTo(0, 0);
    if (mine) { renderMine(store.get(LS_MINE)); loadMine(); }
  }

  /* ---------------- Init ---------------- */
  els.title.textContent = C.COMPETITION_NAME;
  document.title = C.COMPETITION_NAME;
  els.subtitle.textContent = C.COMPETITION_SUBTITLE;
  initDropdowns();
  loadEmployees();
  if (queue.length) processQueue(); // มีรายการค้างจากครั้งก่อน ส่งต่อให้เลย
  initInstall();
  initHero();
  updatePhotoHint();

  // แสดง Top 10 จากแคชในเครื่องทันที (0 ms) แล้วค่อยดึงของใหม่
  renderBoard(store.get(LS_TOP));
  loadBoard();
  els.boardRefresh.addEventListener("click", loadBoard);
  const refresh = () => { if (document.hidden) return; if (isMineView()) loadMine(); else loadBoard(); };
  setInterval(refresh, C.LEADERBOARD_REFRESH_SECONDS * 1000);
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("hashchange", showView);
  // สลับแท็บด้วย location.hash โดยตรง (ทำงานได้ทั้งในเว็บและแอปที่ติดตั้ง)
  document.querySelectorAll('a[href="#send"], a[href="#mine"]').forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const target = a.getAttribute("href");
      if (location.hash !== target) location.hash = target;
      else showView();
    }));
  showView();
})();
