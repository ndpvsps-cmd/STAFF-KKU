/**
 * Staff Leave & Room Rota — Google Apps Script backend
 *
 * SETUP (one time):
 *   1. Go to https://sheets.google.com and create a new blank spreadsheet
 *      (e.g. name it "Staff Leave DB").
 *   2. In that spreadsheet, create 5 sheet tabs with these exact names and
 *      header rows (row 1). Everything after row 1 is data the script
 *      manages — you normally won't type into these tabs by hand.
 *
 *        Departments : id | name | order
 *        Rooms       : id | departmentId | name | phone
 *        Staff       : id | name | position | departmentId | active
 *        Assignments : id | roomId | staffId | role | startDate | endDate | note | createdBy | createdAt
 *        Leaves      : id | staffId | startDate | endDate | type | note | coveringDepartmentId | createdBy | createdAt | updatedAt
 *
 *   3. In the spreadsheet, open Extensions > Apps Script. Delete any
 *      placeholder code and paste this entire file in.
 *   4. Click Deploy > New deployment > select type "Web app".
 *        - Execute as: Me
 *        - Who has access: Anyone (or "Anyone with the link" — the app has
 *          no login, matching the rest of this site's tools)
 *   5. Click Deploy, authorize the requested permissions, then copy the
 *      "Web app URL" it gives you.
 *   6. Paste that URL into APPS_SCRIPT_URL in staff-leave-config.js.
 *   7. Whenever you edit this script, use Deploy > Manage deployments >
 *      edit (pencil) > New version > Deploy, so the URL picks up changes.
 *
 * ACCESS KEY (required if the site is publicly reachable, e.g. GitHub Pages)
 *   The app's source code (including the deployed URL) is public, so anyone
 *   who finds the URL could otherwise read or edit every staff/leave record.
 *   To gate that: in the Apps Script editor, click the gear-shaped
 *   "Project Settings" icon > scroll to "Script properties" > Add script
 *   property with name ACCESS_KEY and a value you make up (a shared
 *   passphrase for your staff). This value is NOT stored anywhere in the
 *   git repo — only here, inside your own Apps Script project — so it
 *   never appears in the public source. Staff enter this same passphrase
 *   once in the web app (it's then remembered on their device).
 *   While ACCESS_KEY is unset, every request is rejected (fail-closed) —
 *   set it before sharing the link with anyone.
 *
 * DATA SHAPE
 *   doGet()  -> { ok:true, departments:[], rooms:[], staff:[], assignments:[], leaves:[] }
 *   doPost() -> body is JSON: { action: "<name>", payload: {...}, key: "<access key>" }
 *               returns { ok:true, id } or { ok:false, error, authError? }
 *
 *   Supported actions: addDepartment, addRoom, addStaff, updateStaff,
 *   addAssignment, updateAssignment, deleteAssignment,
 *   addLeave, updateLeave, deleteLeave.
 *
 *   Dates are plain "YYYY-MM-DD" strings throughout (compared as strings,
 *   which sorts correctly for ISO dates).
 */

var SHEETS = {
  departments: { name: "Departments", cols: ["id", "name", "order"] },
  rooms: { name: "Rooms", cols: ["id", "departmentId", "name", "phone"] },
  staff: { name: "Staff", cols: ["id", "name", "position", "departmentId", "active"] },
  assignments: {
    name: "Assignments",
    cols: ["id", "roomId", "staffId", "role", "startDate", "endDate", "note", "createdBy", "createdAt"]
  },
  leaves: {
    name: "Leaves",
    cols: [
      "id", "staffId", "startDate", "endDate", "type", "note",
      "coveringDepartmentId", "createdBy", "createdAt", "updatedAt"
    ]
  }
};

function getSheet_(key) {
  var def = SHEETS[key];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(def.name);
  if (!sheet) {
    sheet = ss.insertSheet(def.name);
    sheet.appendRow(def.cols);
  }
  return sheet;
}

function sheetToObjects_(key) {
  var def = SHEETS[key];
  var sheet = getSheet_(key);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0];
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row[0]) continue; // skip blank id rows
    var obj = {};
    for (var c = 0; c < header.length; c++) {
      obj[header[c]] = row[c];
    }
    out.push(obj);
  }
  return out;
}

function appendRecord_(key, record) {
  var def = SHEETS[key];
  var sheet = getSheet_(key);
  var row = def.cols.map(function (c) {
    return Object.prototype.hasOwnProperty.call(record, c) ? record[c] : "";
  });
  sheet.appendRow(row);
}

function findRowById_(sheet, id) {
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(id)) return r + 1; // 1-indexed sheet row
  }
  return -1;
}

