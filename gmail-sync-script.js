/**
 * =============================================================================
 * CEC UNINORTE - SINCRONIZADOR AUTOMÁTICO DE GMAIL + GOOGLE DRIVE (IA + FIREBASE)
 * =============================================================================
 * 
 * Este script corre de forma automática y gratuita 24/7 en Google Apps Script
 * dentro de tu cuenta de Google Workspace / Gmail.
 * 
 * FUNCIONALIDADES:
 * 1. GMAIL: Detecta correos de "Apertura de curso" en tiempo real sin duplicados
 *    y los envía a Firebase para aprobación.
 * 2. GOOGLE DRIVE: Crea automáticamente la jerarquía de carpetas:
 *    Cursos CEC / [Mes] / [Nombre del Curso] - NRC [NRC] /
 *    y genera la planilla de cálculo de asistencia estructurada por sesiones.
 * 
 * PASOS PARA INSTALARLO EN 1 MINUTO:
 * 1. Ve a https://script.google.com/
 * 2. Abre tu proyecto (o crea uno nuevo llamado "CEC-Sincronizador").
 * 3. Pega este código completo reemplazando todo y haz clic en Guardar (ícono de disco).
 * 4. Implementa el Webhook:
 *    - Haz clic en "Implementar" (arriba a la derecha) -> "Nueva implementación"
 *    - Tipo: "Aplicación web"
 *    - Ejecutar como: "Yo" (tu cuenta)
 *    - Quién tiene acceso: "Cualquiera"
 *    - Haz clic en "Implementar", copia la URL que termina en /exec y pégala en la web del CEC.
 * 5. (Opcional) Limpia activadores viejos ejecutando la función 'eliminarActivadoresMinuterosViejos'.
 *    Tu Tablero Web sincronizará automáticamente los correos por Webhook al entrar o con un clic.
 */

// CONFIGURACIÓN DE TU PROYECTO FIREBASE
const FIREBASE_DB_URL = "https://cec-web-ff198-default-rtdb.firebaseio.com";

// (Opcional pero recomendado para máxima precisión con IA libre)
// Obtén una clave gratis en: https://aistudio.google.com/app/apikey
const GEMINI_API_KEY = ""; // Deja vacío si no tienes, usará el extractor inteligente integrado

/**
 * 1. FUNCIÓN PRINCIPAL DE GMAIL + PROCESAMIENTO DE COLA DRIVE
 */
function revisarCorreosAperturaCurso() {
  // A. Procesar cola de creación de carpetas y asistencias de Google Drive
  try {
    procesarColaDrive();
  } catch (errDrive) {
    Logger.log("Nota procesando cola Drive: " + errDrive.message);
  }

  // B. Procesar cola de eliminación en Google Drive (papelera para cursos borrados)
  try {
    procesarColaEliminacionDrive();
  } catch (errDel) {
    Logger.log("Nota procesando cola eliminación Drive: " + errDel.message);
  }

  // C. Buscar correos no leídos por palabras clave (apertura, solicitud de apertura o diplomado, excluyendo boletines y spam)
  const query = 'is:unread (subject:apertura OR "solicitud de apertura" OR (subject:diplomado (apertura OR nrc OR horario OR inicio OR fecha OR salon))) -quora -zoom -digest -newsletter -marketing -label:CEC-Procesado';
  const threads = GmailApp.search(query, 0, 15);

  Logger.log("Búsqueda con query: " + query);
  Logger.log("Hilos encontrados: " + (threads ? threads.length : 0));

  if (!threads || threads.length === 0) {
    Logger.log("No se encontraron correos nuevos sin procesar.");
    return;
  }

  let labelProcesado = null;
  try {
    labelProcesado = GmailApp.getUserLabelByName("CEC-Procesado") || GmailApp.createLabel("CEC-Procesado");
  } catch (e) {
    Logger.log("Nota sobre etiqueta: " + e.message);
  }

  for (let t = 0; t < threads.length; t++) {
    const thread = threads[t];
    const messages = thread.getMessages();
    if (!messages || messages.length === 0) continue;

    const unreadMessages = messages.filter(function (m) { return m.isUnread(); });
    if (unreadMessages.length === 0) {
      if (labelProcesado) thread.addLabel(labelProcesado);
      continue;
    }

    for (let m = 0; m < unreadMessages.length; m++) {
      const msg = unreadMessages[m];
      const msgId = msg.getId(); // ID inmutable de Gmail (garantiza cero duplicados)
      const threadId = thread.getId();
      const subject = msg.getSubject() || "";
      const from = msg.getFrom() || "";
      const date = msg.getDate();
      const plainBody = msg.getPlainBody() || "";

      // Filtro anti-falsos positivos (descarta Quora, Zoom, newsletters o correos sin datos de curso)
      if (!esCorreoAperturaValido(subject, plainBody, from)) {
        if (labelProcesado) thread.addLabel(labelProcesado);
        continue;
      }

      Logger.log("✓ Correo válido detectado ID: " + msgId + " | Asunto: " + subject);

      let datosExtraidos = null;
      if (GEMINI_API_KEY && GEMINI_API_KEY.trim().length > 10) {
        datosExtraidos = extraerConGeminiAI(subject, plainBody);
      }
      if (!datosExtraidos) {
        datosExtraidos = extraerHeuristico(subject, plainBody);
      }

      const requestId = "gmail_" + msgId;
      const payload = {
        id: requestId,
        message_id: msgId,
        thread_id: threadId,
        remitente: from,
        asunto: subject,
        fecha_correo: date ? date.toISOString() : new Date().toISOString(),
        fecha_deteccion: new Date().toISOString(),
        cuerpo_resumen: plainBody.substring(0, 800),
        cuerpo_completo: plainBody.substring(0, 4000),
        datos_extraidos: datosExtraidos,
        estado: "pendiente"
      };

      const url = FIREBASE_DB_URL + "/solicitudes_pendientes/" + requestId + ".json";
      try {
        UrlFetchApp.fetch(url, {
          method: "put",
          contentType: "application/json",
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        msg.markRead();
      } catch (err) {
        Logger.log("Error al guardar en Firebase: " + err.message);
      }
    }

    try {
      thread.markRead();
      if (labelProcesado) thread.addLabel(labelProcesado);
    } catch (e) {
      Logger.log("Error etiquetando hilo: " + e.message);
    }
  }
}

/**
 * 2. PROCESADOR DE LA COLA DE GOOGLE DRIVE EN FIREBASE
 * Guarda inmediatamente cada curso procesado en Firebase para no perder progreso ante timeouts.
 */
function procesarColaDrive() {
  const url = FIREBASE_DB_URL + "/cola_creacion_drive.json";
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return;

  const text = res.getContentText();
  if (!text || text === "null") return;

  const cola = JSON.parse(text);
  if (!cola || typeof cola !== "object") return;

  const colaKeys = Object.keys(cola);
  Logger.log("Elementos en cola de creación Drive: " + colaKeys.length);

  // Procesamos hasta 25 por turno para mantener un tiempo de respuesta óptimo en Apps Script
  const maxToProcess = Math.min(colaKeys.length, 25);

  for (let i = 0; i < maxToProcess; i++) {
    const k = colaKeys[i];
    const item = cola[k];
    if (!item) continue;

    try {
      const mesKey = item.mesKey || getMesKeyDrive(item.mes || item.origen_mes || "General");
      const nodeKey = item.nodeKey || item.id || sanitizeFirebaseKeyGas(item.programa || item.nombre || "prog");

      // VERIFICACIÓN: Comprobar si el programa aún existe en Firebase
      // Si la BD fue vaciada o el curso eliminado, NO lo recreamos
      const checkRes = UrlFetchApp.fetch(FIREBASE_DB_URL + "/meses/" + mesKey + "/programas/" + nodeKey + ".json", { muteHttpExceptions: true });
      if (checkRes.getResponseCode() !== 200 || !checkRes.getContentText() || checkRes.getContentText() === "null") {
        Logger.log("El programa ya fue eliminado de la BD, omitiendo recreación: " + nodeKey);
        UrlFetchApp.fetch(FIREBASE_DB_URL + "/cola_creacion_drive/" + k + ".json", { method: "delete", muteHttpExceptions: true });
        continue;
      }

      const resDrive = crearEstructuraDriveYAsistencia(item);

      const itemUpdates = {};
      itemUpdates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_folder_url"] = resDrive.folderUrl;
      itemUpdates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_folder_id"] = resDrive.folderId;
      itemUpdates["meses/" + mesKey + "/programas/" + nodeKey + "/asistencia_sheet_url"] = resDrive.sheetUrl;
      itemUpdates["meses/" + mesKey + "/programas/" + nodeKey + "/asistencia_sheet_id"] = resDrive.sheetId;
      itemUpdates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_creado_el"] = new Date().toISOString();
      itemUpdates["cola_creacion_drive/" + k] = null; // Quitar de cola inmediatamente

      UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
        method: "patch",
        contentType: "application/json",
        payload: JSON.stringify(itemUpdates),
        muteHttpExceptions: true
      });

      Logger.log("✓ (" + (i + 1) + "/" + maxToProcess + ") Creado en Drive: " + (item.programa || item.nombre));
    } catch (e) {
      Logger.log("Error creando Drive para elemento " + k + ": " + e.message);
    }
  }
}

/**
 * 2.1 PROCESADOR DE LA COLA DE ELIMINACIÓN DE GOOGLE DRIVE EN FIREBASE
 * Envía a la papelera de Drive las carpetas y planillas de cursos borrados de la web.
 */
function procesarColaEliminacionDrive() {
  const url = FIREBASE_DB_URL + "/cola_eliminacion_drive.json";
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return;

  const text = res.getContentText();
  if (!text || text === "null") return;

  const cola = JSON.parse(text);
  if (!cola || typeof cola !== "object") return;

  const colaKeys = Object.keys(cola);
  Logger.log("Elementos en cola de eliminación Drive: " + colaKeys.length);

  for (let i = 0; i < colaKeys.length; i++) {
    const k = colaKeys[i];
    const item = cola[k];
    if (!item) continue;

    try {
      if (item.action === "vaciar_todo") {
        eliminarTodasLasCarpetasCursosDrive();
      } else if (item.folderId) {
        try {
          const folder = DriveApp.getFolderById(item.folderId);
          folder.setTrashed(true);
          Logger.log("✓ Carpeta enviada a papelera de Drive por ID: " + item.folderId);
        } catch (errId) {
          eliminarCarpetaCursoPorNombre(item.mes, item.nombre, item.nrc);
        }
      } else if (item.nombre) {
        eliminarCarpetaCursoPorNombre(item.mes, item.nombre, item.nrc);
      }

      // Eliminar de la cola de eliminación
      UrlFetchApp.fetch(FIREBASE_DB_URL + "/cola_eliminacion_drive/" + k + ".json", {
        method: "delete",
        muteHttpExceptions: true
      });
    } catch (e) {
      Logger.log("Error eliminando carpeta en Drive para " + k + ": " + e.message);
    }
  }
}

