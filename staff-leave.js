(function () {
  "use strict";

  const EDIT_ENABLED = typeof APPS_SCRIPT_URL !== "undefined" && !!APPS_SCRIPT_URL;

  const ROLE_LABELS = { vet: "👨‍⚕️ สัตวแพทย์", intern: "🩺 หมอ Intern", assistant: "🙋 ผู้ช่วยประจำห้อง" };
  const ROLE_ORDER = ["vet", "intern", "assistant"];
  const ROLE_MAX_PER_ROOM = { vet: 1, intern: 1, assistant: 2 };
  const LEAVE_TYPES = {
    sick: "🤒 ลาป่วย",
    personal: "🏠 ลากิจ",
    vacation: "🏖️ ลาพักร้อน",
    nightshift: "🌙 ออกเวรไนท์",
    seminar: "📚 ลาสัมมนา/ราชการ",
    covering: "🔄 ทำงานแทนหน่วยอื่น"
  };
  const LEAVE_COLORS = {
    sick: "#FF00FF",
    personal: "#00D4FF",
    vacation: "#34D399",
    nightshift: "#2563EB",
    seminar: "#999999",
    covering: "#FFD966"
  };
  const THAI_WEEKDAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
  const THAI_MONTH_NAMES = [
    "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
  ];
  const ROLE_TEXT_COLORS = { doctor: "#0d9488", assistant: "#e11d48", other: "#a16207" };

  let DATA = { departments: [], rooms: [], staff: [], assignments: [], leaves: [] };

  // ---- date helpers ----
  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function isoDate(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function addDaysToIso(iso, delta) {
    const [y, m, d] = iso.split("-").map(Number);
    return isoDate(new Date(y, m - 1, d + delta));
  }
  function todayStr() { return isoDate(new Date()); }
  function daysInMonth(year, month) { return new Date(year, month, 0).getDate(); }
  function weekdayOf(year, month, day) { return THAI_WEEKDAYS[new Date(year, month - 1, day).getDay()]; }
  function formatThaiDate(iso) {
    if (!iso) return "";
    const parts = iso.split("-");
    if (parts.length !== 3) return iso;
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const d = parseInt(parts[2], 10);
    return d + " " + THAI_MONTH_NAMES[m - 1] + " " + (y + 543);
  }
  function formatThaiDateRange(start, end) {
    if (start === end) return formatThaiDate(start);
    return formatThaiDate(start) + " ถึง " + formatThaiDate(end);
  }
  function personCategory(staffMember, assignmentRole) {
    if (assignmentRole === "vet" || assignmentRole === "intern") return "doctor";
    if (assignmentRole === "assistant") return "assistant";
    const pos = (staffMember && staffMember.position) || "";
    if (pos.indexOf("หมอ") !== -1 || pos.indexOf("สัตวแพทย์") !== -1) return "doctor";
    if (pos.indexOf("ผู้ช่วย") !== -1) return "assistant";
    return "other";
  }
  function personTextColor(staffMember, assignmentRole) {
    return ROLE_TEXT_COLORS[personCategory(staffMember, assignmentRole)];
  }
  function textColorFor(hex) {
    if (!hex) return null;
    const r = parseInt(hex.substr(1, 2), 16);
    const g = parseInt(hex.substr(3, 2), 16);
    const b = parseInt(hex.substr(5, 2), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.6 ? "#1e293b" : "#ffffff";
  }

  function byId(arr, id) { return arr.find((x) => String(x.id) === String(id)); }
  function deptName(id) { const d = byId(DATA.departments, id); return d ? d.name : "(ไม่ระบุแผนก)"; }
  function staffName(id) { const s = byId(DATA.staff, id); return s ? s.name : "(ไม่พบบุคลากร)"; }

  function leaveForStaffOnDate(staffId, dateStr) {
    return DATA.leaves.find((l) => String(l.staffId) === String(staffId) && l.startDate <= dateStr && l.endDate >= dateStr) || null;
  }

  function leavesOnDate(dateStr) {
    return DATA.leaves.filter((l) => l.startDate <= dateStr && l.endDate >= dateStr);
  }

  // ---- connection banner ----
  const connBanner = document.getElementById("conn-banner");
  function showConnBanner(msg) {
    connBanner.textContent = msg;
    connBanner.hidden = !msg;
  }

  // ---- access key (kept only in localStorage, never in source) ----
  let accessKey = localStorage.getItem("slAccessKey") || "";
  const accessGate = document.getElementById("access-gate");
  const accessGateInput = document.getElementById("access-gate-input");
  const accessGateSubmit = document.getElementById("access-gate-submit");
  const accessGateStatus = document.getElementById("access-gate-status");

  function showAccessGate(errorMsg) {
    accessGateStatus.textContent = errorMsg || "";
    accessGateInput.value = "";
    accessGate.hidden = false;
    accessGateInput.focus();
  }
  function hideAccessGate() { accessGate.hidden = true; }

  accessGateSubmit.addEventListener("click", async () => {
    const entered = accessGateInput.value.trim();
    if (!entered) { accessGateStatus.textContent = "กรุณากรอกรหัสผ่าน"; return; }
    accessGateSubmit.disabled = true;
    accessGateStatus.textContent = "กำลังตรวจสอบ...";
    accessKey = entered;
    await loadData();
    accessGateSubmit.disabled = false;
    if (!accessGate.hidden) return; // loadData re-opened the gate with an error
    localStorage.setItem("slAccessKey", accessKey);
    renderEverything();
    goToView("overview");
  });
  accessGateInput.addEventListener("keydown", (e) => { if (e.key === "Enter") accessGateSubmit.click(); });

  // ---- API ----
  async function loadData() {
    if (!EDIT_ENABLED) {
      showConnBanner("⚠️ ยังไม่ได้เชื่อมต่อฐานข้อมูล — ตั้งค่า APPS_SCRIPT_URL ใน staff-leave-config.js (ดูวิธีทำใน apps-script/staff-leave.gs) ตอนนี้แอปทำงานแบบไม่มีข้อมูล");
      return;
    }
    try {
      const res = await fetch(APPS_SCRIPT_URL + "?key=" + encodeURIComponent(accessKey), { method: "GET" });
      const json = await res.json();
      if (json && json.ok) {
        DATA = {
          departments: json.departments || [],
          rooms: json.rooms || [],
          staff: json.staff || [],
          assignments: json.assignments || [],
          leaves: json.leaves || []
        };
        hideAccessGate();
      } else if (json && json.authError) {
        localStorage.removeItem("slAccessKey");
        showAccessGate(json.error || "รหัสผ่านไม่ถูกต้อง");
      } else {
        showConnBanner("❌ โหลดข้อมูลไม่สำเร็จ: " + ((json && json.error) || "unknown error"));
      }
    } catch (err) {
      showConnBanner("❌ เชื่อมต่อฐานข้อมูลไม่ได้: " + err.message);
    }
  }

  async function callApi(action, payload) {
    if (!EDIT_ENABLED) throw new Error("ยังไม่ได้ตั้งค่า APPS_SCRIPT_URL ใน staff-leave-config.js");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    let res;
    try {
      res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, payload, key: accessKey }),
        signal: controller.signal
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error("หมดเวลาเชื่อมต่อ (25 วิ) — ลองใหม่อีกครั้ง");
      }
      throw new Error("เชื่อมต่อไม่ได้: " + err.message);
    } finally {
      clearTimeout(timeoutId);
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error("เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (HTTP " + res.status + ")");
    }
    if (data && data.authError) {
      localStorage.removeItem("slAccessKey");
      showAccessGate(data.error || "รหัสผ่านไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่");
    }
    if (!data || !data.ok) throw new Error((data && data.error) || "บันทึกไม่สำเร็จ");
    return data;
  }

  function getUserName(inputEl) {
    const v = inputEl.value.trim() || "ไม่ระบุชื่อ";
    localStorage.setItem("slUserName", v);
    return v;
  }
  function fillRememberedName(inputEl) {
    inputEl.value = localStorage.getItem("slUserName") || "";
  }

  // ================= TOP-LEVEL TABS =================
  const tabButtons = document.querySelectorAll("#sl-tabs .sl-tab");
  const views = {
    overview: document.getElementById("view-overview"),
    rota: document.getElementById("view-rota"),
    leaves: document.getElementById("view-leaves"),
    admin: document.getElementById("view-admin"),
    dashboard: document.getElementById("view-dashboard"),
    report: document.getElementById("view-report")
  };
  const rotaBadge = document.getElementById("rota-badge");

  // ---- collapsible sidebar (hide/show like Claude's app) ----
  const appShell = document.getElementById("app-shell");
  const sidebarOpenBtn = document.getElementById("sidebar-open-btn");
  const sidebarCloseBtn = document.getElementById("sidebar-close-btn");
  const sidebarBackdrop = document.getElementById("sidebar-backdrop");
  const MOBILE_QUERY = "(max-width: 860px)";

  function setSidebarCollapsed(collapsed) {
    appShell.classList.toggle("sl-sidebar-collapsed", collapsed);
    localStorage.setItem("slSidebarCollapsed", collapsed ? "1" : "0");
  }

  if (localStorage.getItem("slSidebarCollapsed") === "1") setSidebarCollapsed(true);

  sidebarCloseBtn.addEventListener("click", () => setSidebarCollapsed(true));
  sidebarOpenBtn.addEventListener("click", () => setSidebarCollapsed(false));
  sidebarBackdrop.addEventListener("click", () => setSidebarCollapsed(true));

  function goToView(key) {
    Object.keys(views).forEach((k) => { views[k].hidden = k !== key; });
    tabButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.view === key));
    if (key === "rota") markRotaBadgeSeen();
    renderAllForView(key);
  }
  tabButtons.forEach((btn) => btn.addEventListener("click", () => {
    goToView(btn.dataset.view);
    if (window.matchMedia(MOBILE_QUERY).matches) setSidebarCollapsed(true);
  }));

  function renderAllForView(key) {
    if (key === "overview") renderOverview();
    else if (key === "rota") renderRota();
    else if (key === "leaves") renderLeaveLog();
    else if (key === "admin") renderAdmin();
    else if (key === "dashboard") renderDashboard();
    else if (key === "report") { /* rendered on demand via button */ }
  }

  function refreshSharedSelects() {
    fillDeptSelects();
    fillStaffSelects();
    fillRoomSelects();
  }

  function renderEverything() {
    refreshSharedSelects();
    renderOverview();
    renderRota();
    renderLeaveLog();
    renderAdmin();
    updateRotaBadge();
  }

  // ================= OVERVIEW =================
  const overviewDate = document.getElementById("overview-date");
  const overviewTodayBtn = document.getElementById("overview-today-btn");
  const overviewSummary = document.getElementById("overview-summary");
  const overviewDetail = document.getElementById("overview-detail");
  const overviewDetailTitle = document.getElementById("overview-detail-title");
  const overviewDetailList = document.getElementById("overview-detail-list");

  overviewDate.value = todayStr();
  overviewDate.addEventListener("change", renderOverview);
  overviewTodayBtn.addEventListener("click", () => { overviewDate.value = todayStr(); renderOverview(); });

  function renderOverview() {
    const dateStr = overviewDate.value || todayStr();
    overviewSummary.innerHTML = "";
    overviewDetail.hidden = true;

    const todaysLeaves = leavesOnDate(dateStr);
    let grandTotal = 0;

    const depts = DATA.departments.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    depts.forEach((dept) => {
      const rows = todaysLeaves.filter((l) => {
        const s = byId(DATA.staff, l.staffId);
        return s && String(s.departmentId) === String(dept.id);
      });
      const incoming = todaysLeaves.filter((l) => l.type === "covering" && String(l.coveringDepartmentId) === String(dept.id));
      grandTotal += rows.length;

      const card = document.createElement("div");
      card.className = "sl-summary-card";
      card.innerHTML =
        '<span class="sl-summary-num">' + rows.length + '</span>' +
        '<span class="sl-summary-label">' + dept.name + (incoming.length ? " (+" + incoming.length + " มาช่วย)" : "") + '</span>';
      card.addEventListener("click", () => showDeptDetail(dept, rows, incoming, dateStr));
      overviewSummary.appendChild(card);
    });

    const totalCard = document.createElement("div");
    totalCard.className = "sl-summary-card sl-summary-total";
    totalCard.innerHTML = '<span class="sl-summary-num">' + grandTotal + '</span><span class="sl-summary-label">รวมทั้งหมด</span>';
    overviewSummary.appendChild(totalCard);

    if (!depts.length) {
      const empty = document.createElement("div");
      empty.className = "sl-empty";
      empty.textContent = "📭 ยังไม่มีแผนก — เพิ่มแผนกได้ที่แท็บ \"บุคลากร/แผนก\"";
      overviewSummary.appendChild(empty);
    }
  }

  function showDeptDetail(dept, rows, incoming, dateStr) {
    overviewDetail.hidden = false;
    overviewDetailTitle.textContent = dept.name + " — วันที่ " + dateStr;
    overviewDetailList.innerHTML = "";
    if (!rows.length && !incoming.length) {
      const empty = document.createElement("div");
      empty.className = "sl-empty";
      empty.textContent = "✅ ไม่มีใครลาในวันนี้";
      overviewDetailList.appendChild(empty);
      return;
    }
    rows.forEach((l) => {
      const row = document.createElement("div");
      row.className = "sl-leave-row";
      const s = byId(DATA.staff, l.staffId);
      row.innerHTML =
        '<span class="sl-chip" style="background:' + (LEAVE_COLORS[l.type] || "#ccc") + ';color:' + (textColorFor(LEAVE_COLORS[l.type]) || "#1e293b") + '">' +
        (s ? s.name : "?") + " · " + (LEAVE_TYPES[l.type] || l.type) + '</span>' +
        '<span>' + formatThaiDateRange(l.startDate, l.endDate) + '</span>' +
        (l.type === "covering" ? '<span>ไปช่วย: ' + deptName(l.coveringDepartmentId) + '</span>' : '') +
        (l.note ? '<span>หมายเหตุ: ' + escapeHtml(l.note) + '</span>' : '');
      overviewDetailList.appendChild(row);
    });
    incoming.forEach((l) => {
      const row = document.createElement("div");
      row.className = "sl-leave-row";
      row.innerHTML = '<span class="sl-chip" style="background:' + LEAVE_COLORS.covering + '">' + staffName(l.staffId) + ' (มาช่วยจากแผนกอื่น)</span>';
      overviewDetailList.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- date fields: overlay a วัน-เดือน-ปี display on top of native <input type="date"> ----
  function formatDMY(iso) {
    if (!iso) return "";
    const parts = iso.split("-");
    if (parts.length !== 3) return "";
    return parts[2] + "-" + parts[1] + "-" + parts[0];
  }

  function initDateOverlays() {
    const pairs = Array.from(document.querySelectorAll('input[type="date"]')).map((input) => {
      const wrapper = document.createElement("span");
      wrapper.className = "sl-date-field";
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);
      const overlay = document.createElement("span");
      overlay.className = "sl-date-overlay";
      wrapper.appendChild(overlay);
      return { input, overlay, last: undefined };
    });

    function sync() {
      pairs.forEach((p) => {
        if (p.input.value === p.last) return;
        p.last = p.input.value;
        if (p.input.value) {
          p.overlay.textContent = formatDMY(p.input.value);
          p.overlay.classList.remove("sl-date-overlay-empty");
        } else {
          p.overlay.textContent = "วว-ดด-ปปปป";
          p.overlay.classList.add("sl-date-overlay-empty");
        }
      });
    }

    sync();
    setInterval(sync, 300);
  }

  // ================= ROTA (room schedule) =================
  const rotaMonthSelect = document.getElementById("rota-month-select");
  const rotaDayStrip = document.getElementById("rota-day-strip");
  const rotaTodayBtn = document.getElementById("rota-today-btn");
  const rotaPrevDayBtn = document.getElementById("rota-prev-day-btn");
  const rotaNextDayBtn = document.getElementById("rota-next-day-btn");
  const rotaSearchInput = document.getElementById("rota-search-input");
  const rotaSearchResults = document.getElementById("rota-search-results");
  const rotaLegend = document.getElementById("rota-legend");
  const rotaDateHeading = document.getElementById("rota-date-heading");
  const rotaScheduleView = document.getElementById("rota-schedule-view");
  const rotaDashboardView = document.getElementById("rota-dashboard-view");
  const rotaAssignView = document.getElementById("rota-assign-view");
  const rotaStaffReportView = document.getElementById("rota-staffreport-view");
  const rotaSubviewTabs = document.querySelector("#view-rota .sl-subview-tabs");
  const rotaScheduleControls = document.getElementById("rota-schedule-controls");
  const rotaRoomFilter = document.getElementById("rota-room-filter");
  const rotaPeriodTabs = document.getElementById("rota-period-tabs");

  const rotaState = { year: 0, month: 0, day: 0, subview: "schedule", period: "day", roomFilter: "" };
  (function initRotaState() {
    const now = new Date();
    rotaState.year = now.getFullYear();
    rotaState.month = now.getMonth() + 1;
    rotaState.day = now.getDate();
  })();

  function monthWindow(centerYear, centerMonth) {
    const list = [];
    for (let offset = -3; offset <= 9; offset++) {
      const d = new Date(centerYear, centerMonth - 1 + offset, 1);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      list.push({ year: y, month: m, label: THAI_MONTH_NAMES[m - 1] + " " + (y + 543), sortKey: y * 12 + m });
    }
    return list;
  }

  function renderRotaMonthSelect() {
    rotaMonthSelect.innerHTML = "";
    monthWindow(rotaState.year, rotaState.month).forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.year + "-" + m.month;
      opt.textContent = m.label;
      rotaMonthSelect.appendChild(opt);
    });
    rotaMonthSelect.value = rotaState.year + "-" + rotaState.month;
  }

  rotaMonthSelect.addEventListener("change", () => {
    const [y, m] = rotaMonthSelect.value.split("-").map(Number);
    rotaState.year = y;
    rotaState.month = m;
    const maxDay = daysInMonth(y, m);
    if (rotaState.day > maxDay) rotaState.day = maxDay;
    renderRota();
  });

  rotaTodayBtn.addEventListener("click", () => {
    const now = new Date();
    rotaState.year = now.getFullYear();
    rotaState.month = now.getMonth() + 1;
    rotaState.day = now.getDate();
    renderRota();
  });

  rotaPrevDayBtn.addEventListener("click", () => {
    if (rotaState.day > 1) {
      rotaState.day -= 1;
    } else {
      const d = new Date(rotaState.year, rotaState.month - 2, 1);
      rotaState.year = d.getFullYear();
      rotaState.month = d.getMonth() + 1;
      rotaState.day = daysInMonth(rotaState.year, rotaState.month);
    }
    renderRota();
  });

  rotaNextDayBtn.addEventListener("click", () => {
    const maxDay = daysInMonth(rotaState.year, rotaState.month);
    if (rotaState.day < maxDay) {
      rotaState.day += 1;
    } else {
      const d = new Date(rotaState.year, rotaState.month, 1);
      rotaState.year = d.getFullYear();
      rotaState.month = d.getMonth() + 1;
      rotaState.day = 1;
    }
    renderRota();
  });

  function rotaDateStr() { return rotaState.year + "-" + pad2(rotaState.month) + "-" + pad2(rotaState.day); }

  function renderRotaDayStrip() {
    rotaDayStrip.innerHTML = "";
    const maxDay = daysInMonth(rotaState.year, rotaState.month);
    const now = new Date();
    const isCurrentMonth = now.getFullYear() === rotaState.year && now.getMonth() + 1 === rotaState.month;
    for (let d = 1; d <= maxDay; d++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sl-day-btn" + (d === rotaState.day ? " active" : "") + (isCurrentMonth && d === now.getDate() ? " is-today" : "");
      btn.innerHTML = '<span class="d-num">' + d + '</span><span class="d-wd">' + weekdayOf(rotaState.year, rotaState.month, d) + "</span>";
      btn.addEventListener("click", () => { rotaState.day = d; renderRota(); });
      rotaDayStrip.appendChild(btn);
    }
    const activeBtn = rotaDayStrip.querySelector(".sl-day-btn.active");
    if (activeBtn) activeBtn.scrollIntoView({ inline: "center", block: "nearest" });
  }

  function renderRotaLegend() {
    rotaLegend.innerHTML = '<span style="font-weight:700;color:var(--color-muted);font-size:0.78rem;">สถานะ:</span>';
    Object.keys(LEAVE_TYPES).forEach((key) => {
      const wrap = document.createElement("span");
      wrap.className = "sl-legend-item";
      wrap.innerHTML = '<span class="sl-legend-swatch" style="background:' + LEAVE_COLORS[key] + '"></span><span>' + LEAVE_TYPES[key] + "</span>";
      rotaLegend.appendChild(wrap);
    });
  }

  rotaSubviewTabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".sl-tab");
    if (!btn) return;
    rotaState.subview = btn.dataset.subview;
    rotaSubviewTabs.querySelectorAll(".sl-tab").forEach((t) => t.classList.toggle("active", t === btn));
    rotaScheduleControls.hidden = rotaState.subview !== "schedule";
    renderRota();
  });

  rotaRoomFilter.addEventListener("change", () => {
    rotaState.roomFilter = rotaRoomFilter.value;
    renderRota();
  });

  rotaPeriodTabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".sl-tab");
    if (!btn) return;
    rotaState.period = btn.dataset.period;
    rotaPeriodTabs.querySelectorAll(".sl-tab").forEach((t) => t.classList.toggle("active", t === btn));
    renderRota();
  });

  function chipEl(staffMember, leave, ctx) {
    const span = document.createElement("span");
    span.className = "sl-chip";
    const bg = leave ? (LEAVE_COLORS[leave.type] || "#cccccc") : null;
    if (bg) {
      span.style.background = bg;
      const tc = textColorFor(bg);
      if (tc) span.style.color = tc;
    }
    const nameSpan = document.createElement("span");
    nameSpan.textContent = staffMember.name;
    if (!leave) nameSpan.style.color = personTextColor(staffMember, ctx && ctx.role);
    span.appendChild(nameSpan);
    if (leave) {
      const tag = document.createElement("span");
      tag.className = "sl-chip-tag";
      tag.textContent = "(" + (LEAVE_TYPES[leave.type] || leave.type) + ")";
      span.appendChild(tag);
    }
    if (ctx) {
      span.classList.add("sl-chip-editable");
      span.title = "แตะเพื่อบันทึกสถานะขาด/ลา หรือลบออกจากห้อง";
      span.addEventListener("click", () => openQuickEditModal(staffMember, ctx.dateStr, leave, ctx.assignment));
    }
    return span;
  }

  function effectiveRoomsForDate(dateStr) {
    return DATA.rooms.map((room) => {
      const assigns = DATA.assignments.filter((a) => String(a.roomId) === String(room.id) && a.startDate <= dateStr && a.endDate >= dateStr);
      const byRole = { vet: [], intern: [], assistant: [] };
      assigns.forEach((a) => {
        const sm = byId(DATA.staff, a.staffId);
        if (!sm) return;
        const leave = leaveForStaffOnDate(a.staffId, dateStr);
        (byRole[a.role] || (byRole[a.role] = [])).push({ staff: sm, leave, assignment: a });
      });
      return { room, byRole };
    });
  }

  function addPersonChipEl(room, role, dateStr) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sl-chip sl-chip-add";
    btn.textContent = "+ เพิ่ม";
    btn.title = "เพิ่ม " + ROLE_LABELS[role] + " ประจำห้องนี้";
    btn.addEventListener("click", () => openQuickAssignModal(room, role, dateStr));
    return btn;
  }

  function filteredRooms() {
    return rotaState.roomFilter ? DATA.rooms.filter((r) => String(r.id) === String(rotaState.roomFilter)) : DATA.rooms;
  }

  function renderRotaSchedule() {
    rotaScheduleView.hidden = false;
    rotaDashboardView.hidden = true;
    rotaAssignView.hidden = true;
    rotaStaffReportView.hidden = true;

    if (!DATA.rooms.length) {
      rotaScheduleView.className = "sl-room-grid";
      rotaScheduleView.innerHTML = '<div class="sl-empty">📭 ยังไม่มีห้อง — เพิ่มห้องได้ที่แท็บ "บุคลากร/แผนก"</div>';
      return;
    }

    if (rotaState.period === "week") {
      rotaScheduleView.className = "sl-period-list";
      renderRotaPeriodGrid(weekDatesAround(rotaState.year, rotaState.month, rotaState.day));
    } else if (rotaState.period === "month") {
      rotaScheduleView.className = "sl-period-list";
      renderRotaPeriodGrid(monthDates(rotaState.year, rotaState.month));
    } else {
      rotaScheduleView.className = "sl-room-grid";
      renderRotaScheduleDay();
    }
  }

  function renderRotaScheduleDay() {
    const dateStr = rotaDateStr();
    rotaScheduleView.innerHTML = "";

    const rooms = filteredRooms();
    if (!rooms.length) {
      rotaScheduleView.innerHTML = '<div class="sl-empty">🔍 ไม่พบห้องที่เลือก</div>';
      return;
    }

    const entries = effectiveRoomsForDate(dateStr).filter((e) => rooms.some((r) => String(r.id) === String(e.room.id)));

    entries.forEach(({ room, byRole }) => {
      const card = document.createElement("div");
      card.className = "sl-room-card";
      const head = document.createElement("div");
      head.className = "sl-room-head";
      head.innerHTML =
        '<span class="sl-room-name">' + escapeHtml(room.name) + " (" + deptName(room.departmentId) + ")</span>" +
        (room.phone ? '<span class="sl-room-phone">☎ ' + escapeHtml(room.phone) + "</span>" : "");
      card.appendChild(head);

      ROLE_ORDER.forEach((role) => {
        const people = byRole[role];
        const row = document.createElement("div");
        row.className = "sl-role-row";
        const lbl = document.createElement("div");
        lbl.className = "sl-role-label";
        lbl.textContent = ROLE_LABELS[role];
        const chips = document.createElement("div");
        chips.className = "sl-chips";
        people.forEach((p) => chips.appendChild(chipEl(p.staff, p.leave, { dateStr, role, assignment: p.assignment })));
        if (people.length < ROLE_MAX_PER_ROOM[role]) chips.appendChild(addPersonChipEl(room, role, dateStr));
        row.appendChild(lbl);
        row.appendChild(chips);
        card.appendChild(row);
      });

      rotaScheduleView.appendChild(card);
    });
  }

  function weekDatesAround(year, month, day) {
    const base = new Date(year, month - 1, day);
    const start = new Date(base);
    start.setDate(base.getDate() - base.getDay());
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      dates.push({ iso: isoDate(d), label: d.getDate(), wd: THAI_WEEKDAYS[d.getDay()] });
    }
    return dates;
  }

  function monthDates(year, month) {
    const total = daysInMonth(year, month);
    const dates = [];
    for (let d = 1; d <= total; d++) {
      dates.push({ iso: year + "-" + pad2(month) + "-" + pad2(d), label: d, wd: weekdayOf(year, month, d) });
    }
    return dates;
  }

  function renderRotaPeriodGrid(dates) {
    rotaScheduleView.innerHTML = "";
    const rooms = filteredRooms();
    if (!rooms.length) {
      rotaScheduleView.innerHTML = '<div class="sl-empty">🔍 ไม่พบห้องที่เลือก</div>';
      return;
    }

    rooms.forEach((room) => {
      const block = document.createElement("div");
      block.className = "sl-room-card";
      const head = document.createElement("div");
      head.className = "sl-room-head";
      head.innerHTML =
        '<span class="sl-room-name">' + escapeHtml(room.name) + " (" + deptName(room.departmentId) + ")</span>" +
        (room.phone ? '<span class="sl-room-phone">☎ ' + escapeHtml(room.phone) + "</span>" : "");
      block.appendChild(head);

      const scroll = document.createElement("div");
      scroll.className = "sl-period-scroll";
      const grid = document.createElement("div");
      grid.className = "sl-period-grid";
      grid.style.gridTemplateColumns = "90px repeat(" + dates.length + ", minmax(84px, 1fr))";

      grid.appendChild(makePeriodCell("", "sl-period-role-cell"));
      dates.forEach((dt) => {
        const cell = makePeriodCell(dt.label + " " + dt.wd, "sl-period-header-cell");
        grid.appendChild(cell);
      });

      ROLE_ORDER.forEach((role) => {
        grid.appendChild(makePeriodCell(ROLE_LABELS[role], "sl-period-role-cell"));
        dates.forEach((dt) => {
          const cell = document.createElement("div");
          cell.className = "sl-period-cell";
          const assigns = DATA.assignments.filter((a) =>
            String(a.roomId) === String(room.id) && a.role === role && a.startDate <= dt.iso && a.endDate >= dt.iso
          );
          assigns.forEach((a) => {
            const sm = byId(DATA.staff, a.staffId);
            if (!sm) return;
            const leave = leaveForStaffOnDate(a.staffId, dt.iso);
            cell.appendChild(chipEl(sm, leave, { dateStr: dt.iso, role, assignment: a }));
          });
          grid.appendChild(cell);
        });
      });

      scroll.appendChild(grid);
      block.appendChild(scroll);
      rotaScheduleView.appendChild(block);
    });
  }

  function makePeriodCell(text, className) {
    const cell = document.createElement("div");
    cell.className = className;
    cell.textContent = text;
    return cell;
  }

  function renderRotaDashboard() {
    const dateStr = rotaDateStr();
    rotaScheduleView.hidden = true;
    rotaDashboardView.hidden = false;
    rotaAssignView.hidden = true;
    rotaStaffReportView.hidden = true;
    rotaDashboardView.innerHTML = "";

    const entries = effectiveRoomsForDate(dateStr);
    const totals = {};
    Object.keys(LEAVE_TYPES).forEach((k) => { totals[k] = 0; });
    const roomRows = [];

    entries.forEach(({ room, byRole }) => {
      const absentees = [];
      ROLE_ORDER.forEach((role) => {
        byRole[role].forEach((p) => {
          if (p.leave) {
            absentees.push({ staff: p.staff, role, leave: p.leave, assignment: p.assignment });
            totals[p.leave.type] = (totals[p.leave.type] || 0) + 1;
          }
        });
      });
      if (absentees.length) roomRows.push({ room, absentees });
    });

    const summary = document.createElement("div");
    summary.className = "sl-dash-summary";
    let grand = 0;
    Object.keys(LEAVE_TYPES).forEach((key) => {
      grand += totals[key];
      const stat = document.createElement("div");
      stat.className = "sl-dash-stat";
      stat.innerHTML = '<span class="sl-dash-num">' + totals[key] + '</span><span class="sl-dash-label">' + LEAVE_TYPES[key] + "</span>";
      summary.appendChild(stat);
    });
    const totalStat = document.createElement("div");
    totalStat.className = "sl-dash-stat sl-dash-total";
    totalStat.innerHTML = '<span class="sl-dash-num">' + grand + '</span><span class="sl-dash-label">รวมทั้งหมด</span>';
    summary.appendChild(totalStat);
    rotaDashboardView.appendChild(summary);

    if (!roomRows.length) {
      const empty = document.createElement("div");
      empty.className = "sl-empty";
      empty.textContent = "✅ ไม่มีใครขาด/ลาในวันนี้ (เท่าที่มีตารางเวร)";
      rotaDashboardView.appendChild(empty);
      return;
    }

    const table = document.createElement("div");
    table.className = "sl-table";
    roomRows.forEach(({ room, absentees }) => {
      const row = document.createElement("div");
      row.className = "sl-table-row";
      const roomCell = document.createElement("div");
      roomCell.className = "sl-table-cell";
      roomCell.style.fontWeight = "700";
      roomCell.textContent = room.name + " (" + absentees.length + ")";
      const peopleCell = document.createElement("div");
      peopleCell.className = "sl-table-cell";
      peopleCell.style.flex = "2";
      absentees.forEach((a) => {
        const chip = chipEl(a.staff, a.leave, { dateStr, role: a.role, assignment: a.assignment });
        peopleCell.appendChild(chip);
      });
      row.appendChild(roomCell);
      row.appendChild(peopleCell);
      table.appendChild(row);
    });
    rotaDashboardView.appendChild(table);
  }

  function renderRotaAssign() {
    rotaScheduleView.hidden = true;
    rotaDashboardView.hidden = true;
    rotaAssignView.hidden = false;
    rotaStaffReportView.hidden = true;
    renderAssignList();
  }

  function showRotaStaffReport() {
    rotaScheduleView.hidden = true;
    rotaDashboardView.hidden = true;
    rotaAssignView.hidden = true;
    rotaStaffReportView.hidden = false;
    renderStaffReportMonthSelect();
  }

  function renderRota() {
    renderRotaMonthSelect();
    renderRotaDayStrip();
    renderRotaLegend();
    const dateStr = rotaDateStr();
    rotaDateHeading.textContent = "วันที่ " + rotaState.day + " (" + weekdayOf(rotaState.year, rotaState.month, rotaState.day) + ") " +
      THAI_MONTH_NAMES[rotaState.month - 1] + " " + (rotaState.year + 543);

    if (rotaState.subview === "schedule") renderRotaSchedule();
    else if (rotaState.subview === "dashboard") renderRotaDashboard();
    else if (rotaState.subview === "assign") renderRotaAssign();
    else showRotaStaffReport();
  }

  let rotaSearchDebounce = null;
  rotaSearchInput.addEventListener("input", () => {
    clearTimeout(rotaSearchDebounce);
    rotaSearchDebounce = setTimeout(runRotaSearch, 150);
  });

  function runRotaSearch() {
    const q = rotaSearchInput.value.trim();
    rotaSearchResults.innerHTML = "";
    if (!q) return;
    const matches = DATA.staff.filter((s) => s.name.indexOf(q) !== -1).slice(0, 30);
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "sl-search-empty sl-note";
      empty.textContent = "🔍 ไม่พบชื่อที่ตรงกัน";
      rotaSearchResults.appendChild(empty);
      return;
    }
    matches.forEach((sm) => {
      const assigns = DATA.assignments.filter((a) => String(a.staffId) === String(sm.id));
      const hit = document.createElement("div");
      hit.className = "sl-search-hit";
      const label = assigns.length
        ? assigns.map((a) => { const r = byId(DATA.rooms, a.roomId); return (r ? r.name : "?") + " (" + formatThaiDateRange(a.startDate, a.endDate) + ")"; }).join(", ")
        : "ยังไม่มีตารางเวร";
      hit.innerHTML = "<div><div>" + escapeHtml(sm.name) + "</div><div style='color:var(--color-muted);font-size:0.78rem;'>" + escapeHtml(label) + "</div></div>";
      hit.addEventListener("click", () => {
        if (assigns.length) {
          const target = assigns[0].startDate;
          const [y, m, d] = target.split("-").map(Number);
          rotaState.year = y; rotaState.month = m; rotaState.day = d;
        }
        rotaSearchInput.value = "";
        rotaSearchResults.innerHTML = "";
        rotaState.subview = "schedule";
        rotaSubviewTabs.querySelectorAll(".sl-tab").forEach((t) => t.classList.toggle("active", t.dataset.subview === "schedule"));
        renderRota();
      });
      rotaSearchResults.appendChild(hit);
    });
  }

  // ---- assignment form ----
  const assignRoomSelect = document.getElementById("assign-room-select");
  const assignRoleSelect = document.getElementById("assign-role-select");
  const assignStaffSelect = document.getElementById("assign-staff-select");
  const assignStartDate = document.getElementById("assign-start-date");
  const assignEndDate = document.getElementById("assign-end-date");
  const assignNote = document.getElementById("assign-note");
  const assignSaveBtn = document.getElementById("assign-save-btn");
  const assignStatusMsg = document.getElementById("assign-status-msg");
  const assignList = document.getElementById("assign-list");

  assignRoomSelect.addEventListener("change", renderAssignList);
  assignRoleSelect.addEventListener("change", fillStaffSelects);

  function renderAssignList() {
    assignList.innerHTML = "";
    const roomId = assignRoomSelect.value;
    const rows = DATA.assignments.filter((a) => String(a.roomId) === String(roomId))
      .sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "sl-empty";
      empty.textContent = "📭 ยังไม่มีตารางเวรสำหรับห้องนี้";
      assignList.appendChild(empty);
      return;
    }
    rows.forEach((a) => {
      const row = document.createElement("div");
      row.className = "sl-table-row";
      const smA = byId(DATA.staff, a.staffId);
      row.innerHTML =
        '<span class="sl-table-cell" style="color:' + personTextColor(smA, a.role) + ';font-weight:700;">' + escapeHtml(staffName(a.staffId)) + '</span>' +
        '<span class="sl-table-cell">' + ROLE_LABELS[a.role] + '</span>' +
        '<span class="sl-table-cell">' + formatThaiDateRange(a.startDate, a.endDate) + '</span>';
      const actions = document.createElement("span");
      actions.className = "sl-table-actions";
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "sl-btn sl-btn-danger";
      delBtn.textContent = "ลบ";
      delBtn.addEventListener("click", async () => {
        delBtn.disabled = true;
        try {
          await callApi("deleteAssignment", { id: a.id });
          DATA.assignments = DATA.assignments.filter((x) => x.id !== a.id);
          renderAssignList();
          renderRota();
          updateRotaBadge();
        } catch (err) {
          assignStatusMsg.textContent = "ลบไม่สำเร็จ: " + err.message;
          assignStatusMsg.classList.add("sl-status-error");
          delBtn.disabled = false;
        }
      });
      actions.appendChild(delBtn);
      row.appendChild(actions);
      assignList.appendChild(row);
    });
  }

  assignSaveBtn.addEventListener("click", async () => {
    assignStatusMsg.classList.remove("sl-status-error");
    if (!assignRoomSelect.value || !assignStaffSelect.value || !assignStartDate.value || !assignEndDate.value) {
      assignStatusMsg.textContent = "กรุณากรอกห้อง บุคลากร และช่วงวันที่ให้ครบ";
      assignStatusMsg.classList.add("sl-status-error");
      return;
    }
    if (assignEndDate.value < assignStartDate.value) {
      assignStatusMsg.textContent = "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น";
      assignStatusMsg.classList.add("sl-status-error");
      return;
    }
    const roleMax = ROLE_MAX_PER_ROOM[assignRoleSelect.value];
    const existingCount = countOverlappingAssignments(assignRoomSelect.value, assignRoleSelect.value, assignStartDate.value, assignEndDate.value);
    if (existingCount >= roleMax) {
      assignStatusMsg.textContent = "❌ ห้องนี้มี" + ROLE_LABELS[assignRoleSelect.value] + "ครบ " + roleMax + " คนแล้วในช่วงวันที่เลือก";
      assignStatusMsg.classList.add("sl-status-error");
      return;
    }
    assignSaveBtn.disabled = true;
    assignStatusMsg.textContent = "กำลังบันทึก...";
    try {
      const payload = {
        roomId: assignRoomSelect.value,
        role: assignRoleSelect.value,
        staffId: assignStaffSelect.value,
        startDate: assignStartDate.value,
        endDate: assignEndDate.value,
        note: assignNote.value.trim(),
        createdBy: "web"
      };
      const res = await callApi("addAssignment", payload);
      DATA.assignments.push(Object.assign({ id: res.id }, payload));
      assignStatusMsg.textContent = "✅ บันทึกแล้ว";
      assignNote.value = "";
      renderAssignList();
      renderRota();
      updateRotaBadge();
    } catch (err) {
      assignStatusMsg.textContent = "❌ บันทึกไม่สำเร็จ: " + err.message;
      assignStatusMsg.classList.add("sl-status-error");
    } finally {
      assignSaveBtn.disabled = false;
    }
  });

  // ---- quick-assign modal (add person to a room+role straight from the schedule view) ----
  const quickAssignModal = document.getElementById("quick-assign-modal");
  const quickAssignTitle = document.getElementById("quick-assign-title");
  const quickAssignStaffSelect = document.getElementById("quick-assign-staff-select");
  const quickAssignStartDate = document.getElementById("quick-assign-start-date");
  const quickAssignEndDate = document.getElementById("quick-assign-end-date");
  const quickAssignNote = document.getElementById("quick-assign-note");
  const quickAssignSaveBtn = document.getElementById("quick-assign-save-btn");
  const quickAssignCancelBtn = document.getElementById("quick-assign-cancel-btn");
  const quickAssignStatus = document.getElementById("quick-assign-status");

  let quickAssignCtx = null;

  function staffCandidatesForRole(role) {
    if (role === "vet" || role === "intern") return DATA.staff.filter((s) => personCategory(s) === "doctor");
    return DATA.staff;
  }

  function countOverlappingAssignments(roomId, role, startDate, endDate) {
    return DATA.assignments.filter((a) =>
      String(a.roomId) === String(roomId) &&
      a.role === role &&
      a.startDate <= endDate &&
      a.endDate >= startDate
    ).length;
  }

  function openQuickAssignModal(room, role, dateStr) {
    quickAssignCtx = { room, role };
    quickAssignTitle.textContent = "เพิ่ม " + ROLE_LABELS[role] + " · " + room.name;
    quickAssignStaffSelect.innerHTML = "";
    const candidates = staffCandidatesForRole(role);
    if (!candidates.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "🔍 ไม่มีบุคลากรตำแหน่งหมอในระบบ";
      quickAssignStaffSelect.appendChild(opt);
    }
    candidates.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name + " (" + deptName(s.departmentId) + ")";
      quickAssignStaffSelect.appendChild(opt);
    });
    quickAssignStartDate.value = dateStr;
    quickAssignEndDate.value = dateStr;
    quickAssignNote.value = "";
    quickAssignStatus.textContent = "";
    quickAssignModal.hidden = false;
  }

  function closeQuickAssignModal() {
    quickAssignModal.hidden = true;
    quickAssignCtx = null;
  }

  quickAssignCancelBtn.addEventListener("click", closeQuickAssignModal);
  quickAssignModal.addEventListener("click", (e) => {
    if (e.target === quickAssignModal) closeQuickAssignModal();
  });

  quickAssignSaveBtn.addEventListener("click", async () => {
    if (!quickAssignCtx) return;
    quickAssignStatus.textContent = "";
    if (!quickAssignStaffSelect.value) {
      quickAssignStatus.textContent = "กรุณาเลือกบุคลากร";
      return;
    }
    if (!quickAssignStartDate.value || !quickAssignEndDate.value) {
      quickAssignStatus.textContent = "กรุณาเลือกช่วงวันที่";
      return;
    }
    if (quickAssignEndDate.value < quickAssignStartDate.value) {
      quickAssignStatus.textContent = "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น";
      return;
    }
    const roleMax = ROLE_MAX_PER_ROOM[quickAssignCtx.role];
    const existingCount = countOverlappingAssignments(quickAssignCtx.room.id, quickAssignCtx.role, quickAssignStartDate.value, quickAssignEndDate.value);
    if (existingCount >= roleMax) {
      quickAssignStatus.textContent = "❌ ห้องนี้มี" + ROLE_LABELS[quickAssignCtx.role] + "ครบ " + roleMax + " คนแล้วในช่วงวันที่เลือก";
      return;
    }
    quickAssignSaveBtn.disabled = true;
    quickAssignStatus.textContent = "กำลังบันทึก...";
    try {
      const payload = {
        roomId: quickAssignCtx.room.id,
        role: quickAssignCtx.role,
        staffId: quickAssignStaffSelect.value,
        startDate: quickAssignStartDate.value,
        endDate: quickAssignEndDate.value,
        note: quickAssignNote.value.trim(),
        createdBy: "web"
      };
      const res = await callApi("addAssignment", payload);
      DATA.assignments.push(Object.assign({ id: res.id }, payload));
      closeQuickAssignModal();
      renderRota();
      updateRotaBadge();
    } catch (err) {
      quickAssignStatus.textContent = "❌ บันทึกไม่สำเร็จ: " + err.message;
    } finally {
      quickAssignSaveBtn.disabled = false;
    }
  });

  // ---- staff monthly room report (search a person, list their rooms per weekday) ----
  const staffreportSearch = document.getElementById("staffreport-search");
  const staffreportSearchResults = document.getElementById("staffreport-search-results");
  const staffreportSelected = document.getElementById("staffreport-selected");
  const staffreportMonthSelect = document.getElementById("staffreport-month-select");
  const staffreportRunBtn = document.getElementById("staffreport-run-btn");
  const staffreportExportBtn = document.getElementById("staffreport-export-btn");
  const staffreportStatus = document.getElementById("staffreport-status");
  const staffreportTable = document.getElementById("staffreport-table");

  let staffReportStaffId = null;

  function renderStaffReportMonthSelect() {
    const prevValue = staffreportMonthSelect.value;
    staffreportMonthSelect.innerHTML = "";
    monthWindow(rotaState.year, rotaState.month).forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.year + "-" + m.month;
      opt.textContent = m.label;
      staffreportMonthSelect.appendChild(opt);
    });
    staffreportMonthSelect.value = prevValue || (rotaState.year + "-" + rotaState.month);
  }

  let staffreportSearchDebounce = null;
  staffreportSearch.addEventListener("input", () => {
    clearTimeout(staffreportSearchDebounce);
    staffreportSearchDebounce = setTimeout(runStaffReportSearch, 150);
  });

  function runStaffReportSearch() {
    const q = staffreportSearch.value.trim();
    staffreportSearchResults.innerHTML = "";
    if (!q) return;
    const matches = DATA.staff.filter((s) => s.name.indexOf(q) !== -1).slice(0, 20);
    matches.forEach((sm) => {
      const hit = document.createElement("div");
      hit.className = "sl-search-hit";
      hit.textContent = sm.name + " · " + deptName(sm.departmentId);
      hit.addEventListener("click", () => {
        staffReportStaffId = sm.id;
        staffreportSelected.textContent = "✅ เลือก: " + sm.name + " (" + deptName(sm.departmentId) + ")";
        staffreportSearch.value = "";
        staffreportSearchResults.innerHTML = "";
      });
      staffreportSearchResults.appendChild(hit);
    });
  }

  function weekdaysInMonth(year, month) {
    const total = daysInMonth(year, month);
    const days = [];
    for (let d = 1; d <= total; d++) {
      const dow = new Date(year, month - 1, d).getDay();
      if (dow >= 1 && dow <= 5) days.push({ iso: year + "-" + pad2(month) + "-" + pad2(d), wd: weekdayOf(year, month, d) });
    }
    return days;
  }

  function staffRoomsOnDate(staffId, dateStr) {
    return DATA.assignments
      .filter((a) => String(a.staffId) === String(staffId) && a.startDate <= dateStr && a.endDate >= dateStr)
      .map((a) => { const r = byId(DATA.rooms, a.roomId); return (r ? r.name : "?") + " (" + ROLE_LABELS[a.role] + ")"; });
  }

  function staffReportRows() {
    if (!staffReportStaffId || !staffreportMonthSelect.value) return null;
    const [y, m] = staffreportMonthSelect.value.split("-").map(Number);
    return weekdaysInMonth(y, m).map((dt) => ({
      dateStr: dt.iso,
      wd: dt.wd,
      rooms: staffRoomsOnDate(staffReportStaffId, dt.iso)
    }));
  }

  const CALENDAR_WEEKDAY_COLS = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์"];

  function staffReportCalendarWeeks(year, month) {
    const total = daysInMonth(year, month);
    const weeks = [];
    let currentWeek = null;
    for (let d = 1; d <= total; d++) {
      const dow = new Date(year, month - 1, d).getDay();
      if (dow === 0 || dow === 6) continue;
      const col = dow - 1;
      if (!currentWeek || col === 0) {
        currentWeek = [null, null, null, null, null];
        weeks.push(currentWeek);
      }
      currentWeek[col] = { day: d, iso: year + "-" + pad2(month) + "-" + pad2(d) };
    }
    return weeks;
  }

  function renderStaffReportTable() {
    staffreportTable.innerHTML = "";
    if (!staffReportStaffId) {
      staffreportStatus.textContent = "กรุณาเลือกบุคลากรก่อน";
      return;
    }
    staffreportStatus.textContent = "";
    const [y, m] = staffreportMonthSelect.value.split("-").map(Number);
    const weeks = staffReportCalendarWeeks(y, m);

    const scroll = document.createElement("div");
    scroll.className = "sl-period-scroll";
    const grid = document.createElement("div");
    grid.className = "sl-calendar-grid";

    CALENDAR_WEEKDAY_COLS.forEach((label) => {
      const cell = document.createElement("div");
      cell.className = "sl-calendar-header-cell";
      cell.textContent = label;
      grid.appendChild(cell);
    });

    weeks.forEach((week) => {
      week.forEach((dayInfo) => {
        const cell = document.createElement("div");
        cell.className = "sl-calendar-cell";
        if (dayInfo) {
          const rooms = staffRoomsOnDate(staffReportStaffId, dayInfo.iso);
          cell.innerHTML =
            '<span class="sl-calendar-daynum">' + dayInfo.day + '</span>' +
            (rooms.length
              ? '<span class="sl-calendar-room">' + escapeHtml(rooms.join(", ")) + '</span>'
              : '<span class="sl-calendar-room sl-calendar-empty">-</span>');
        }
        grid.appendChild(cell);
      });
    });

    scroll.appendChild(grid);
    staffreportTable.appendChild(scroll);
  }

  staffreportRunBtn.addEventListener("click", renderStaffReportTable);

  staffreportExportBtn.addEventListener("click", () => {
    const rows = staffReportRows();
    if (!staffReportStaffId || !rows) {
      staffreportStatus.textContent = "กรุณาเลือกบุคลากรก่อน";
      return;
    }
    const sm = byId(DATA.staff, staffReportStaffId);
    const header = ["วันที่", "วัน", "ห้อง"];
    const lines = [header.map(csvEscape).join(",")];
    rows.forEach((row) => {
      lines.push([row.dateStr, row.wd, row.rooms.join(" / ") || ""].map(csvEscape).join(","));
    });
    const csvContent = "﻿" + lines.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "room-report_" + (sm ? sm.name : "staff") + "_" + staffreportMonthSelect.value + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    staffreportStatus.textContent = "✅ ดาวน์โหลดแล้ว (" + rows.length + " วัน)";
  });

  // ---- absence badge (in-app notification) ----
  function countAssignedAbsentToday() {
    const dateStr = todayStr();
    let count = 0;
    DATA.assignments.forEach((a) => {
      if (a.startDate <= dateStr && a.endDate >= dateStr && leaveForStaffOnDate(a.staffId, dateStr)) count += 1;
    });
    return count;
  }

  function updateRotaBadge() {
    const count = countAssignedAbsentToday();
    const seenRaw = localStorage.getItem("slSeenAbsentCount_" + todayStr());
    const seen = seenRaw != null ? parseInt(seenRaw, 10) : 0;
    const rotaViewActive = !views.rota.hidden;
    if (count > 0 && count !== seen && !rotaViewActive) {
      rotaBadge.textContent = String(count);
      rotaBadge.hidden = false;
    } else {
      rotaBadge.hidden = true;
    }
  }
  function markRotaBadgeSeen() {
    localStorage.setItem("slSeenAbsentCount_" + todayStr(), String(countAssignedAbsentToday()));
    rotaBadge.hidden = true;
  }

  // ================= SHARED: quick-edit / full-edit MODAL =================
  const editModal = document.getElementById("edit-modal");
  const editModalTitle = document.getElementById("edit-modal-title");
  const editDateRangeRow = document.getElementById("edit-date-range-row");
  const editStartDate = document.getElementById("edit-start-date");
  const editEndDate = document.getElementById("edit-end-date");
  const editTypeSelect = document.getElementById("edit-type-select");
  const editCoveringDeptRow = document.getElementById("edit-covering-dept-row");
  const editCoveringDeptSelect = document.getElementById("edit-covering-dept-select");
  const editNoteInput = document.getElementById("edit-note-input");
  const editUserInput = document.getElementById("edit-user-input");
  const editSaveBtn = document.getElementById("edit-save-btn");
  const editCancelBtn = document.getElementById("edit-cancel-btn");
  const editModalStatus = document.getElementById("edit-modal-status");
  const editRemoveAssignmentBtn = document.getElementById("edit-remove-assignment-btn");

  let editCtx = null; // { mode: "quick"|"full", staffId, existingLeaveId, dateStr, assignmentId }

  editTypeSelect.addEventListener("change", () => {
    editCoveringDeptRow.hidden = editTypeSelect.value !== "covering";
  });

  function openQuickEditModal(staffMember, dateStr, existingLeave, assignment) {
    editCtx = {
      mode: "quick",
      staffId: staffMember.id,
      existingLeaveId: existingLeave ? existingLeave.id : null,
      dateStr,
      assignmentId: assignment ? assignment.id : null
    };
    editModalTitle.textContent = staffMember.name + " · " + dateStr;
    editDateRangeRow.hidden = true;
    editTypeSelect.value = existingLeave ? existingLeave.type : "";
    editCoveringDeptRow.hidden = !existingLeave || existingLeave.type !== "covering";
    if (existingLeave && existingLeave.type === "covering") editCoveringDeptSelect.value = existingLeave.coveringDepartmentId || "";
    editNoteInput.value = existingLeave ? existingLeave.note || "" : "";
    fillRememberedName(editUserInput);
    editModalStatus.textContent = "";
    editRemoveAssignmentBtn.hidden = !assignment;
    editModal.hidden = false;
  }

  function openFullEditModal(leave) {
    const sm = byId(DATA.staff, leave.staffId);
    editCtx = { mode: "full", staffId: leave.staffId, existingLeaveId: leave.id, dateStr: null, assignmentId: null };
    editModalTitle.textContent = (sm ? sm.name : "?") + " — แก้ไขการลา";
    editRemoveAssignmentBtn.hidden = true;
    editDateRangeRow.hidden = false;
    editStartDate.value = leave.startDate;
    editEndDate.value = leave.endDate;
    editTypeSelect.value = leave.type;
    editCoveringDeptRow.hidden = leave.type !== "covering";
    if (leave.type === "covering") editCoveringDeptSelect.value = leave.coveringDepartmentId || "";
    editNoteInput.value = leave.note || "";
    fillRememberedName(editUserInput);
    editModalStatus.textContent = "";
    editModal.hidden = false;
  }

  function closeEditModal() { editModal.hidden = true; editCtx = null; }
  editCancelBtn.addEventListener("click", closeEditModal);
  editModal.addEventListener("click", (e) => { if (e.target === editModal) closeEditModal(); });

  editRemoveAssignmentBtn.addEventListener("click", async () => {
    if (!editCtx || !editCtx.assignmentId) return;
    const assignment = byId(DATA.assignments, editCtx.assignmentId);
    const targetDate = editCtx.dateStr;
    if (!assignment || !targetDate) return;

    editRemoveAssignmentBtn.disabled = true;
    editModalStatus.textContent = "กำลังลบ...";
    try {
      if (assignment.startDate === targetDate && assignment.endDate === targetDate) {
        // whole assignment is just this one day — remove it entirely
        await callApi("deleteAssignment", { id: assignment.id });
        DATA.assignments = DATA.assignments.filter((a) => a.id !== assignment.id);
      } else if (assignment.startDate === targetDate) {
        // trim the day off the front
        const newStart = addDaysToIso(targetDate, 1);
        await callApi("updateAssignment", { id: assignment.id, startDate: newStart });
        assignment.startDate = newStart;
      } else if (assignment.endDate === targetDate) {
        // trim the day off the back
        const newEnd = addDaysToIso(targetDate, -1);
        await callApi("updateAssignment", { id: assignment.id, endDate: newEnd });
        assignment.endDate = newEnd;
      } else {
        // day is in the middle — split into a before-range and an after-range
        const originalEnd = assignment.endDate;
        const beforeEnd = addDaysToIso(targetDate, -1);
        await callApi("updateAssignment", { id: assignment.id, endDate: beforeEnd });
        assignment.endDate = beforeEnd;
        const afterPayload = {
          roomId: assignment.roomId,
          staffId: assignment.staffId,
          role: assignment.role,
          startDate: addDaysToIso(targetDate, 1),
          endDate: originalEnd,
          note: assignment.note || "",
          createdBy: assignment.createdBy || "web"
        };
        const res = await callApi("addAssignment", afterPayload);
        DATA.assignments.push(Object.assign({ id: res.id }, afterPayload));
      }
      closeEditModal();
      renderRota();
      updateRotaBadge();
    } catch (err) {
      editModalStatus.textContent = "❌ ลบไม่สำเร็จ: " + err.message;
    } finally {
      editRemoveAssignmentBtn.disabled = false;
    }
  });

  editSaveBtn.addEventListener("click", async () => {
    if (!editCtx) return;
    const type = editTypeSelect.value;
    const userName = getUserName(editUserInput);
    editModalStatus.textContent = "กำลังบันทึก...";
    editSaveBtn.disabled = true;
    try {
      if (!type) {
        if (editCtx.existingLeaveId) {
          await callApi("deleteLeave", { id: editCtx.existingLeaveId });
          DATA.leaves = DATA.leaves.filter((l) => l.id !== editCtx.existingLeaveId);
        }
      } else {
        const basePayload = {
          type,
          note: editNoteInput.value.trim(),
          coveringDepartmentId: type === "covering" ? editCoveringDeptSelect.value : "",
          createdBy: userName
        };
        if (editCtx.mode === "quick") {
          if (editCtx.existingLeaveId) {
            await callApi("updateLeave", Object.assign({ id: editCtx.existingLeaveId }, basePayload));
            const idx = DATA.leaves.findIndex((l) => l.id === editCtx.existingLeaveId);
            if (idx !== -1) DATA.leaves[idx] = Object.assign({}, DATA.leaves[idx], basePayload);
          } else {
            const payload = Object.assign({ staffId: editCtx.staffId, startDate: editCtx.dateStr, endDate: editCtx.dateStr }, basePayload);
            const res = await callApi("addLeave", payload);
            DATA.leaves.push(Object.assign({ id: res.id }, payload));
          }
        } else {
          if (editEndDate.value < editStartDate.value) throw new Error("วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น");
          const payload = Object.assign({ id: editCtx.existingLeaveId, startDate: editStartDate.value, endDate: editEndDate.value }, basePayload);
          await callApi("updateLeave", payload);
          const idx = DATA.leaves.findIndex((l) => l.id === editCtx.existingLeaveId);
          if (idx !== -1) DATA.leaves[idx] = Object.assign({}, DATA.leaves[idx], payload);
        }
      }
      closeEditModal();
      renderRota();
      renderOverview();
      renderLeaveLog();
      updateRotaBadge();
    } catch (err) {
      editModalStatus.textContent = "❌ บันทึกไม่สำเร็จ: " + err.message;
    } finally {
      editSaveBtn.disabled = false;
    }
  });

  // ================= LEAVE LOG =================
  const leaveStaffSearch = document.getElementById("leave-staff-search");
  const leaveStaffResults = document.getElementById("leave-staff-results");
  const leaveStaffSelected = document.getElementById("leave-staff-selected");
  const leaveStartDate = document.getElementById("leave-start-date");
  const leaveEndDate = document.getElementById("leave-end-date");
  const leaveTypeSelect = document.getElementById("leave-type-select");
  const leaveCoveringDeptRow = document.getElementById("leave-covering-dept-row");
  const leaveCoveringDeptSelect = document.getElementById("leave-covering-dept-select");
  const leaveNote = document.getElementById("leave-note");
  const leaveUserInput = document.getElementById("leave-user-input");
  const leaveSaveBtn = document.getElementById("leave-save-btn");
  const leaveFormStatus = document.getElementById("leave-form-status");
  const leaveLogTable = document.getElementById("leave-log-table");

  let selectedLeaveStaffId = null;
  fillRememberedName(leaveUserInput);
  leaveStartDate.value = todayStr();
  leaveEndDate.value = todayStr();

  leaveTypeSelect.addEventListener("change", () => {
    leaveCoveringDeptRow.hidden = leaveTypeSelect.value !== "covering";
  });

  let leaveSearchDebounce = null;
  leaveStaffSearch.addEventListener("input", () => {
    clearTimeout(leaveSearchDebounce);
    leaveSearchDebounce = setTimeout(runLeaveStaffSearch, 150);
  });

  function runLeaveStaffSearch() {
    const q = leaveStaffSearch.value.trim();
    leaveStaffResults.innerHTML = "";
    if (!q) return;
    const matches = DATA.staff.filter((s) => s.name.indexOf(q) !== -1).slice(0, 20);
    matches.forEach((sm) => {
      const hit = document.createElement("div");
      hit.className = "sl-search-hit";
      hit.textContent = sm.name + " · " + deptName(sm.departmentId);
      hit.addEventListener("click", () => {
        selectedLeaveStaffId = sm.id;
        leaveStaffSelected.textContent = "✅ เลือก: " + sm.name + " (" + deptName(sm.departmentId) + ")";
        leaveStaffSearch.value = "";
        leaveStaffResults.innerHTML = "";
      });
      leaveStaffResults.appendChild(hit);
    });
  }

  leaveSaveBtn.addEventListener("click", async () => {
    leaveFormStatus.classList.remove("sl-status-error");
    if (!selectedLeaveStaffId) {
      leaveFormStatus.textContent = "กรุณาเลือกบุคลากรก่อน";
      leaveFormStatus.classList.add("sl-status-error");
      return;
    }
    if (!leaveStartDate.value || !leaveEndDate.value) {
      leaveFormStatus.textContent = "กรุณาเลือกช่วงวันที่";
      leaveFormStatus.classList.add("sl-status-error");
      return;
    }
    if (leaveEndDate.value < leaveStartDate.value) {
      leaveFormStatus.textContent = "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น";
      leaveFormStatus.classList.add("sl-status-error");
      return;
    }
    leaveSaveBtn.disabled = true;
    leaveFormStatus.textContent = "กำลังบันทึก...";
    try {
      const payload = {
        staffId: selectedLeaveStaffId,
        startDate: leaveStartDate.value,
        endDate: leaveEndDate.value,
        type: leaveTypeSelect.value,
        note: leaveNote.value.trim(),
        coveringDepartmentId: leaveTypeSelect.value === "covering" ? leaveCoveringDeptSelect.value : "",
        createdBy: getUserName(leaveUserInput)
      };
      const res = await callApi("addLeave", payload);
      DATA.leaves.push(Object.assign({ id: res.id }, payload));
      leaveFormStatus.textContent = "✅ บันทึกแล้ว";
      leaveNote.value = "";
      selectedLeaveStaffId = null;
      leaveStaffSelected.textContent = "";
      renderLeaveLog();
      renderOverview();
      renderRota();
      updateRotaBadge();
    } catch (err) {
      leaveFormStatus.textContent = "❌ บันทึกไม่สำเร็จ: " + err.message;
      leaveFormStatus.classList.add("sl-status-error");
    } finally {
      leaveSaveBtn.disabled = false;
    }
  });

  function renderLeaveLog() {
    leaveLogTable.innerHTML = "";
    const rows = DATA.leaves.slice().sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "sl-empty";
      empty.textContent = "📭 ยังไม่มีบันทึกการลา";
      leaveLogTable.appendChild(empty);
      return;
    }
    rows.forEach((l) => {
      const row = document.createElement("div");
      row.className = "sl-table-row";
      const smL = byId(DATA.staff, l.staffId);
      row.innerHTML =
        '<span class="sl-table-cell" style="color:' + personTextColor(smL) + ';font-weight:700;">' + escapeHtml(staffName(l.staffId)) + '</span>' +
        '<span class="sl-table-cell">' + escapeHtml(deptName(smL && smL.departmentId)) + '</span>' +
        '<span class="sl-table-cell">' + formatThaiDateRange(l.startDate, l.endDate) + '</span>' +
        '<span class="sl-table-cell">' + (LEAVE_TYPES[l.type] || l.type) + (l.type === "covering" ? " (" + escapeHtml(deptName(l.coveringDepartmentId)) + ")" : "") + '</span>';
      const actions = document.createElement("span");
      actions.className = "sl-table-actions";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "sl-btn";
      editBtn.textContent = "แก้ไข";
      editBtn.addEventListener("click", () => openFullEditModal(l));
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "sl-btn sl-btn-danger";
      delBtn.textContent = "ลบ";
      delBtn.addEventListener("click", async () => {
        delBtn.disabled = true;
        try {
          await callApi("deleteLeave", { id: l.id });
          DATA.leaves = DATA.leaves.filter((x) => x.id !== l.id);
          renderLeaveLog();
          renderOverview();
          renderRota();
          updateRotaBadge();
        } catch (err) {
          delBtn.disabled = false;
        }
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      row.appendChild(actions);
      leaveLogTable.appendChild(row);
    });
  }

  // ================= ADMIN (departments / rooms / staff) =================
  const deptNameInput = document.getElementById("dept-name-input");
  const deptAddBtn = document.getElementById("dept-add-btn");
  const deptStatusMsg = document.getElementById("dept-status-msg");
  const deptTable = document.getElementById("dept-table");

  const roomDeptSelect = document.getElementById("room-dept-select");
  const roomNameInput = document.getElementById("room-name-input");
  const roomPhoneInput = document.getElementById("room-phone-input");
  const roomAddBtn = document.getElementById("room-add-btn");
  const roomStatusMsg = document.getElementById("room-status-msg");
  const roomTable = document.getElementById("room-table");

  const staffNameInput = document.getElementById("staff-name-input");
  const staffPositionInput = document.getElementById("staff-position-input");
  const staffDeptSelect = document.getElementById("staff-dept-select");
  const staffAddBtn = document.getElementById("staff-add-btn");
  const staffStatusMsg = document.getElementById("staff-status-msg");
  const staffTable = document.getElementById("staff-table");
  const staffSearchInput = document.getElementById("staff-search-input");

  let staffSearchDebounce = null;
  staffSearchInput.addEventListener("input", () => {
    clearTimeout(staffSearchDebounce);
    staffSearchDebounce = setTimeout(renderStaffTable, 150);
  });

  deptAddBtn.addEventListener("click", async () => {
    const name = deptNameInput.value.trim();
    if (!name) { deptStatusMsg.textContent = "กรุณากรอกชื่อแผนก"; return; }
    deptAddBtn.disabled = true;
    deptStatusMsg.textContent = "กำลังบันทึก...";
    try {
      const payload = { name, order: DATA.departments.length };
      const res = await callApi("addDepartment", payload);
      DATA.departments.push(Object.assign({ id: res.id }, payload));
      deptNameInput.value = "";
      deptStatusMsg.textContent = "✅ เพิ่มแล้ว";
      refreshSharedSelects();
      renderAdmin();
      renderOverview();
    } catch (err) {
      deptStatusMsg.textContent = "❌ ไม่สำเร็จ: " + err.message;
    } finally {
      deptAddBtn.disabled = false;
    }
  });

  roomAddBtn.addEventListener("click", async () => {
    const name = roomNameInput.value.trim();
    if (!roomDeptSelect.value || !name) { roomStatusMsg.textContent = "กรุณาเลือกแผนกและกรอกชื่อห้อง"; return; }
    roomAddBtn.disabled = true;
    roomStatusMsg.textContent = "กำลังบันทึก...";
    try {
      const payload = { departmentId: roomDeptSelect.value, name, phone: roomPhoneInput.value.trim() };
      const res = await callApi("addRoom", payload);
      DATA.rooms.push(Object.assign({ id: res.id }, payload));
      roomNameInput.value = "";
      roomPhoneInput.value = "";
      roomStatusMsg.textContent = "✅ เพิ่มแล้ว";
      refreshSharedSelects();
      renderAdmin();
      renderRota();
    } catch (err) {
      roomStatusMsg.textContent = "❌ ไม่สำเร็จ: " + err.message;
    } finally {
      roomAddBtn.disabled = false;
    }
  });

  staffAddBtn.addEventListener("click", async () => {
    const name = staffNameInput.value.trim();
    if (!name || !staffDeptSelect.value) { staffStatusMsg.textContent = "กรุณากรอกชื่อและเลือกแผนก"; return; }
    staffAddBtn.disabled = true;
    staffStatusMsg.textContent = "กำลังบันทึก...";
    try {
      const payload = { name, position: staffPositionInput.value.trim(), departmentId: staffDeptSelect.value, active: true };
      const res = await callApi("addStaff", payload);
      DATA.staff.push(Object.assign({ id: res.id }, payload));
      staffNameInput.value = "";
      staffPositionInput.value = "";
      staffStatusMsg.textContent = "✅ เพิ่มแล้ว";
      refreshSharedSelects();
      renderAdmin();
    } catch (err) {
      staffStatusMsg.textContent = "❌ ไม่สำเร็จ: " + err.message;
    } finally {
      staffAddBtn.disabled = false;
    }
  });

  // ---- edit staff (name/position/department — used when someone moves department) ----
  const editStaffModal = document.getElementById("edit-staff-modal");
  const editStaffNameInput = document.getElementById("edit-staff-name-input");
  const editStaffPositionInput = document.getElementById("edit-staff-position-input");
  const editStaffDeptSelect = document.getElementById("edit-staff-dept-select");
  const editStaffSaveBtn = document.getElementById("edit-staff-save-btn");
  const editStaffCancelBtn = document.getElementById("edit-staff-cancel-btn");
  const editStaffStatus = document.getElementById("edit-staff-status");

  let editStaffId = null;

  function openEditStaffModal(staffMember) {
    editStaffId = staffMember.id;
    editStaffNameInput.value = staffMember.name;
    editStaffPositionInput.value = staffMember.position || "";
    editStaffDeptSelect.value = staffMember.departmentId;
    editStaffStatus.textContent = "";
    editStaffModal.hidden = false;
  }

  function closeEditStaffModal() {
    editStaffModal.hidden = true;
    editStaffId = null;
  }

  editStaffCancelBtn.addEventListener("click", closeEditStaffModal);
  editStaffModal.addEventListener("click", (e) => {
    if (e.target === editStaffModal) closeEditStaffModal();
  });

  editStaffSaveBtn.addEventListener("click", async () => {
    if (!editStaffId) return;
    const name = editStaffNameInput.value.trim();
    if (!name || !editStaffDeptSelect.value) {
      editStaffStatus.textContent = "กรุณากรอกชื่อและเลือกแผนก";
      return;
    }
    editStaffSaveBtn.disabled = true;
    editStaffStatus.textContent = "กำลังบันทึก...";
    try {
      const payload = {
        id: editStaffId,
        name,
        position: editStaffPositionInput.value.trim(),
        departmentId: editStaffDeptSelect.value
      };
      await callApi("updateStaff", payload);
      const idx = DATA.staff.findIndex((s) => s.id === editStaffId);
      if (idx !== -1) DATA.staff[idx] = Object.assign({}, DATA.staff[idx], payload);
      closeEditStaffModal();
      refreshSharedSelects();
      renderAdmin();
    } catch (err) {
      editStaffStatus.textContent = "❌ บันทึกไม่สำเร็จ: " + err.message;
    } finally {
      editStaffSaveBtn.disabled = false;
    }
  });

  function renderAdmin() {
    deptTable.innerHTML = "";
    if (!DATA.departments.length) {
      deptTable.innerHTML = '<div class="sl-empty">📭 ยังไม่มีแผนก</div>';
    } else {
      DATA.departments.forEach((d) => {
        const row = document.createElement("div");
        row.className = "sl-table-row";
        row.innerHTML = '<span class="sl-table-cell">' + escapeHtml(d.name) + '</span>';
        deptTable.appendChild(row);
      });
    }

    roomTable.innerHTML = "";
    if (!DATA.rooms.length) {
      roomTable.innerHTML = '<div class="sl-empty">📭 ยังไม่มีห้อง</div>';
    } else {
      DATA.rooms.forEach((r) => {
        const row = document.createElement("div");
        row.className = "sl-table-row";
        row.innerHTML =
          '<span class="sl-table-cell">' + escapeHtml(r.name) + '</span>' +
          '<span class="sl-table-cell">' + escapeHtml(deptName(r.departmentId)) + '</span>' +
          '<span class="sl-table-cell">' + escapeHtml(r.phone || "") + '</span>';
        roomTable.appendChild(row);
      });
    }

    renderStaffTable();
  }

  function renderStaffTable() {
    const q = staffSearchInput.value.trim();
    const rows = q ? DATA.staff.filter((s) => s.name.indexOf(q) !== -1) : DATA.staff;

    staffTable.innerHTML = "";
    if (!DATA.staff.length) {
      staffTable.innerHTML = '<div class="sl-empty">📭 ยังไม่มีบุคลากร</div>';
    } else if (!rows.length) {
      staffTable.innerHTML = '<div class="sl-empty">🔍 ไม่พบชื่อที่ตรงกัน</div>';
    } else {
      rows.forEach((s) => {
        const row = document.createElement("div");
        row.className = "sl-table-row";
        row.innerHTML =
          '<span class="sl-table-cell" style="color:' + personTextColor(s) + ';font-weight:700;">' + escapeHtml(s.name) + '</span>' +
          '<span class="sl-table-cell">' + escapeHtml(s.position || "") + '</span>' +
          '<span class="sl-table-cell">' + escapeHtml(deptName(s.departmentId)) + '</span>';
        const actions = document.createElement("span");
        actions.className = "sl-table-actions";
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "sl-btn";
        editBtn.textContent = "✏️ แก้ไข";
        editBtn.addEventListener("click", () => openEditStaffModal(s));
        actions.appendChild(editBtn);
        row.appendChild(actions);
        staffTable.appendChild(row);
      });
    }
  }

  function fillDeptSelects() {
    const selects = [roomDeptSelect, staffDeptSelect, editCoveringDeptSelect, leaveCoveringDeptSelect, document.getElementById("report-dept-select"), document.getElementById("edit-staff-dept-select")];
    selects.forEach((sel) => {
      if (!sel) return;
      const keepFirst = sel.id === "report-dept-select";
      const prevValue = sel.value;
      sel.innerHTML = keepFirst ? '<option value="">ทุกแผนก</option>' : "";
      DATA.departments.forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = d.name;
        sel.appendChild(opt);
      });
      if (prevValue) sel.value = prevValue;
    });
  }

  function fillStaffSelects() {
    assignStaffSelect.innerHTML = "";
    const candidates = staffCandidatesForRole(assignRoleSelect.value);
    if (!candidates.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "🔍 ไม่มีบุคลากรตำแหน่งหมอในระบบ";
      assignStaffSelect.appendChild(opt);
    }
    candidates.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name + " (" + deptName(s.departmentId) + ")";
      assignStaffSelect.appendChild(opt);
    });
  }

  function fillRoomSelects() {
    const prevValue = assignRoomSelect.value;
    assignRoomSelect.innerHTML = "";
    DATA.rooms.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name + " (" + deptName(r.departmentId) + ")";
      assignRoomSelect.appendChild(opt);
    });
    if (prevValue) assignRoomSelect.value = prevValue;

    const prevFilter = rotaRoomFilter.value;
    rotaRoomFilter.innerHTML = '<option value="">ทุกห้อง</option>';
    DATA.rooms.forEach((r) => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name + " (" + deptName(r.departmentId) + ")";
      rotaRoomFilter.appendChild(opt);
    });
    rotaRoomFilter.value = prevFilter;
    if (rotaRoomFilter.value !== prevFilter) rotaState.roomFilter = "";
  }

  // ================= DASHBOARD =================
  const dashYearSelect = document.getElementById("dash-year-select");
  const dashPeriodTabs = document.getElementById("dash-period-tabs");
  const dashMonthRow = document.getElementById("dash-month-row");
  const dashMonthSelect = document.getElementById("dash-month-select");
  const dashTrendChart = document.getElementById("dash-trend-chart");
  const dashDeptChart = document.getElementById("dash-dept-chart");
  const dashTotalSummary = document.getElementById("dash-total-summary");
  const dashStaffSearch = document.getElementById("dash-staff-search");
  const dashStaffTable = document.getElementById("dash-staff-table");

  const dashState = { year: 0, period: "month", month: 0 };
  (function initDashState() {
    const now = new Date();
    dashState.year = now.getFullYear();
    dashState.month = now.getMonth() + 1;
  })();

  function renderDashYearSelect() {
    const prevValue = dashYearSelect.value;
    dashYearSelect.innerHTML = "";
    const current = new Date().getFullYear();
    for (let y = current - 3; y <= current + 1; y++) {
      const opt = document.createElement("option");
      opt.value = y;
      opt.textContent = y + 543;
      dashYearSelect.appendChild(opt);
    }
    dashYearSelect.value = prevValue || dashState.year;
  }

  function renderDashMonthSelect() {
    const prevValue = dashMonthSelect.value;
    dashMonthSelect.innerHTML = "";
    THAI_MONTH_NAMES.forEach((name, i) => {
      const opt = document.createElement("option");
      opt.value = i + 1;
      opt.textContent = name;
      dashMonthSelect.appendChild(opt);
    });
    dashMonthSelect.value = prevValue || dashState.month;
  }

  dashYearSelect.addEventListener("change", () => {
    dashState.year = parseInt(dashYearSelect.value, 10);
    renderDashboard();
  });

  dashMonthSelect.addEventListener("change", () => {
    dashState.month = parseInt(dashMonthSelect.value, 10);
    renderDashboard();
  });

  dashPeriodTabs.addEventListener("click", (e) => {
    const btn = e.target.closest(".sl-tab");
    if (!btn) return;
    dashState.period = btn.dataset.period;
    dashPeriodTabs.querySelectorAll(".sl-tab").forEach((t) => t.classList.toggle("active", t === btn));
    dashMonthRow.hidden = dashState.period !== "month";
    renderDashboard();
  });

  let dashStaffSearchDebounce = null;
  dashStaffSearch.addEventListener("input", () => {
    clearTimeout(dashStaffSearchDebounce);
    dashStaffSearchDebounce = setTimeout(renderDashStaffTable, 150);
  });

  function leaveDaysInRange(leave, rangeStart, rangeEnd) {
    const start = leave.startDate > rangeStart ? leave.startDate : rangeStart;
    const end = leave.endDate < rangeEnd ? leave.endDate : rangeEnd;
    if (start > end) return 0;
    const [sy, sm, sd] = start.split("-").map(Number);
    const [ey, em, ed] = end.split("-").map(Number);
    const d1 = new Date(sy, sm - 1, sd);
    const d2 = new Date(ey, em - 1, ed);
    return Math.round((d2 - d1) / 86400000) + 1;
  }

  function dashFocusRange() {
    if (dashState.period === "month") {
      const start = dashState.year + "-" + pad2(dashState.month) + "-01";
      const end = dashState.year + "-" + pad2(dashState.month) + "-" + pad2(daysInMonth(dashState.year, dashState.month));
      return { start, end };
    }
    return { start: dashState.year + "-01-01", end: dashState.year + "-12-31" };
  }

  function renderDashTrendChart() {
    dashTrendChart.innerHTML = "";
    const totals = [];
    for (let m = 1; m <= 12; m++) {
      const start = dashState.year + "-" + pad2(m) + "-01";
      const end = dashState.year + "-" + pad2(m) + "-" + pad2(daysInMonth(dashState.year, m));
      let total = 0;
      DATA.leaves.forEach((l) => { total += leaveDaysInRange(l, start, end); });
      totals.push(total);
    }
    const max = Math.max(1, ...totals);
    totals.forEach((total, i) => {
      const month = i + 1;
      const col = document.createElement("div");
      col.className = "sl-trend-col";
      const isFocused = dashState.period === "month" && month === dashState.month;
      col.innerHTML =
        '<span class="sl-trend-count">' + total + '</span>' +
        '<div class="sl-trend-bar-wrap"><div class="sl-trend-bar' + (isFocused ? " sl-trend-bar-focused" : "") +
        '" style="height:' + Math.max(2, Math.round((total / max) * 100)) + '%"></div></div>' +
        '<span class="sl-trend-label">' + THAI_MONTH_NAMES[i].slice(0, 3) + '</span>';
      dashTrendChart.appendChild(col);
    });
  }

  function renderDashDeptChart() {
    const { start, end } = dashFocusRange();
    dashDeptChart.innerHTML = "";
    const totals = {};
    DATA.leaves.forEach((l) => {
      const days = leaveDaysInRange(l, start, end);
      if (days <= 0) return;
      const sm = byId(DATA.staff, l.staffId);
      const key = sm ? sm.departmentId : "_unknown";
      totals[key] = (totals[key] || 0) + days;
    });
    const rows = DATA.departments
      .map((d) => ({ label: d.name, days: totals[d.id] || 0 }))
      .filter((r) => r.days > 0)
      .sort((a, b) => b.days - a.days);

    if (!rows.length) {
      dashDeptChart.innerHTML = '<div class="sl-empty">📭 ไม่มีข้อมูลการลาในช่วงที่เลือก</div>';
      return;
    }
    const max = Math.max(1, ...rows.map((r) => r.days));
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "sl-hbar-row";
      row.innerHTML =
        '<span class="sl-hbar-label">' + escapeHtml(r.label) + '</span>' +
        '<span class="sl-hbar-track"><span class="sl-hbar-fill" style="width:' + Math.round((r.days / max) * 100) + '%"></span></span>' +
        '<span class="sl-hbar-count">' + r.days + ' วัน</span>';
      dashDeptChart.appendChild(row);
    });
  }

  function renderDashTotalSummary() {
    const { start, end } = dashFocusRange();
    dashTotalSummary.innerHTML = "";
    const typeTotals = {};
    Object.keys(LEAVE_TYPES).forEach((k) => { typeTotals[k] = 0; });
    let grandTotal = 0;
    DATA.leaves.forEach((l) => {
      const days = leaveDaysInRange(l, start, end);
      if (days <= 0) return;
      typeTotals[l.type] = (typeTotals[l.type] || 0) + days;
      grandTotal += days;
    });

    const totalStat = document.createElement("div");
    totalStat.className = "sl-dash-stat sl-dash-total";
    totalStat.innerHTML = '<span class="sl-dash-num">' + grandTotal + '</span><span class="sl-dash-label">รวมวัน-คนลาทั้งหมด</span>';
    dashTotalSummary.appendChild(totalStat);

    Object.keys(LEAVE_TYPES).forEach((key) => {
      const stat = document.createElement("div");
      stat.className = "sl-dash-stat";
      stat.innerHTML = '<span class="sl-dash-num">' + typeTotals[key] + '</span><span class="sl-dash-label">' + LEAVE_TYPES[key] + "</span>";
      dashTotalSummary.appendChild(stat);
    });
  }

  function renderDashStaffTable() {
    const { start, end } = dashFocusRange();
    const totals = {};
    DATA.leaves.forEach((l) => {
      const days = leaveDaysInRange(l, start, end);
      if (days <= 0) return;
      totals[l.staffId] = (totals[l.staffId] || 0) + days;
    });

    const q = dashStaffSearch.value.trim();
    let rows = DATA.staff
      .map((s) => ({ staff: s, days: totals[s.id] || 0 }))
      .filter((r) => r.days > 0);
    if (q) rows = rows.filter((r) => r.staff.name.indexOf(q) !== -1);
    rows.sort((a, b) => b.days - a.days);

    dashStaffTable.innerHTML = "";
    if (!rows.length) {
      dashStaffTable.innerHTML = '<div class="sl-empty">📭 ไม่มีข้อมูลการลาในช่วงที่เลือก</div>';
      return;
    }
    const head = document.createElement("div");
    head.className = "sl-table-row sl-table-head";
    head.innerHTML = '<span class="sl-table-cell">ชื่อ</span><span class="sl-table-cell">แผนก</span><span class="sl-table-cell">วันลารวม</span>';
    dashStaffTable.appendChild(head);
    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "sl-table-row";
      row.innerHTML =
        '<span class="sl-table-cell" style="color:' + personTextColor(r.staff) + ';font-weight:700;">' + escapeHtml(r.staff.name) + '</span>' +
        '<span class="sl-table-cell">' + escapeHtml(deptName(r.staff.departmentId)) + '</span>' +
        '<span class="sl-table-cell">' + r.days + ' วัน</span>';
      dashStaffTable.appendChild(row);
    });
  }

  function renderDashboard() {
    renderDashYearSelect();
    renderDashMonthSelect();
    dashMonthRow.hidden = dashState.period !== "month";
    renderDashTrendChart();
    renderDashDeptChart();
    renderDashTotalSummary();
    renderDashStaffTable();
  }

  // ================= REPORT / CSV =================
  const reportStartDate = document.getElementById("report-start-date");
  const reportEndDate = document.getElementById("report-end-date");
  const reportDeptSelect = document.getElementById("report-dept-select");
  const reportRunBtn = document.getElementById("report-run-btn");
  const reportExportBtn = document.getElementById("report-export-btn");
  const reportStatusMsg = document.getElementById("report-status-msg");
  const reportTable = document.getElementById("report-table");

  reportStartDate.value = todayStr();
  reportEndDate.value = todayStr();

  function reportRows() {
    const start = reportStartDate.value || "0000-01-01";
    const end = reportEndDate.value || "9999-12-31";
    const deptFilter = reportDeptSelect.value;
    return DATA.leaves.filter((l) => {
      if (l.endDate < start || l.startDate > end) return false;
      const sm = byId(DATA.staff, l.staffId);
      if (deptFilter && (!sm || String(sm.departmentId) !== String(deptFilter))) return false;
      return true;
    });
  }

  function renderReport() {
    const rows = reportRows();
    reportTable.innerHTML = "";
    if (!rows.length) {
      reportTable.innerHTML = '<div class="sl-empty">📭 ไม่มีข้อมูลในช่วงที่เลือก</div>';
      return;
    }
    const head = document.createElement("div");
    head.className = "sl-table-row sl-table-head";
    head.innerHTML =
      '<span class="sl-table-cell">ชื่อ</span><span class="sl-table-cell">แผนก</span>' +
      '<span class="sl-table-cell">ช่วงวันที่</span><span class="sl-table-cell">ประเภท</span><span class="sl-table-cell">หมายเหตุ</span>';
    reportTable.appendChild(head);
    rows.forEach((l) => {
      const sm = byId(DATA.staff, l.staffId);
      const row = document.createElement("div");
      row.className = "sl-table-row";
      row.innerHTML =
        '<span class="sl-table-cell" style="color:' + personTextColor(sm) + ';font-weight:700;">' + escapeHtml(sm ? sm.name : "") + '</span>' +
        '<span class="sl-table-cell">' + escapeHtml(sm ? deptName(sm.departmentId) : "") + '</span>' +
        '<span class="sl-table-cell">' + formatThaiDateRange(l.startDate, l.endDate) + '</span>' +
        '<span class="sl-table-cell">' + (LEAVE_TYPES[l.type] || l.type) + '</span>' +
        '<span class="sl-table-cell">' + escapeHtml(l.note || "") + '</span>';
      reportTable.appendChild(row);
    });
  }

  reportRunBtn.addEventListener("click", renderReport);

  function csvEscape(v) {
    const s = String(v == null ? "" : v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  reportExportBtn.addEventListener("click", () => {
    const rows = reportRows();
    if (!rows.length) {
      reportStatusMsg.textContent = "ไม่มีข้อมูลให้ส่งออกในช่วงที่เลือก";
      return;
    }
    const header = ["วันที่เริ่ม", "วันที่สิ้นสุด", "ชื่อ", "แผนก", "ตำแหน่ง", "ประเภทการลา", "แผนกที่ไปช่วย", "หมายเหตุ"];
    const lines = [header.map(csvEscape).join(",")];
    rows.forEach((l) => {
      const sm = byId(DATA.staff, l.staffId);
      lines.push([
        l.startDate,
        l.endDate,
        sm ? sm.name : "",
        sm ? deptName(sm.departmentId) : "",
        sm ? sm.position || "" : "",
        LEAVE_TYPES[l.type] || l.type,
        l.type === "covering" ? deptName(l.coveringDepartmentId) : "",
        l.note || ""
      ].map(csvEscape).join(","));
    });
    const csvContent = "﻿" + lines.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "staff-leave-report_" + reportStartDate.value + "_to_" + reportEndDate.value + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    reportStatusMsg.textContent = "✅ ดาวน์โหลดแล้ว (" + rows.length + " รายการ)";
  });

  initDateOverlays();

  // ================= INIT =================
  if (EDIT_ENABLED && !accessKey) {
    showAccessGate("");
  } else {
    loadData().then(() => {
      if (accessGate.hidden) {
        renderEverything();
        goToView("overview");
      }
    });
  }
})();