function updateRecord_(key, id, patch) {
  var def = SHEETS[key];
  var sheet = getSheet_(key);
  var rowIndex = findRowById_(sheet, id);
  if (rowIndex === -1) throw new Error("ไม่พบรายการ id=" + id + " ใน " + def.name);
  var header = def.cols;
  var current = sheet.getRange(rowIndex, 1, 1, header.length).getValues()[0];
  var updated = header.map(function (c, i) {
    return Object.prototype.hasOwnProperty.call(patch, c) ? patch[c] : current[i];
  });
  sheet.getRange(rowIndex, 1, 1, header.length).setValues([updated]);
}

function deleteRecord_(key, id) {
  var def = SHEETS[key];
  var sheet = getSheet_(key);
  var rowIndex = findRowById_(sheet, id);
  if (rowIndex === -1) throw new Error("ไม่พบรายการ id=" + id + " ใน " + def.name);
  sheet.deleteRow(rowIndex);
}

function newId_() {
  return Utilities.getUuid();
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkAccessKey_(provided) {
  var expected = PropertiesService.getScriptProperties().getProperty("ACCESS_KEY");
  if (!expected || provided !== expected) {
    return { ok: false, authError: true, error: "รหัสผ่านไม่ถูกต้อง หรือยังไม่ได้ตั้งค่า ACCESS_KEY (ดูวิธีตั้งค่าในคอมเมนต์ด้านบนไฟล์นี้)" };
  }
  return null;
}

function doGet(e) {
  var authErr = checkAccessKey_(e.parameter.key || "");
  if (authErr) return jsonOut_(authErr);

  var out = {
    ok: true,
    departments: sheetToObjects_("departments"),
    rooms: sheetToObjects_("rooms"),
    staff: sheetToObjects_("staff"),
    assignments: sheetToObjects_("assignments"),
    leaves: sheetToObjects_("leaves")
  };
  return jsonOut_(out);
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ ok: false, error: "คำขอไม่ถูกต้อง" });
  }

  var authErr = checkAccessKey_(body.key || "");
  if (authErr) return jsonOut_(authErr);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var action = body.action;
    var payload = body.payload || {};
    var result = handleAction_(action, payload);
    return jsonOut_({ ok: true, id: result });
  } catch (err) {
    return jsonOut_({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

function handleAction_(action, payload) {
  var now = new Date().toISOString();

  switch (action) {
    case "addDepartment": {
      var depts = sheetToObjects_("departments");
      var id = newId_();
      appendRecord_("departments", {
        id: id,
        name: payload.name,
        order: payload.order != null ? payload.order : depts.length
      });
      return id;
    }

    case "addRoom": {
      var id = newId_();
      appendRecord_("rooms", {
        id: id,
        departmentId: payload.departmentId,
        name: payload.name,
        phone: payload.phone || ""
      });
      return id;
    }

    case "addStaff": {
      var id = newId_();
      appendRecord_("staff", {
        id: id,
        name: payload.name,
        position: payload.position || "",
        departmentId: payload.departmentId,
        active: payload.active !== false
      });
      return id;
    }

    case "updateStaff": {
      updateRecord_("staff", payload.id, payload);
      return payload.id;
    }

    case "addAssignment": {
      var id = newId_();
      appendRecord_("assignments", {
        id: id,
        roomId: payload.roomId,
        staffId: payload.staffId,
        role: payload.role,
        startDate: payload.startDate,
        endDate: payload.endDate,
        note: payload.note || "",
        createdBy: payload.createdBy || "",
        createdAt: now
      });
      return id;
    }

    case "updateAssignment": {
      updateRecord_("assignments", payload.id, payload);
      return payload.id;
    }

    case "deleteAssignment": {
      deleteRecord_("assignments", payload.id);
      return payload.id;
    }

    case "addLeave": {
      var id = newId_();
      appendRecord_("leaves", {
        id: id,
        staffId: payload.staffId,
        startDate: payload.startDate,
        endDate: payload.endDate,
        type: payload.type,
        note: payload.note || "",
        coveringDepartmentId: payload.coveringDepartmentId || "",
        createdBy: payload.createdBy || "",
        createdAt: now,
        updatedAt: now
      });
      return id;
    }

    case "updateLeave": {
      var patch = {};
      for (var k in payload) patch[k] = payload[k];
      patch.updatedAt = now;
      updateRecord_("leaves", payload.id, patch);
      return payload.id;
    }

    case "deleteLeave": {
      deleteRecord_("leaves", payload.id);
      return payload.id;
    }

    default:
      throw new Error("ไม่รู้จัก action: " + action);
  }
}