function eliminarCarpetaCursoPorNombre(mes, nombreCurso, nrc) {
  try {
    const rootIter = DriveApp.getFoldersByName("Cursos CEC");
    if (!rootIter.hasNext()) return;
    const rootFolder = rootIter.next();

    const cleanCurso = (nombreCurso + (nrc ? (" - NRC " + nrc) : "")).replace(/[\\/:*?"<>|]/g, "_").substring(0, 100);
    const mesFolderName = getMesKeyDrive(mes || "");
    const mesIter = rootFolder.getFoldersByName(mesFolderName);
    const parentFolder = mesIter.hasNext() ? mesIter.next() : rootFolder;

    const subIter = parentFolder.getFoldersByName(cleanCurso);
    while (subIter.hasNext()) {
      const f = subIter.next();
      f.setTrashed(true);
      Logger.log("✓ Carpeta enviada a papelera por nombre: " + cleanCurso);
    }
  } catch (err) {
    Logger.log("Nota buscando carpeta para eliminar: " + err.message);
  }
}

function eliminarTodasLasCarpetasCursosDrive() {
  try {
    const rootIter = DriveApp.getFoldersByName("Cursos CEC");
    if (!rootIter.hasNext()) return;
    const rootFolder = rootIter.next();
    const subFolders = rootFolder.getFolders();
    while (subFolders.hasNext()) {
      const sf = subFolders.next();
      sf.setTrashed(true);
      Logger.log("✓ Carpeta de mes enviada a papelera de Drive: " + sf.getName());
    }
  } catch (err) {
    Logger.log("Nota vaciando carpetas en Drive: " + err.message);
  }
}

/**
 * 2.2 SINCRONIZADOR MASIVO DIRECTO DE TODOS LOS CURSOS DE FIREBASE A GOOGLE DRIVE
 * Selecciona esta función arriba y haz clic en "Ejecutar" para montar absolutamente todos
 * los cursos que aún no tienen carpeta o planilla en Google Drive.
 */
function sincronizarTodosLosCursosADrive() {
  Logger.log("Iniciando sincronización masiva de todos los cursos a Google Drive...");
  const res = UrlFetchApp.fetch(FIREBASE_DB_URL + "/meses.json", { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    Logger.log("Error al leer /meses.json de Firebase");
    return;
  }

  const mesesData = JSON.parse(res.getContentText());
  if (!mesesData) {
    Logger.log("No se encontraron datos en meses.");
    return;
  }

  let totalProcesados = 0;
  let yaSincronizados = 0;

  const mesKeys = Object.keys(mesesData);
  for (let m = 0; m < mesKeys.length; m++) {
    const mesKey = mesKeys[m];
    const mesObj = mesesData[mesKey];
    if (!mesObj || !mesObj.programas) continue;

    const progKeys = Object.keys(mesObj.programas);
    for (let p = 0; p < progKeys.length; p++) {
      const progKey = progKeys[p];
      const prog = mesObj.programas[progKey];
      if (!prog) continue;

      if (prog.drive_folder_url && prog.asistencia_sheet_url) {
        yaSincronizados++;
        continue;
      }

      try {
        Logger.log("Sincronizando a Drive: " + (prog.programa || prog.nombre_del_programa || progKey));
        const resDrive = crearEstructuraDriveYAsistencia({
          ...prog,
          mesKey: mesKey,
          nodeKey: progKey
        });

        const updates = {};
        updates["meses/" + mesKey + "/programas/" + progKey + "/drive_folder_url"] = resDrive.folderUrl;
        updates["meses/" + mesKey + "/programas/" + progKey + "/drive_folder_id"] = resDrive.folderId;
        updates["meses/" + mesKey + "/programas/" + progKey + "/asistencia_sheet_url"] = resDrive.sheetUrl;
        updates["meses/" + mesKey + "/programas/" + progKey + "/asistencia_sheet_id"] = resDrive.sheetId;
        updates["meses/" + mesKey + "/programas/" + progKey + "/drive_creado_el"] = new Date().toISOString();

        UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
          method: "patch",
          contentType: "application/json",
          payload: JSON.stringify(updates),
          muteHttpExceptions: true
        });

        totalProcesados++;
        Logger.log("✓ Sincronizado (" + totalProcesados + "): " + (prog.programa || progKey));
      } catch (err) {
        Logger.log("Error sincronizando " + progKey + ": " + err.message);
      }
    }
  }

  Logger.log("FIN DE SINCRONIZACIÓN: " + totalProcesados + " cursos montados a Google Drive. (" + yaSincronizados + " ya estaban sincronizados).");
}

/**
 * 3. MOTOR DE CREACIÓN DE CARPETAS Y PLANILLA DE ASISTENCIA EN GOOGLE DRIVE
 */
function crearEstructuraDriveYAsistencia(prog) {
  if (!prog) throw new Error("Datos de programa no proporcionados");

  const ROOT_FOLDER_NAME = "Cursos CEC";
  const nombreCurso = (prog.programa || prog.nombre_del_programa || prog.nombre || "Curso Sin Nombre").trim();
  const nrc = (prog.nrc || "").toString().trim();
  const mes = (prog.mes || prog.origen_mes || "General").trim();
  const coordinadora = (prog.coordinadora || prog.nombre_contacto || prog.nombre || "Por asignar").trim();
  const celular = (prog.celular || "").toString().trim();
  const modalidad = (prog.modalidad || "Presencial").trim();
  const horario = (prog.horario || "").trim();
  const salon = (prog.salones_1_val || (prog.salones && prog.salones[0] && prog.salones[0].valor) || "").trim();
  const fechaInicio = prog.fecha_inicio || prog.fechaInicio || "";
  const fechaFin = prog.fecha_fin || prog.fechaFin || "";
  const fechasSesion = (prog.analisis_horario && prog.analisis_horario.fechas_sesion) || prog.fechas_sesion || [];

  // 1. Obtener o crear carpeta raíz "Cursos CEC"
  let rootFolder = null;
  const rootIter = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  if (rootIter.hasNext()) {
    rootFolder = rootIter.next();
  } else {
    rootFolder = DriveApp.createFolder(ROOT_FOLDER_NAME);
  }

  // 2. Obtener o crear subcarpeta del mes (ej: "05_Mayo")
  const MESES_MAP = {
    "enero": "01_Enero", "febrero": "02_Febrero", "marzo": "03_Marzo", "abril": "04_Abril",
    "mayo": "05_Mayo", "junio": "06_Junio", "julio": "07_Julio", "agosto": "08_Agosto",
    "septiembre": "09_Septiembre", "setiembre": "09_Septiembre", "octubre": "10_Octubre",
    "noviembre": "11_Noviembre", "diciembre": "12_Diciembre"
  };
  const mesKeyNorm = mes.toLowerCase().replace(/^[0-9]+_/, "");
  let mesFolderName = MESES_MAP[mesKeyNorm] || (mes.includes("_") ? mes : ("Mes_" + mes));

  let mesFolder = null;
  const mesIter = rootFolder.getFoldersByName(mesFolderName);
  if (mesIter.hasNext()) {
    mesFolder = mesIter.next();
  } else {
    mesFolder = rootFolder.createFolder(mesFolderName);
  }

  // 3. Obtener o crear subcarpeta del curso: "[Nombre] - NRC [NRC]"
  const cleanCursoFolder = (nombreCurso + (nrc ? (" - NRC " + nrc) : "")).replace(/[\\/:*?"<>|]/g, "_").substring(0, 100);
  let cursoFolder = null;
  const cursoIter = mesFolder.getFoldersByName(cleanCursoFolder);
  if (cursoIter.hasNext()) {
    cursoFolder = cursoIter.next();
  } else {
    cursoFolder = mesFolder.createFolder(cleanCursoFolder);
  }

  // 4. Crear o buscar archivo de asistencia (Google Sheet)
  const sheetFileName = "Asistencia - " + nombreCurso + (nrc ? (" (NRC " + nrc + ")") : "");
  let spreadsheet = null;

  const fileIter = cursoFolder.getFilesByName(sheetFileName);
  if (fileIter.hasNext()) {
    const existingFile = fileIter.next();
    spreadsheet = SpreadsheetApp.open(existingFile);
  } else {
    spreadsheet = SpreadsheetApp.create(sheetFileName);
    const sheetFile = DriveApp.getFileById(spreadsheet.getId());
    sheetFile.moveTo(cursoFolder);

    // Formatear y diseñar la planilla de asistencia con estilo institucional CEC
    disenarPlanillaAsistencia(spreadsheet, {
      nombreCurso: nombreCurso,
      nrc: nrc,
      mes: mes,
      coordinadora: coordinadora,
      celular: celular,
      modalidad: modalidad,
      horario: horario,
      salon: salon,
      fechaInicio: fechaInicio,
      fechaFin: fechaFin,
      fechasSesion: fechasSesion
    });
  }

  try {
    const sheet = spreadsheet.getSheetByName("Control Asistencia") || spreadsheet.getActiveSheet();
    const mesKey = prog.mesKey || prog._mesKey || getMesKeyDrive(mes);
    const nodeKey = prog.nodeKey || prog._nodeKey || prog.id || sanitizeFirebaseKeyGas(nombreCurso);
    sheet.getRange("Z1").setValue(JSON.stringify({ mesKey: mesKey, nodeKey: nodeKey, sheetId: spreadsheet.getId() }));
    sheet.hideColumns(26);
    asegurarActivadorDeEdicion(spreadsheet);
  } catch (eTrig) {
    Logger.log("Nota vinculando activador de edición al crear: " + eTrig.message);
  }

  return {
    success: true,
    folderId: cursoFolder.getId(),
    folderUrl: cursoFolder.getUrl(),
    sheetId: spreadsheet.getId(),
    sheetUrl: spreadsheet.getUrl()
  };
}

/**
 * 4. DISEÑO PROFESIONAL DE LA PLANILLA DE ASISTENCIA
 */
function disenarPlanillaAsistencia(spreadsheet, data) {
  const sheet = spreadsheet.getActiveSheet();
  sheet.setName("Control Asistencia");
  sheet.clear();

  // 1. Títulos institucionales
  sheet.getRange("A1:M1").merge()
    .setValue("UNIVERSIDAD DEL NORTE — CENTRO DE EDUCACIÓN CONTINUADA (CEC)")
    .setFontFamily("Arial").setFontSize(13).setFontWeight("bold")
    .setBackground("#0f172a").setFontColor("#ffffff")
    .setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.setRowHeight(1, 36);

  sheet.getRange("A2:M2").merge()
    .setValue("CONTROL Y REGISTRO OFICIAL DE ASISTENCIA")
    .setFontFamily("Arial").setFontSize(10).setFontWeight("bold")
    .setBackground("#1e293b").setFontColor("#93c5fd")
    .setHorizontalAlignment("center").setVerticalAlignment("middle");
  sheet.setRowHeight(2, 24);

  // 2. Ficha técnica del curso
  sheet.getRange("A4:B4").merge().setValue("PROGRAMA:").setFontWeight("bold");
  sheet.getRange("C4:G4").merge().setValue(data.nombreCurso).setFontWeight("bold").setFontColor("#1e3a8a");
  sheet.getRange("H4:I4").merge().setValue("NRC:").setFontWeight("bold");
  sheet.getRange("J4:M4").merge().setValue(data.nrc || "Sin asignar").setFontColor("#1e3a8a").setFontWeight("bold");

  sheet.getRange("A5:B5").merge().setValue("DOCENTE / COORD:").setFontWeight("bold");
  sheet.getRange("C5:G5").merge().setValue(data.coordinadora + (data.celular ? " · Tel: " + data.celular : ""));
  sheet.getRange("H5:I5").merge().setValue("MODALIDAD / SALÓN:").setFontWeight("bold");
  sheet.getRange("J5:M5").merge().setValue(data.modalidad + (data.salon ? " · " + data.salon : ""));

  sheet.getRange("A6:B6").merge().setValue("FECHAS Y HORARIO:").setFontWeight("bold");
  sheet.getRange("C6:M6").merge().setValue(
    (data.fechaInicio ? (data.fechaInicio + " al " + data.fechaFin) : "") +
    (data.horario ? (" | Horario: " + data.horario) : "")
  );

  sheet.getRange("A4:M6").setBackground("#f8fafc").setFontSize(9).setFontFamily("Arial");
  sheet.getRange("A4:M6").setBorder(true, true, true, true, true, true, "#cbd5e1", SpreadsheetApp.BorderStyle.SOLID);

  // 3. Columnas de asistencia dinámicas
  const headers = ["#", "No. Documento", "Nombre Completo del Participante", "Correo Electrónico"];
  const sesiones = (data.fechasSesion && Array.isArray(data.fechasSesion) && data.fechasSesion.length > 0)
    ? data.fechasSesion
    : [];
  const numSesiones = Math.max(sesiones.length, 8); // Al menos 8 sesiones predefinidas

  for (let s = 0; s < numSesiones; s++) {
    const fStr = sesiones[s] ? sesiones[s] : "";
    headers.push("Sesión " + (s + 1) + (fStr ? ("\n" + fStr) : ""));
  }

  headers.push("Total Asist.");
  headers.push("% Asistencia");
  headers.push("Estado Final");

  const startRow = 8;
  const numCols = headers.length;
  const headerRange = sheet.getRange(startRow, 1, 1, numCols);
  headerRange.setValues([headers]);
  headerRange.setBackground("#1e3a8a").setFontColor("#ffffff")
    .setFontWeight("bold").setFontSize(9).setFontFamily("Arial")
    .setHorizontalAlignment("center").setVerticalAlignment("middle")
    .setWrap(true);
  sheet.setRowHeight(startRow, 34);

  // 4. Filas para participantes (30 cupos pre-configurados con fórmulas de porcentaje)
  const numStudents = 30;
  const rows = [];
  const startColSesiones = 5; // Columna E
  const endColSesiones = startColSesiones + numSesiones - 1;

  function colToLetter(col) {
    let letter = "";
    while (col > 0) {
      let mod = (col - 1) % 26;
      letter = String.fromCharCode(65 + mod) + letter;
      col = Math.floor((col - mod) / 26);
    }
    return letter;
  }

  const colLetterStart = colToLetter(startColSesiones);
  const colLetterEnd = colToLetter(endColSesiones);
  const colLetterTotal = colToLetter(numCols - 2);
  const colLetterPercent = colToLetter(numCols - 1);

  for (let i = 1; i <= numStudents; i++) {
    const rowNum = startRow + i;
    const r = [i, "", "", ""];
    for (let s = 0; s < numSesiones; s++) {
      r.push(""); // Celda para marcar: P = Presente, F = Falta, E = Excusa
    }
    // Fórmulas automáticas de asistencia y aprobación (80% requerido por el CEC)
    r.push('=COUNTIF(' + colLetterStart + rowNum + ':' + colLetterEnd + rowNum + ', "P")');
    r.push('=' + colLetterTotal + rowNum + ' / ' + numSesiones);
    r.push('=IF(' + colLetterPercent + rowNum + '>=0.8, "APROBADO", IF(' + colLetterTotal + rowNum + '>0, "EN CURSO", "PENDIENTE"))');
    rows.push(r);
  }

  const dataRange = sheet.getRange(startRow + 1, 1, numStudents, numCols);
  dataRange.setValues(rows);
  dataRange.setFontSize(9).setFontFamily("Arial");
  dataRange.setBorder(true, true, true, true, true, true, "#e2e8f0", SpreadsheetApp.BorderStyle.SOLID);

  // Formato porcentaje en la columna %
  sheet.getRange(startRow + 1, numCols - 1, numStudents, 1).setNumberFormat("0.0%");
  sheet.getRange(startRow + 1, 1, numStudents, 1).setHorizontalAlignment("center");
  sheet.getRange(startRow + 1, startColSesiones, numStudents, numSesiones + 3).setHorizontalAlignment("center");

  // Anchos de columna
  sheet.setColumnWidth(1, 35);
  sheet.setColumnWidth(2, 110);
  sheet.setColumnWidth(3, 230);
  sheet.setColumnWidth(4, 180);
  for (let s = startColSesiones; s <= endColSesiones; s++) {
    sheet.setColumnWidth(s, 76);
  }
  sheet.setColumnWidth(numCols - 2, 85);
  sheet.setColumnWidth(numCols - 1, 95);
  sheet.setColumnWidth(numCols, 105);

  // Leyenda explicativa al pie
  const footRow = startRow + numStudents + 2;
  sheet.getRange("A" + footRow + ":M" + footRow).merge()
    .setValue("Convenciones para control de asistencia:  P = Presente  |  F = Falta injustificada  |  E = Excusa médica / laboral.  Requisito mínimo de certificación: 80% de asistencia.")
    .setFontSize(8).setFontColor("#64748b").setFontStyle("italic");
}

/**
 * 4.5. SINCRONIZACIÓN DE PARTICIPANTES Y ASISTENCIA CON GOOGLE SHEETS
 */
function sincronizarParticipantesASheet(data) {
  try {
    let spreadsheet = null;
    if (data.sheetId) {
      spreadsheet = SpreadsheetApp.openById(data.sheetId);
    } else if (data.sheetUrl) {
      const match = data.sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        spreadsheet = SpreadsheetApp.openById(match[1]);
      }
    }

    if (!spreadsheet) {
      const folderId = data.folderId || data.drive_folder_id;
      if (folderId) {
        try {
          const folder = DriveApp.getFolderById(folderId);
          const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
          if (files.hasNext()) spreadsheet = SpreadsheetApp.open(files.next());
        } catch (eF) { }
      }
    }

    if (!spreadsheet) {
      return { success: false, error: "No se encontró la hoja de cálculo de Google Drive." };
    }

    const sheet = spreadsheet.getSheetByName("Control Asistencia") || spreadsheet.getActiveSheet();
    const startRow = 8;
    const numCols = Math.max(sheet.getLastColumn(), 15);
    const headerValues = sheet.getRange(startRow, 1, 1, numCols).getValues()[0];

    // Detectar cuántas columnas de sesión hay
    let numSesiones = 0;
    for (let c = 4; c < headerValues.length; c++) {
      const hStr = (headerValues[c] || "").toString().toLowerCase();
      if (hStr.includes("total") || hStr.includes("%") || hStr.includes("estado")) {
        numSesiones = c - 4;
        break;
      }
    }
    if (numSesiones <= 0) numSesiones = 8;

    const rawPart = data.participantes;
    const participantes = Array.isArray(rawPart)
      ? rawPart
      : (rawPart && typeof rawPart === 'object' ? Object.values(rawPart) : []);

    const numRowsToWrite = Math.max(participantes.length, 30);
    const startColSesiones = 5;
    const endColSesiones = startColSesiones + numSesiones - 1;
    const totalCols = endColSesiones + 3;

    function colToLetter(col) {
      let letter = "";
      while (col > 0) {
        let mod = (col - 1) % 26;
        letter = String.fromCharCode(65 + mod) + letter;
        col = Math.floor((col - mod) / 26);
      }
      return letter;
    }

    const colLetterStart = colToLetter(startColSesiones);
    const colLetterEnd = colToLetter(endColSesiones);
    const colLetterTotal = colToLetter(totalCols - 2);
    const colLetterPercent = colToLetter(totalCols - 1);

    const rows = [];
    for (let i = 0; i < numRowsToWrite; i++) {
      const rowNum = startRow + 1 + i;
      const part = participantes[i] || null;
      const r = [
        i + 1,
        part ? (part.documento || "") : "",
        part ? (part.nombre || "") : "",
        part ? (part.correo || "") : ""
      ];

      for (let s = 0; s < numSesiones; s++) {
        let mark = "";
        if (part && part.asistencias) {
          mark = part.asistencias["sesion_" + s] || part.asistencias[s] || "";
        }
        r.push(mark);
      }

      // Fórmulas
      r.push('=COUNTIF(' + colLetterStart + rowNum + ':' + colLetterEnd + rowNum + ', "P")');
      r.push('=' + colLetterTotal + rowNum + ' / ' + numSesiones);
      r.push('=IF(' + colLetterPercent + rowNum + '>=0.8, "APROBADO", IF(' + colLetterTotal + rowNum + '>0, "EN CURSO", "PENDIENTE"))');
      rows.push(r);
    }

    sheet.getRange(startRow + 1, 1, numRowsToWrite, totalCols).setValues(rows);
    sheet.getRange(startRow + 1, totalCols - 1, numRowsToWrite, 1).setNumberFormat("0.0%");
    sheet.getRange(startRow + 1, 1, numRowsToWrite, 1).setHorizontalAlignment("center");
    sheet.getRange(startRow + 1, startColSesiones, numRowsToWrite, numSesiones + 3).setHorizontalAlignment("center");

    try {
      if (data.mesKey && data.nodeKey) {
        sheet.getRange("Z1").setValue(JSON.stringify({ mesKey: data.mesKey, nodeKey: data.nodeKey, sheetId: spreadsheet.getId() }));
        sheet.hideColumns(26);
      }
      asegurarActivadorDeEdicion(spreadsheet);
    } catch (eTrig) { }

    SpreadsheetApp.flush();

    return {
      success: true,
      count: participantes.length,
      sheetUrl: spreadsheet.getUrl(),
      message: "Se sincronizaron " + participantes.length + " participantes con la planilla de Google Drive."
    };
  } catch (err) {
    Logger.log("Error sincronizando participantes a Sheet: " + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 4.6. LECTURA DE ASISTENCIA DESDE GOOGLE SHEETS PARA TABULACIÓN
 */
function leerAsistenciaDeSheet(data) {
  try {
    let spreadsheet = null;
    if (data.sheetId) {
      spreadsheet = SpreadsheetApp.openById(data.sheetId);
    } else if (data.sheetUrl) {
      const match = data.sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) {
        spreadsheet = SpreadsheetApp.openById(match[1]);
      }
    }

    if (!spreadsheet) {
      return { success: false, error: "No se encontró la hoja de cálculo." };
    }

    const sheet = spreadsheet.getSheetByName("Control Asistencia") || spreadsheet.getActiveSheet();
    const startRow = 8;
    const lastRow = sheet.getLastRow();
    const numCols = sheet.getLastColumn();

    if (lastRow <= startRow) {
      return { success: true, participantes: [], sesionesTabuladas: {} };
    }

    const headerValues = sheet.getRange(startRow, 1, 1, numCols).getValues()[0];
    let numSesiones = 0;
    for (let c = 4; c < headerValues.length; c++) {
      const hStr = (headerValues[c] || "").toString().toLowerCase();
      if (hStr.includes("total") || hStr.includes("%") || hStr.includes("estado")) {
        numSesiones = c - 4;
        break;
      }
    }
    if (numSesiones <= 0) numSesiones = 8;

    const dataRows = sheet.getRange(startRow + 1, 1, lastRow - startRow, numCols).getValues();
    const participantes = [];
    const sesionesTabuladas = {};

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const doc = (row[1] || "").toString().trim();
      const nom = (row[2] || "").toString().trim();
      const cor = (row[3] || "").toString().trim();

      if (!doc && !nom && !cor) continue;

      const asistencias = {};
      for (let s = 0; s < numSesiones; s++) {
        const val = (row[4 + s] || "").toString().trim().toUpperCase();
        if (val) {
          asistencias["sesion_" + s] = val;
          sesionesTabuladas["sesion_" + s] = true;
        }
      }

      participantes.push({
        documento: doc,
        nombre: nom,
        correo: cor,
        asistencias: asistencias
      });
    }

    // Si viene mesKey y nodeKey, guardar directo en Firebase
    if (data.mesKey && data.nodeKey && participantes.length > 0) {
      try {
        sheet.getRange("Z1").setValue(JSON.stringify({ mesKey: data.mesKey, nodeKey: data.nodeKey, sheetId: spreadsheet.getId() }));
        sheet.hideColumns(26);
        asegurarActivadorDeEdicion(spreadsheet);
      } catch (eTrig) { }

      let existingParts = {};
      try {
        const exRes = UrlFetchApp.fetch(FIREBASE_DB_URL + "/meses/" + data.mesKey + "/programas/" + data.nodeKey + "/participantes.json", { muteHttpExceptions: true });
        if (exRes.getResponseCode() === 200) {
          existingParts = JSON.parse(exRes.getContentText()) || {};
        }
      } catch (eEx) { }

      const updates = {};
      const partObj = {};
      participantes.forEach((p, idx) => {
        let pKey = "";
        const cleanDoc = (p.documento || "").replace(/[^0-9A-Za-z_-]/g, "");
        for (const k of Object.keys(existingParts)) {
          const ex = existingParts[k];
          if (!ex) continue;
          const exDoc = String(ex.documento || "").replace(/[^0-9A-Za-z_-]/g, "");
          if (cleanDoc && exDoc && cleanDoc === exDoc) {
            pKey = k;
            break;
          }
          if (p.nombre && ex.nombre && String(ex.nombre).trim().toLowerCase() === String(p.nombre).trim().toLowerCase()) {
            pKey = k;
            break;
          }
        }
        if (!pKey) {
          pKey = "part_" + (cleanDoc || sanitizeFirebaseKeyGas(p.nombre || ("p_" + idx)));
        }
        const existingData = existingParts[pKey] || {};
        partObj[pKey] = {
          ...existingData,
          ...p,
          asistencias: { ...(existingData.asistencias || {}), ...(p.asistencias || {}) }
        };
      });
      updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/participantes"] = partObj;
      updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/sesiones_tabuladas"] = sesionesTabuladas;

      UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
        method: "patch",
        contentType: "application/json",
        payload: JSON.stringify(updates),
        muteHttpExceptions: true
      });
    }

    return {
      success: true,
      participantes: participantes,
      sesionesTabuladas: sesionesTabuladas,
      totalSesiones: numSesiones
    };
  } catch (err) {
    Logger.log("Error leyendo asistencia de Sheet: " + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 4.7. ACTUALIZACIÓN DE MARCA DE ASISTENCIA INDIVIDUAL EN TIEMPO REAL
 */
function actualizarMarcaAsistenciaIndividual(data) {
  try {
    let spreadsheet = null;
    if (data.sheetId) {
      spreadsheet = SpreadsheetApp.openById(data.sheetId);
    } else if (data.sheetUrl) {
      const match = data.sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) spreadsheet = SpreadsheetApp.openById(match[1]);
    }
    if (!spreadsheet && (data.folderId || data.drive_folder_id)) {
      try {
        const folder = DriveApp.getFolderById(data.folderId || data.drive_folder_id);
        const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
        if (files.hasNext()) spreadsheet = SpreadsheetApp.open(files.next());
      } catch (e) { }
    }
    if (!spreadsheet) return { success: false, error: "Planilla no encontrada" };

    const sheet = spreadsheet.getSheetByName("Control Asistencia") || spreadsheet.getActiveSheet();
    const startRow = 8;
    const lastRow = Math.max(sheet.getLastRow(), startRow + 30);

    const docTarget = (data.documento || "").toString().trim();
    const nomTarget = (data.nombre || "").toString().trim().toLowerCase();
    const studentIdx = parseInt(data.studentIndex, 10);
    const sesIdx = parseInt(data.sesionIndex, 10);
    const markVal = (data.mark || "").toString().trim().toUpperCase();

    let targetRow = -1;
    if (docTarget || nomTarget) {
      const docAndNomRange = sheet.getRange(startRow + 1, 2, Math.min(lastRow - startRow, 50), 2).getValues();
      for (let i = 0; i < docAndNomRange.length; i++) {
        const rowDoc = (docAndNomRange[i][0] || "").toString().trim();
        const rowNom = (docAndNomRange[i][1] || "").toString().trim().toLowerCase();
        if ((docTarget && rowDoc === docTarget) || (nomTarget && rowNom && (rowNom === nomTarget || rowNom.includes(nomTarget) || nomTarget.includes(rowNom)))) {
          targetRow = startRow + 1 + i;
          break;
        }
      }
    }

    if (targetRow === -1 && !isNaN(studentIdx) && studentIdx >= 0) {
      targetRow = startRow + 1 + studentIdx;
    }

    if (targetRow > 0 && !isNaN(sesIdx) && sesIdx >= 0) {
      const col = 5 + sesIdx; // Columna E en adelante
      sheet.getRange(targetRow, col).setValue(markVal);
      SpreadsheetApp.flush();
      return { success: true, updatedRow: targetRow, col: col, mark: markVal };
    }

    return { success: false, error: "No se encontró la fila del alumno" };
  } catch (err) {
    Logger.log("Error en actualizarMarcaAsistenciaIndividual: " + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 4.8. ACTUALIZACIÓN MASIVA DE SESIÓN EN TIEMPO REAL
 */
function actualizarSesionCompletaAsistencia(data) {
  try {
    let spreadsheet = null;
    if (data.sheetId) {
      spreadsheet = SpreadsheetApp.openById(data.sheetId);
    } else if (data.sheetUrl) {
      const match = data.sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (match && match[1]) spreadsheet = SpreadsheetApp.openById(match[1]);
    }
    if (!spreadsheet && (data.folderId || data.drive_folder_id)) {
      try {
        const folder = DriveApp.getFolderById(data.folderId || data.drive_folder_id);
        const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
        if (files.hasNext()) spreadsheet = SpreadsheetApp.open(files.next());
      } catch (e) { }
    }
    if (!spreadsheet) return { success: false, error: "Planilla no encontrada" };

    const sheet = spreadsheet.getSheetByName("Control Asistencia") || spreadsheet.getActiveSheet();
    const startRow = 8;
    const lastRow = Math.max(sheet.getLastRow(), startRow + 30);
    const sesIdx = parseInt(data.sesionIndex, 10);
    const markVal = (data.mark || "").toString().trim().toUpperCase();
    const countStudents = data.numStudents ? parseInt(data.numStudents, 10) : (lastRow - startRow);

    if (!isNaN(sesIdx) && sesIdx >= 0) {
      const col = 5 + sesIdx;
      const rowsCount = Math.max(countStudents, 1);
      const vals = [];
      for (let i = 0; i < rowsCount; i++) vals.push([markVal]);
      sheet.getRange(startRow + 1, col, rowsCount, 1).setValues(vals);
      SpreadsheetApp.flush();
      return { success: true, updatedCol: col, count: rowsCount, mark: markVal };
    }
    return { success: false, error: "Índice de sesión inválido" };
  } catch (err) {
    Logger.log("Error en actualizarSesionCompletaAsistencia: " + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 4.9. ACTIVADOR AUTOMÁTICO AL EDITAR EN GOOGLE SHEETS (SHEETS -> FIREBASE EN TIEMPO REAL)
 * Se ejecuta automáticamente en la nube cuando un usuario edita cualquier celda en Google Sheets.
 */
function alModificarPlanillaAsistencia(e) {
  if (!e || !e.range) return;
  try {
    const range = e.range;
    const sheet = range.getSheet();
    if (sheet.getName() !== "Control Asistencia") return;

    const startRow = 8;
    const startColSesiones = 5; // Columna E (Sesión 1)
    const startEditRow = range.getRow();
    const startEditCol = range.getColumn();
    const numEditRows = range.getNumRows();
    const numEditCols = range.getNumColumns();

    // Si toda la edición está en el encabezado o antes de la columna E, ignorar
    if (startEditRow + numEditRows - 1 <= startRow || startEditCol + numEditCols - 1 < startColSesiones) return;

    const numCols = Math.max(sheet.getLastColumn(), 15);
    const headerValues = sheet.getRange(startRow, 1, 1, numCols).getValues()[0];
    let numSesiones = 0;
    for (let c = 4; c < headerValues.length; c++) {
      const hStr = (headerValues[c] || "").toString().toLowerCase();
      if (hStr.includes("total") || hStr.includes("%") || hStr.includes("estado")) {
        numSesiones = c - 4;
        break;
      }
    }
    if (numSesiones <= 0) numSesiones = 8;

    const spreadsheet = e.source || sheet.getParent();
    const sheetId = spreadsheet.getId();

    // 1. Obtener metadatos del curso desde Z1 (optimizado en memoria)
    let mesKey = "";
    let nodeKey = "";
    try {
      const z1Val = sheet.getRange("Z1").getValue().toString().trim();
      if (z1Val && z1Val.startsWith("{")) {
        const meta = JSON.parse(z1Val);
        mesKey = meta.mesKey || "";
        nodeKey = meta.nodeKey || "";
      }
    } catch (eMeta) { }

    // 2. Si no están en Z1, buscar en Firebase
    if (!mesKey || !nodeKey) {
      try {
        const allRes = UrlFetchApp.fetch(FIREBASE_DB_URL + "/meses.json", { muteHttpExceptions: true });
        if (allRes.getResponseCode() === 200) {
          const allMeses = JSON.parse(allRes.getContentText()) || {};
          for (const mKey of Object.keys(allMeses)) {
            const progs = (allMeses[mKey] && allMeses[mKey].programas) || {};
            for (const nKey of Object.keys(progs)) {
              if (progs[nKey] && (progs[nKey].asistencia_sheet_id === sheetId || (progs[nKey].asistencia_sheet_url && progs[nKey].asistencia_sheet_url.includes(sheetId)))) {
                mesKey = mKey;
                nodeKey = nKey;
                break;
              }
            }
            if (mesKey) break;
          }
        }
      } catch (eScan) { }
    }

    if (!mesKey || !nodeKey) return;

    try {
      sheet.getRange("Z1").setValue(JSON.stringify({ mesKey: mesKey, nodeKey: nodeKey, sheetId: sheetId }));
      sheet.hideColumns(26);
    } catch (eZ) { }

    const basePath = "meses/" + mesKey + "/programas/" + nodeKey;

    // Obtener participantes existentes para preservar y matchear claves de forma segura
    let partsObj = {};
    try {
      const partsRes = UrlFetchApp.fetch(FIREBASE_DB_URL + "/" + basePath + "/participantes.json", { muteHttpExceptions: true });
      if (partsRes.getResponseCode() === 200) {
        partsObj = JSON.parse(partsRes.getContentText()) || {};
      }
    } catch (eP) { }

    const editValues = range.getValues();
    const minRow = Math.max(startEditRow, startRow + 1);
    const maxRow = startEditRow + numEditRows - 1;
    const countRows = maxRow - minRow + 1;
    if (countRows <= 0) return;

    // Leer información de alumnos de las filas editadas
    const studentInfoRows = sheet.getRange(minRow, 2, countRows, 3).getValues(); // Columnas B (doc), C (nom), D (cor)
    const updates = {};
    let hasUpdates = false;

    for (let r = 0; r < numEditRows; r++) {
      const curRow = startEditRow + r;
      if (curRow <= startRow) continue;

      const infoIdx = curRow - minRow;
      const doc = (studentInfoRows[infoIdx] && studentInfoRows[infoIdx][0] || "").toString().trim();
      const nom = (studentInfoRows[infoIdx] && studentInfoRows[infoIdx][1] || "").toString().trim();
      const cor = (studentInfoRows[infoIdx] && studentInfoRows[infoIdx][2] || "").toString().trim();
      if (!doc && !nom) continue;

      const cleanDoc = doc.replace(/[^0-9A-Za-z_-]/g, "");
      let pKey = "";

      // Buscar si ya existe por documento o nombre
      for (const k of Object.keys(partsObj)) {
        const p = partsObj[k];
        if (!p) continue;
        const pDoc = String(p.documento || "").replace(/[^0-9A-Za-z_-]/g, "");
        if (cleanDoc && pDoc && cleanDoc === pDoc) {
          pKey = k;
          break;
        }
        if (nom && p.nombre && String(p.nombre).trim().toLowerCase() === nom.toLowerCase()) {
          pKey = k;
          break;
        }
      }

      if (!pKey) {
        pKey = "part_" + (cleanDoc || sanitizeFirebaseKeyGas(nom));
        updates[basePath + "/participantes/" + pKey + "/documento"] = doc;
        updates[basePath + "/participantes/" + pKey + "/nombre"] = nom || "Sin nombre";
        if (cor) updates[basePath + "/participantes/" + pKey + "/correo"] = cor;
      }

      for (let c = 0; c < numEditCols; c++) {
        const curCol = startEditCol + c;
        if (curCol < startColSesiones) continue;

        const sesIdx = curCol - startColSesiones;
        if (sesIdx >= numSesiones) continue; // Columna de total o fuera de rango

        const rawCell = (editValues[r][c] !== undefined ? editValues[r][c] : "").toString().trim().toUpperCase();
        const markVal = (rawCell === "P" || rawCell === "F" || rawCell === "E") ? rawCell : (rawCell === "" ? "" : rawCell);

        updates[basePath + "/participantes/" + pKey + "/asistencias/sesion_" + sesIdx] = markVal ? markVal : null;
        if (markVal) {
          updates[basePath + "/sesiones_tabuladas/sesion_" + sesIdx] = true;
        }
        hasUpdates = true;
      }
    }

    if (hasUpdates && Object.keys(updates).length > 0) {
      UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
        method: "patch",
        contentType: "application/json",
        payload: JSON.stringify(updates),
        muteHttpExceptions: true
      });
      Logger.log("✓ Sincronización instantánea Sheets -> Firebase completada: " + Object.keys(updates).length + " registros");
    }
  } catch (err) {
    Logger.log("Error en alModificarPlanillaAsistencia: " + err.message);
  }
}

/**
 * Asegura que la hoja de cálculo tenga un activador onEdit para Sheets -> Firebase
 */
function asegurarActivadorDeEdicion(spreadsheet) {
  if (!spreadsheet) return;
  try {
    const sheetId = spreadsheet.getId();
    const triggers = ScriptApp.getProjectTriggers();
    let alreadyExists = false;

    for (let i = 0; i < triggers.length; i++) {
      const t = triggers[i];
      try {
        if (t.getHandlerFunction() === "alModificarPlanillaAsistencia" && t.getTriggerSourceId() === sheetId) {
          alreadyExists = true;
          break;
        }
      } catch (eT) { }
    }

    if (!alreadyExists) {
      if (triggers.length >= 18) {
        limpiarActivadoresAntiguos();
      }
      ScriptApp.newTrigger("alModificarPlanillaAsistencia")
        .forSpreadsheet(spreadsheet)
        .onEdit()
        .create();
      Logger.log("✓ Activador de edición vinculado a: " + spreadsheet.getName());
    }
  } catch (err) {
    Logger.log("Nota vinculando activador de edición: " + err.message);
  }
}

function limpiarActivadoresAntiguos() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    const editTriggers = triggers.filter(t => t.getHandlerFunction() === "alModificarPlanillaAsistencia");
    const countToDelete = Math.min(5, editTriggers.length);
    for (let i = 0; i < countToDelete; i++) {
      ScriptApp.deleteTrigger(editTriggers[i]);
    }
  } catch (e) { }
}

function vincularActivadoresParaTodasLasHojas() {
  let count = 0;
  try {
    const folders = DriveApp.getFoldersByName("Cursos CEC");
    if (!folders.hasNext()) return { success: false, message: "No se encontró carpeta Cursos CEC" };
    const root = folders.next();
    const subMeses = root.getFolders();

    while (subMeses.hasNext()) {
      const mesF = subMeses.next();
      const cursoFs = mesF.getFolders();
      while (cursoFs.hasNext()) {
        const cF = cursoFs.next();
        const files = cF.getFilesByType(MimeType.GOOGLE_SHEETS);
        while (files.hasNext()) {
          try {
            const sp = SpreadsheetApp.open(files.next());
            asegurarActivadorDeEdicion(sp);
            count++;
          } catch (e) { }
        }
      }
    }
  } catch (eGlobal) { }
  return { success: true, count: count };
}

/**
 * ACTUALIZADOR DE CARPETA Y FICHA DE ASISTENCIA EN TIEMPO REAL
 * Se ejecuta mediante Webhook cuando se edita un curso en la web.
 */
function actualizarEstructuraDriveExistente(prog) {
  if (!prog) return { success: false, error: "Datos no proporcionados" };
  const nombreCurso = (prog.programa || prog.nombre_del_programa || prog.nombre || "").trim();
  const nrc = (prog.nrc || "").toString().trim();
  const cleanCursoFolder = (nombreCurso + (nrc ? (" - NRC " + nrc) : "")).replace(/[\\/:*?"<>|]/g, "_").substring(0, 100);

  let cursoFolder = null;
  if (prog.folderId || prog.drive_folder_id) {
    try {
      cursoFolder = DriveApp.getFolderById(prog.folderId || prog.drive_folder_id);
    } catch (e) { }
  }

  // Si no se encontró por ID, buscarlo por nombre
  if (!cursoFolder) {
    const rootIter = DriveApp.getFoldersByName("Cursos CEC");
    if (rootIter.hasNext()) {
      const rootFolder = rootIter.next();
      const mesFolderName = getMesKeyDrive(prog.mes || prog.origen_mes || "");
      const mesIter = rootFolder.getFoldersByName(mesFolderName);
      const parentFolder = mesIter.hasNext() ? mesIter.next() : rootFolder;
      const subIter = parentFolder.getFoldersByName(cleanCursoFolder);
      if (subIter.hasNext()) {
        cursoFolder = subIter.next();
      }
    }
  }

  // Si la carpeta existe, renombrarla si su nombre cambió
  if (cursoFolder) {
    if (cursoFolder.getName() !== cleanCursoFolder) {
      cursoFolder.setName(cleanCursoFolder);
    }

    // Actualizar datos dentro de la hoja de cálculo
    const sheetFileName = "Asistencia - " + nombreCurso + (nrc ? (" (NRC " + nrc + ")") : "");
    const fileIter = cursoFolder.getFilesByType(MimeType.GOOGLE_SHEETS);
    if (fileIter.hasNext()) {
      const sheetFile = fileIter.next();
      if (sheetFile.getName() !== sheetFileName) {
        sheetFile.setName(sheetFileName);
      }
      try {
        const spreadsheet = SpreadsheetApp.openById(sheetFile.getId());
        const sheet = spreadsheet.getActiveSheet();
        sheet.getRange("C4:G4").setValue(nombreCurso);
        sheet.getRange("J4:M4").setValue(nrc || "Sin asignar");
        sheet.getRange("C5:G5").setValue((prog.coordinadora || prog.nombre_contacto || "") + (prog.celular ? " · Tel: " + prog.celular : ""));
        sheet.getRange("J5:M5").setValue((prog.modalidad || "Presencial") + (prog.salon || prog.salones_1_val ? " · " + (prog.salon || prog.salones_1_val) : ""));
        sheet.getRange("C6:M6").setValue(
          (prog.fecha_inicio ? (prog.fecha_inicio + " al " + (prog.fecha_fin || "")) : "") +
          (prog.horario ? (" | Horario: " + prog.horario) : "")
        );
      } catch (eSheet) {
        Logger.log("Nota actualizando hoja: " + eSheet.message);
      }
    }

    return {
      success: true,
      folderId: cursoFolder.getId(),
      folderUrl: cursoFolder.getUrl()
    };
  } else {
    // Si no existía carpeta previa, crearla desde cero
    return crearEstructuraDriveYAsistencia(prog);
  }
}

/**
 * 4.5. PROCESADOR DE CORREOS ENTRANTES POR REENVÍO WEBHOOK (CLOUDMAILIN / ZAPIER / MAKE / HTTP DIRECTO)
 */
function procesarCorreoEntranteJson(data) {
  try {
    // 1. Extraer remitente
    let from = data.from || data.sender || data.remitente || "";
    if (!from && data.headers && data.headers.From) from = data.headers.From;

    // 2. Extraer asunto
    let subject = data.subject || data.asunto || "";
    if (!subject && data.headers && data.headers.Subject) subject = data.headers.Subject;

    // 3. Extraer cuerpo del correo
    let plainBody = data.plain || data.body || data.text || data.cuerpo || "";
    if (!plainBody && data.html) {
      plainBody = data.html.replace(/<[^>]*>/g, " "); // Limpiar HTML básico si solo viene HTML
    }

    if (!subject && !plainBody) {
      return { success: false, error: "Asunto y cuerpo vacíos en el payload recibido" };
    }

    Logger.log("⚡ [INBOUND EMAIL WEBHOOK] Recibido: " + subject + " de " + from);

    // 4. Extraer datos del curso con IA o heurístico
    let datosExtraidos = null;
    if (GEMINI_API_KEY && GEMINI_API_KEY.trim().length > 10) {
      datosExtraidos = extraerConGeminiAI(subject, plainBody);
    }
    if (!datosExtraidos) {
      datosExtraidos = extraerHeuristico(subject, plainBody);
    }

    const uniqueId = "inbound_" + new Date().getTime();
    const payload = {
      id: uniqueId,
      message_id: data.message_id || uniqueId,
      remitente: from || "Remitente Desconocido",
      asunto: subject || "Solicitud de Apertura",
      fecha_correo: data.date || data.fecha || new Date().toISOString(),
      fecha_deteccion: new Date().toISOString(),
      cuerpo_resumen: plainBody.substring(0, 800),
      cuerpo_completo: plainBody.substring(0, 4000),
      datos_extraidos: datosExtraidos,
      estado: "pendiente",
      origen: "filtro_reenvio_webhook"
    };

    // Guardar en Firebase Realtime Database
    const url = FIREBASE_DB_URL + "/solicitudes_pendientes/" + uniqueId + ".json";
    UrlFetchApp.fetch(url, {
      method: "put",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    Logger.log("✓ Solicitud guardada en Firebase desde Webhook de reenvío: " + uniqueId);
    return {
      success: true,
      requestId: uniqueId,
      programa: datosExtraidos ? datosExtraidos.nombre : subject,
      message: "Correo procesado y registrado con éxito en Firebase"
    };
  } catch (err) {
    Logger.log("Error en procesarCorreoEntranteJson: " + err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 5. WEBHOOK HTTP PRINCIPAL (PROCESAMIENTO EN TIEMPO REAL DE CREACIÓN, EDICIÓN Y ELIMINACIÓN)
 */
function doPost(e) {
  try {
    const bodyText = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    const data = JSON.parse(bodyText);

    // 0. NOTIFICACIÓN PUSH DE GMAIL VIA GOOGLE CLOUD PUB/SUB (ESTILO WEBHOOK EN TIEMPO REAL)
    // Cuando entra un correo, Pub/Sub envía inmediatamente este payload a doPost
    if (data && data.message && (data.message.data || data.message.messageId || data.message.message_id)) {
      Logger.log("⚡ [GMAIL PUSH WEBHOOK] Notificación instantánea recibida de Google Cloud Pub/Sub.");
      try {
        if (data.message.data) {
          const decoded = Utilities.newBlob(Utilities.base64Decode(data.message.data)).getDataAsString();
          Logger.log("Payload Gmail Push decodificado: " + decoded);
        }
      } catch (errDec) {
        Logger.log("Nota decodificando Pub/Sub: " + errDec.message);
      }

      // Procesar correos de apertura inmediatamente en tiempo cero
      try {
        revisarCorreosAperturaCurso();
      } catch (errSync) {
        Logger.log("Error en sincronización por push: " + errSync.message);
      }

      // Responder 200 OK con JSON para confirmar recepción a Pub/Sub
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        status: "processed",
        source: "gmail_pubsub_webhook",
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 0.5. VERIFICACIÓN BAJO DEMANDA DESDE EL TABLERO WEB
    if (data.action === "check_emails" || data.action === "revisar_correos") {
      try {
        revisarCorreosAperturaCurso();
      } catch (errCheck) {
        Logger.log("Error en check_emails: " + errCheck.message);
      }
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        action: "checked_emails",
        message: "Búsqueda de correos de apertura ejecutada en tiempo real.",
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 0.6. REENVÍO AUTOMÁTICO DE GMAIL (INBOUND EMAIL PARSE / CLOUDMAILIN / ZAPIER / MAKE)
    if (data.action === "inbound_email" || data.headers || data.plain || (data.subject && (data.body || data.text || data.plain)) || (data.asunto && data.cuerpo)) {
      const resultInbound = procesarCorreoEntranteJson(data);
      return ContentService.createTextOutput(JSON.stringify(resultInbound))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 1. PING para verificar el webhook desde la web
    if (data.action === "ping") {
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        status: "connected",
        message: "Webhook de Google Apps Script conectado exitosamente en tiempo real.",
        timestamp: new Date().toISOString()
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 2. ELIMINACIÓN DE CURSO EN TIEMPO REAL
    if (data.action === "delete" || data.action === "delete_folder") {
      if (data.folderId) {
        try {
          DriveApp.getFolderById(data.folderId).setTrashed(true);
          Logger.log("✓ Carpeta enviada a papelera por webhook: " + data.folderId);
        } catch (e2) {
          eliminarCarpetaCursoPorNombre(data.mes, data.nombre, data.nrc);
        }
      } else {
        eliminarCarpetaCursoPorNombre(data.mes, data.nombre, data.nrc);
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: "deleted" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 3. VACIAR BASE DE DATOS / CARPETAS EN TIEMPO REAL
    if (data.action === "vaciar_todo") {
      eliminarTodasLasCarpetasCursosDrive();
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: "emptied" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 4. EDICIÓN DE CURSO EN TIEMPO REAL
    if (data.action === "edit" || data.action === "update") {
      const resultEdit = actualizarEstructuraDriveExistente(data);
      if (data.mesKey && data.nodeKey && resultEdit.success) {
        const updates = {};
        if (resultEdit.folderUrl) updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/drive_folder_url"] = resultEdit.folderUrl;
        if (resultEdit.folderId) updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/drive_folder_id"] = resultEdit.folderId;
        UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
          method: "patch",
          contentType: "application/json",
          payload: JSON.stringify(updates),
          muteHttpExceptions: true
        });
      }
      return ContentService.createTextOutput(JSON.stringify(resultEdit))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5. IMPORTACIÓN MASIVA EN TIEMPO REAL (BATCH CREATE)
    if (data.action === "batch_create" && Array.isArray(data.items)) {
      let createdCount = 0;
      for (let i = 0; i < data.items.length; i++) {
        const item = data.items[i];
        if (!item) continue;
        try {
          const resDrive = crearEstructuraDriveYAsistencia(item);
          const mesKey = item.mesKey || getMesKeyDrive(item.mes || item.origen_mes || "General");
          const nodeKey = item.nodeKey || item.id || sanitizeFirebaseKeyGas(item.programa || item.nombre || "prog");

          const updates = {};
          updates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_folder_url"] = resDrive.folderUrl;
          updates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_folder_id"] = resDrive.folderId;
          updates["meses/" + mesKey + "/programas/" + nodeKey + "/asistencia_sheet_url"] = resDrive.sheetUrl;
          updates["meses/" + mesKey + "/programas/" + nodeKey + "/asistencia_sheet_id"] = resDrive.sheetId;
          updates["meses/" + mesKey + "/programas/" + nodeKey + "/drive_creado_el"] = new Date().toISOString();

          UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
            method: "patch",
            contentType: "application/json",
            payload: JSON.stringify(updates),
            muteHttpExceptions: true
          });
          createdCount++;
        } catch (errItem) {
          Logger.log("Error en batch create webhook: " + errItem.message);
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true, createdCount: createdCount }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    // 5.5. SINCRONIZACIÓN DE PARTICIPANTES A GOOGLE SHEETS
    if (data.action === "sync_participants") {
      const resSyncPart = sincronizarParticipantesASheet(data);
      return ContentService.createTextOutput(JSON.stringify(resSyncPart))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5.6. LECTURA Y AUDITORÍA DE ASISTENCIA DESDE GOOGLE SHEETS
    if (data.action === "read_attendance" || data.action === "sync_attendance") {
      const resReadAtt = leerAsistenciaDeSheet(data);
      return ContentService.createTextOutput(JSON.stringify(resReadAtt))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5.7. ACTUALIZACIÓN DE MARCA INDIVIDUAL EN TIEMPO REAL
    if (data.action === "update_attendance_mark") {
      const resMark = actualizarMarcaAsistenciaIndividual(data);
      return ContentService.createTextOutput(JSON.stringify(resMark))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5.8. ACTUALIZACIÓN DE SESIÓN COMPLETA EN TIEMPO REAL
    if (data.action === "update_session_attendance") {
      const resSes = actualizarSesionCompletaAsistencia(data);
      return ContentService.createTextOutput(JSON.stringify(resSes))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 5.9. VINCULAR ACTIVADOR ONEDIT EN TIEMPO REAL (SHEETS -> FIREBASE)
    if (data.action === "setup_sheet_triggers" || data.action === "vincular_activadores") {
      let resTrig = { success: true };
      if (data.sheetId) {
        try {
          const sp = SpreadsheetApp.openById(data.sheetId);
          asegurarActivadorDeEdicion(sp);
          if (data.mesKey && data.nodeKey) {
            const sh = sp.getSheetByName("Control Asistencia") || sp.getActiveSheet();
            sh.getRange("Z1").setValue(JSON.stringify({ mesKey: data.mesKey, nodeKey: data.nodeKey, sheetId: data.sheetId }));
            sh.hideColumns(26);
          }
          resTrig = { success: true, sheetId: data.sheetId, sheetName: sp.getName(), message: "Activador de edición en tiempo real vinculado a la planilla." };
        } catch (eTrig) {
          resTrig = { success: false, error: eTrig.message };
        }
      } else {
        resTrig = vincularActivadoresParaTodasLasHojas();
      }
      return ContentService.createTextOutput(JSON.stringify(resTrig))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 6. SINCRONIZACIÓN DE TODOS LOS CURSOS
    if (data.action === "sync_all") {
      sincronizarTodosLosCursosADrive();
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: "synced_all" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // 7. CREACIÓN DE CURSO EN TIEMPO REAL
    if (data.action === "create" || data.action === "crear_curso" || data.action === "create_course" || (!data.action && (data.programa || data.nombre))) {
      const result = crearEstructuraDriveYAsistencia(data);
      if (data.mesKey && data.nodeKey) {
        const updates = {};
        updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/drive_folder_url"] = result.folderUrl;
        updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/drive_folder_id"] = result.folderId;
        updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/asistencia_sheet_url"] = result.sheetUrl;
        updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/asistencia_sheet_id"] = result.sheetId;
        updates["meses/" + data.mesKey + "/programas/" + data.nodeKey + "/drive_creado_el"] = new Date().toISOString();

        UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", {
          method: "patch",
          contentType: "application/json",
          payload: JSON.stringify(updates),
          muteHttpExceptions: true
        });
      }

      return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ success: false, error: "Acción no reconocida: " + data.action }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: "ok", app: "CEC Uninorte Drive Webhook", timestamp: new Date().toISOString() }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 6. UTILIDADES AUXILIARES Y EXTRACTOR INTELIGENTE
 */
function getMesKeyDrive(mesStr) {
  const MESES_DICT = {
    enero: "01_Enero", febrero: "02_Febrero", marzo: "03_Marzo", abril: "04_Abril",
    mayo: "05_Mayo", junio: "06_Junio", julio: "07_Julio", agosto: "08_Agosto",
    septiembre: "09_Septiembre", setiembre: "09_Septiembre", octubre: "10_Octubre",
    noviembre: "11_Noviembre", diciembre: "12_Diciembre"
  };
  const m = (mesStr || "").toLowerCase().replace(/^[0-9]+_/, "");
  return MESES_DICT[m] || "01_Enero";
}

function sanitizeFirebaseKeyGas(str) {
  return (str || "prog").toString().trim().replace(/[.$#\[\]\/]/g, "_");
}

function extraerConGeminiAI(asunto, texto) {
  try {
    const prompt = 'Analiza el siguiente correo sobre "Apertura de Curso/Programa" en el Centro de Educación Continuada (CEC) y extrae los datos en formato JSON estricto sin bloques markdown:\n' +
      '{\n' +
      '  "nombre": "Nombre completo del curso, diplomado o taller",\n' +
      '  "nrc": "Código NRC numérico de 4 a 6 dígitos",\n' +
      '  "modalidad": "Presencial" | "Remoto" | "Blended",\n' +
      '  "tipo": "Curso" | "Diplomado" | "Taller" | "Seminario" | "Certificación",\n' +
      '  "coordinadora": "Nombre y apellido del docente o coordinadora responsable (sin títulos como Dra. o Lic.)",\n' +
      '  "celular": "Número telefónico o celular limpio (solo dígitos)",\n' +
      '  "fechaInicio": "YYYY-MM-DD",\n' +
      '  "fechaFin": "YYYY-MM-DD",\n' +
      '  "horario": "Texto legible de horario, ej: Lunes y Miércoles 6:00 pm a 9:00 pm",\n' +
      '  "salones": "Salón, aula o link virtual Teams/Zoom",\n' +
      '  "mes": "Nombre del mes de inicio (Enero, Febrero, Marzo, Abril, Mayo, Junio, Julio, Agosto, Septiembre, Octubre, Noviembre, Diciembre)",\n' +
      '  "observaciones": "Cualquier detalle relevante adicional"\n' +
      '}\n\n' +
      'Asunto: ' + asunto + '\n' +
      'Cuerpo del correo:\n' + texto.substring(0, 3000);

    const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_API_KEY;
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
      }),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() === 200) {
      const data = JSON.parse(res.getContentText());
      const rawText = data.candidates[0].content.parts[0].text;
      return JSON.parse(rawText);
    }
  } catch (e) {
    Logger.log("Fallo Gemini API: " + e.message);
  }
  return null;
}

/**
 * FILTRO ESTRICTO ANTI-FALSOS POSITIVOS
 * Descarta automáticamente boletines, digestos de Quora, confirmaciones de Zoom,
 * notificaciones de sistemas automáticos y correos que no correspondan a cursos.
 */
function esCorreoAperturaValido(subject, plainBody, from) {
  const s = (subject || "").toLowerCase();
  const f = (from || "").toLowerCase();
  const b = (plainBody || "").toLowerCase();
  const full = s + "\n" + b;

  // 1. Descarte inmediato por remitentes no humanos / listas / sistemas
  if (/quora\.com|zoom\.us|notifications?@|no-?reply|mailer-daemon|postmaster|newsletter|digest|marketing|linkedin|facebook|twitter|instagram|tiktok|googlealerts|youtube|promocion|bounces/i.test(f)) {
    Logger.log("⛔ Descartado por remitente no válido: " + from);
    return false;
  }

  // 2. Descarte inmediato por asuntos típicos de boletines o confirmaciones personales
  if (/quora|digest|confirmaci[oó]n\s+de\s+(?:zoom|reuni[oó]n|cita)|resumen\s+semanal|newsletter|publicidad|promoci[oó]n|estado\s+de\s+cuenta/i.test(s)) {
    Logger.log("⛔ Descartado por asunto no operativo: " + subject);
    return false;
  }

  // 3. Si el asunto contiene explícitamente "apertura" o "solicitud de apertura", es alta probabilidad
  if (/apertura/i.test(s)) {
    return true;
  }

  // 4. Si el asunto no tiene "apertura", pero menciona "diplomado" o en el cuerpo dice "solicitud de apertura":
  // Exigir al menos 2 datos operacionales concretos de curso (NRC, fechas, horario o docente)
  let score = 0;
  if (/\b(nrc|c[oó]digo)\b/i.test(full)) score += 2;
  if (/\b(horario|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{1,2}:\d{2}\s*(?:am|pm)?)\b/i.test(full)) score += 2;
  if (/\b(fecha|inicia|inicio|finaliza|fin|\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre))\b/i.test(full)) score += 2;
  if (/\b(sal[oó]n|link|enlace|presencial|remoto|virtual|blended)\b/i.test(full)) score += 1;
  if (/\b(coordinador|coordinadora|docente|profesor|facilitador)\b/i.test(full)) score += 1;
  if (/solicitud/i.test(full)) score += 1;

  if (score >= 4) {
    return true;
  }

  Logger.log("⛔ Descartado por puntaje insuficiente de datos de curso (score: " + score + "): " + subject);
  return false;
}

function extraerHeuristico(asunto, texto) {
  const full = (asunto || "") + "\n" + (texto || "");

  const nrcMatch = full.match(/\bNRC[:\s#.-]*([0-9]{4,6})\b/i) ||
    full.match(/(?:c[oó]digo(?:\s+nrc)?|id)[:\s#.-]*([0-9]{4,6})\b/i) ||
    full.match(/\(([0-9]{4,6})\)/);
  const nrc = nrcMatch ? nrcMatch[1] : "";

  let modalidad = "Presencial";
  if (/blended|h[ií]brid[oa]|semipresencial/i.test(full)) {
    modalidad = "Blended";
  } else if (/remot[oa]|virtual|online|teams|zoom|meet/i.test(full)) {
    modalidad = "Remoto";
  }

  let tipo = "Curso";
  if (/diplomado/i.test(full)) tipo = "Diplomado";
  else if (/taller/i.test(full)) tipo = "Taller";
  else if (/seminario/i.test(full)) tipo = "Seminario";
  else if (/certificaci[oó]n/i.test(full)) tipo = "Certificación";

  let nombre = "";
  const explicit = (texto || "").match(/(?:nombre(?:\s+del\s+(?:programa|curso|evento|taller|diplomado))?|programa|curso|diplomado|taller)\s*[:=]\s*([^\n\r]+)/i);
  if (explicit && explicit[1].trim().length > 3) {
    nombre = explicit[1].trim();
  }
  if (!nombre) {
    const inlineAction = (texto || "").match(/(?:favor\s+abrir|apertura(?:\s+formal)?(?:\s+del?)?)\s+(?:el\s+)?((?:curso|diplomado|taller|seminario|programa)\s+[^(\n\r,.;]+)/i);
    if (inlineAction && inlineAction[1].trim().length > 3) {
      nombre = inlineAction[1].trim();
    }
  }
  if (!nombre) {
    nombre = (asunto || "").replace(/^(?:fwd|rv|re)[:\s]*/gi, "")
      .replace(/^(?:solicitud(?:\s+de)?\s+)?apertura(?:\s+de|\s+del?)?(?:\s+(?:curso|programa|taller|diplomado|seminario))?[:\s-]*/gi, "")
      .trim();
  }
  nombre = nombre.replace(/^(?:de|del)\s+/i, "")
    .replace(/\s*\(?\s*NRC[:\s#]*[0-9]{4,6}\s*\)?/i, "")
    .replace(/[•\-\*\.]\s*$/g, "")
    .replace(/^[•\-\*\.]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!nombre) nombre = "Apertura de Curso";

  const MESES_DICT = {
    enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
    julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12"
  };
  const MESES_LIST = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const anioActual = new Date().getFullYear();
  let fechaInicio = "";
  let fechaFin = "";

  const rangeSame = full.match(/(?:del?|desde)?\s*(\d{1,2})\s*(?:al?|a|-)\s*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
  if (rangeSame && MESES_DICT[rangeSame[3].toLowerCase()]) {
    const m = MESES_DICT[rangeSame[3].toLowerCase()];
    const y = rangeSame[4] || anioActual;
    fechaInicio = y + "-" + m + "-" + String(rangeSame[1]).padStart(2, "0");
    fechaFin = y + "-" + m + "-" + String(rangeSame[2]).padStart(2, "0");
  }

  if (!fechaInicio) {
    const rangeDiff = full.match(/(?:del?|desde)?\s*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?\s*(?:al?|hasta|a|-)\s*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
    if (rangeDiff && MESES_DICT[rangeDiff[2].toLowerCase()] && MESES_DICT[rangeDiff[5].toLowerCase()]) {
      const y1 = rangeDiff[3] || anioActual;
      const y2 = rangeDiff[6] || y1;
      fechaInicio = y1 + "-" + MESES_DICT[rangeDiff[2].toLowerCase()] + "-" + String(rangeDiff[1]).padStart(2, "0");
      fechaFin = y2 + "-" + MESES_DICT[rangeDiff[5].toLowerCase()] + "-" + String(rangeDiff[4]).padStart(2, "0");
    }
  }

  if (!fechaInicio) {
    const dStart = full.match(/(?:inicio|inicia|desde|fechas?[:\s]*del?)[:\s]*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
    if (dStart && MESES_DICT[dStart[2].toLowerCase()]) {
      fechaInicio = (dStart[3] || anioActual) + "-" + MESES_DICT[dStart[2].toLowerCase()] + "-" + String(dStart[1]).padStart(2, "0");
    }
  }
  if (!fechaFin) {
    const dEnd = full.match(/(?:fin|finaliza|hasta|cierre)[:\s]*(\d{1,2})\s+de\s+([a-zá-ú]+)(?:\s+de\s+(\d{4}))?/i);
    if (dEnd && MESES_DICT[dEnd[2].toLowerCase()]) {
      fechaFin = (dEnd[3] || anioActual) + "-" + MESES_DICT[dEnd[2].toLowerCase()] + "-" + String(dEnd[1]).padStart(2, "0");
    }
  }

  if (!fechaInicio) {
    const isoMatches = full.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g);
    if (isoMatches && isoMatches.length >= 1) {
      const p1 = isoMatches[0].split(/[-/]/);
      fechaInicio = p1[0] + "-" + String(p1[1]).padStart(2, "0") + "-" + String(p1[2]).padStart(2, "0");
      if (isoMatches.length >= 2) {
        const p2 = isoMatches[1].split(/[-/]/);
        fechaFin = p2[0] + "-" + String(p2[1]).padStart(2, "0") + "-" + String(p2[2]).padStart(2, "0");
      }
    }
  }
  if (!fechaInicio) {
    const latamMatches = full.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g);
    if (latamMatches && latamMatches.length >= 1) {
      const p1 = latamMatches[0].split(/[-/]/);
      fechaInicio = p1[2] + "-" + String(p1[1]).padStart(2, "0") + "-" + String(p1[0]).padStart(2, "0");
      if (latamMatches.length >= 2) {
        const p2 = latamMatches[1].split(/[-/]/);
        fechaFin = p2[2] + "-" + String(p2[1]).padStart(2, "0") + "-" + String(p2[0]).padStart(2, "0");
      }
    }
  }

  let mes = "";
  if (fechaInicio) {
    const mNum = parseInt(fechaInicio.split("-")[1], 10);
    if (mNum >= 1 && mNum <= 12) mes = MESES_LIST[mNum - 1];
  }
  if (!mes) {
    for (let i = 0; i < MESES_LIST.length; i++) {
      if (new RegExp(MESES_LIST[i], "i").test(full)) {
        mes = MESES_LIST[i];
        break;
      }
    }
  }

  let coordinadora = "";
  const coordMatch = full.match(/(?:coordinador[a]?\s*(?:encargad[oa]|acad[eé]mic[oa]|responsable)?|docente\s*(?:responsable|encargad[oa])?|profesor[a]?|solicitado\s+por|responsable|instructor[a]?|facilitador[a]?|a\s+cargo\s+de)[:\s]+(?:(?:Lic\.|Dra?\.|Ing\.|Mg\.|Prof\.)\s*)?([^\n\r,;()\-•0-9]+)/i);
  if (coordMatch) {
    coordinadora = coordMatch[1].replace(/\s+/g, " ").trim();
    if (/^(?:encargad[oa]|responsable|docente|profesor[a]?)$/i.test(coordinadora)) coordinadora = "";
  }

  const celMatch = full.match(/(?:celular|tel[eé]fono|m[oó]vil|whatsapp|cel|tel)[:\s]*([+0-9\s\-()]{7,20})/i) ||
    full.match(/\b(?:\+?57\s*)?3[0-9]{2}[\s\-]?[0-9]{3}[\s\-]?[0-9]{4}\b/);
  let celular = celMatch ? (celMatch[1] || celMatch[0]).replace(/[^0-9+]/g, "") : "";

  let horario = "";
  const horMatch = full.match(/(?:horario[s]?|d[ií]as\s*(?:y\s*horas?)?|clases?|sesiones?)\s*[:=]\s*([^\n\r]+)/i);
  if (horMatch) {
    horario = horMatch[1].trim();
  } else {
    const daysLine = full.match(/(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)[^.\n\r]+(?:de\s+\d{1,2}|\d{1,2}:\d{2})/i);
    if (daysLine) horario = daysLine[0].trim();
  }

  let salones = "";
  const salMatch = full.match(/(?:sal[oó]n|aula|espacio|ubicaci[oó]n|laboratorio|enlace|link|teams|zoom|sala)\s*[:=]\s*([^\n\r]+)/i);
  if (salMatch) {
    salones = salMatch[1].trim();
  } else {
    const inlineSalon = full.match(/(?:en\s+el\s+|sal[oó]n\s+)(sal[oó]n\s+[0-9A-Za-z]+|aula\s+[0-9A-Za-z]+|lab(?:oratorio)?\s+[0-9A-Za-z]+)/i);
    if (inlineSalon) salones = inlineSalon[1].trim();
  }

  return {
    nombre: nombre,
    nrc: nrc,
    modalidad: modalidad,
    tipo: tipo,
    coordinadora: coordinadora,
    celular: celular,
    fechaInicio: fechaInicio,
    fechaFin: fechaFin,
    horario: horario,
    salones: salones,
    mes: mes || "Enero",
    observaciones: "Extraído automáticamente de correo"
  };
}

/**
 * Función de prueba: Crea manualmente un curso de prueba en Google Drive
 * Selecciona esta función arriba y haz clic en "Ejecutar" para verificar que se creen las carpetas.
 */
function probarCreacionDriveManual() {
  const testProg = {
    programa: "Curso de Prueba - Inteligencia Artificial y Datos",
    nrc: "98765",
    mes: "Mayo",
    coordinadora: "Dra. Laura Gómez",
    celular: "3001234567",
    modalidad: "Presencial",
    salon: "Salón CEC 302",
    horario: "Martes y Jueves de 6:00 pm a 9:00 pm",
    fecha_inicio: "2026-05-12",
    fecha_fin: "2026-05-28",
    analisis_horario: {
      fechas_sesion: [
        "2026-05-12", "2026-05-14", "2026-05-19", "2026-05-21",
        "2026-05-26", "2026-05-28"
      ]
    }
  };

  const resultado = crearEstructuraDriveYAsistencia(testProg);
  Logger.log("¡ÉXITO CREANDO EN GOOGLE DRIVE!");
  Logger.log("Carpeta Drive URL: " + resultado.folderUrl);
  Logger.log("Planilla Asistencia URL: " + resultado.sheetUrl);
}

// =============================================================================
// 8. UTILIDADES Y LIMPIEZA DE ACTIVADORES
// =============================================================================

/**
 * Elimina cualquier activador minutero obsoleto de 1 minuto que estuviera corriendo
 * Selecciona esta función arriba y haz clic en "Ejecutar" una sola vez para limpiar triggers viejos.
 */
function eliminarActivadoresMinuterosViejos() {
  const triggers = ScriptApp.getProjectTriggers();
  let count = 0;
  for (let i = 0; i < triggers.length; i++) {
    const func = triggers[i].getHandlerFunction();
    if (func === "revisarCorreosAperturaCurso" || func === "sincronizarCorreosConFirebase" || func === "activarGmailPushWatch") {
      ScriptApp.deleteTrigger(triggers[i]);
      count++;
    }
  }
  Logger.log("✓ Se eliminaron " + count + " activadores anteriores.");
}

/**
 * (Opcional) Crea un activador tranquilo cada 30 minutos como respaldo para cuando tu PC esté apagado
 */
function configurarActivadorRespaldo30Min() {
  eliminarActivadoresMinuterosViejos();
  ScriptApp.newTrigger("revisarCorreosAperturaCurso")
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log("✓ Activador de respaldo configurado cada 30 minutos.");
}
