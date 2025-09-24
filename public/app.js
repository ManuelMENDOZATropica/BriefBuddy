// public/app.js
const log = document.getElementById("log");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const resetBtn = document.getElementById("reset");
const fileInput = document.getElementById("fileInput");

try {
  localStorage.removeItem("briefBuddyHistory");
  sessionStorage.removeItem("briefBuddyHistory");
} catch {}

const history = [];
const MAX_TURNS = 20;

let selectedFile = null;        // Se conserva para /api/finalize
let seedUploaded = false;       // Evita reanalizar la misma semilla en cada turno
let finalizeTriggered = false;  // Evita doble finalize

// Comentarios ocultos que envía el asistente
const PROGRESS_RE = /<!--\s*PROGRESS\s*:\s*(\{[\s\S]*?\})\s*-->/i;
const AUTO_RE     = /<!--\s*AUTO_FINALIZE\s*:\s*(\{[\s\S]*?\})\s*-->/i;

/* ------------------------------ UI helpers ------------------------------ */
function addUserBubble(text) {
  const div = document.createElement("div");
  div.className = "bubble user";
  div.textContent = text;
  log.prepend(div);
}
function addBotContainer() {
  const div = document.createElement("div");
  div.className = "bubble bot";
  div.innerHTML = "";
  log.prepend(div);
  return div;
}
function renderMarkdown(el, md) {
  const cleaned = (md || "").replace(/\n{3,}/g, "\n\n");
  el.innerHTML = marked.parse(cleaned);
}
function trimHistory() {
  const start = Math.max(0, history.length - MAX_TURNS);
  return history.slice(start);
}
function showWarning(msg) {
  renderMarkdown(addBotContainer(), `⚠️ ${msg}`);
}
function showInfo(msg) {
  renderMarkdown(addBotContainer(), msg);
}

/* ------------------------------ Archivo ------------------------------ */
fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files[0] || null;
  seedUploaded = false;
});

/* ------------------------------ Auto-finalize ------------------------------ */
async function finalizeBriefAuto(meta = {}) {
  if (finalizeTriggered) return;
  finalizeTriggered = true;

  showInfo("⏳ Generando carpeta de proyecto y documentos en Drive…");

  try {
    const fd = new FormData();
    if (selectedFile) fd.append("file", selectedFile);
    fd.append("messages", JSON.stringify(trimHistory()));
    if (meta.category) fd.append("category", meta.category);
    if (meta.client) fd.append("client", meta.client);

    const r = await fetch("/api/finalize", { method: "POST", body: fd });
    const data = await r.json();

    if (!r.ok) throw new Error(data?.error || `${r.status} ${r.statusText}`);

    renderMarkdown(
      addBotContainer(),
      `
**Proyecto creado:** [${data.projectFolder.name}](${data.projectFolder.link})  
**Brief:** [${data.briefDoc.name}](${data.briefDoc.link})  
**State of Art:** [doc](${data.stateOfArt.docLink}) · [carpeta](${data.stateOfArt.folderLink})
${data.file ? `\n**Archivo:** [${data.file.name}](${data.file.link})` : ""}
      `.trim()
    );
  } catch (e) {
    showWarning("No pude finalizar automáticamente: " + (e.message || e));
    finalizeTriggered = false; // permite reintento si lo deseas
  }
}

/* ------------------------------ Streaming con detección de comentarios ------------------------------ */
function streamReply(messages) {
  const qs = encodeURIComponent(JSON.stringify(messages));
  const es = new EventSource(`/api/chat/stream?messages=${qs}`);

  const botDiv = addBotContainer();
  let accum = "";
  let scheduled = false;

  es.onmessage = (e) => {
    try {
      const chunk = JSON.parse(e.data);
      accum += chunk;

      // Detecta comentarios ocultos (progreso / auto-finalize)
      const mProg = accum.match(PROGRESS_RE);
      if (mProg) {
        // Ejemplo opcional:
        // const progress = JSON.parse(mProg[1]);
        // console.log('PROGRESS', progress);
      }

      const mAuto = accum.match(AUTO_RE);
      if (mAuto && !finalizeTriggered) {
        let meta = {};
        try { meta = JSON.parse(mAuto[1]); } catch {}
        finalizeBriefAuto(meta);
      }

      // Render “en vivo”
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          renderMarkdown(botDiv, accum);
          log.scrollTop = log.scrollHeight;
        });
      }
    } catch {}
  };

  es.addEventListener("done", () => {
    // render final por si faltaba un fragmento
    renderMarkdown(botDiv, accum);
    history.push({ role: "assistant", content: accum });
    sendBtn.disabled = false;
    input.focus();
    es.close();
  });

  es.addEventListener("error", () => {
    sendBtn.disabled = false;
    input.focus();
    es.close();
  });
}

/* ------------------------------ Upload seed (sin Drive) ------------------------------ */
async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch("/api/upload", { method: "POST", body: fd });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && (data.error || data.detail)) || `${r.status} ${r.statusText}`);
  return data;
}

/* ------------------------------ Enviar ------------------------------ */
async function send() {
  const q = input.value.trim();
  const shouldUploadSeed = selectedFile && !seedUploaded;

  if (!q && !shouldUploadSeed) return;

  let pendingUserEntry = null;

  if (q) {
    addUserBubble(q);
    pendingUserEntry = { role: "user", content: q };
    history.push(pendingUserEntry);
  }

  if (shouldUploadSeed) {
    const file = selectedFile;
    // Subida para semilla (no crea nada en Drive)
    addUserBubble(`📎 Analizando **${file.name}**…`);
    try {
      const data = await uploadFile(file);
      const b = data.brief || {};
      const faltan = Array.isArray(b.faltantes) ? b.faltantes : [];
      const next = b.siguiente_pregunta || "¿Seguimos con la siguiente sección?";

      const seed = `
**Vista previa del archivo analizado.**
- Alcance: ${b.alcance || "—"}
- Objetivos: ${Array.isArray(b.objetivos) && b.objetivos.length ? b.objetivos.join(", ") : "—"}
- Audiencia: ${b.audiencia?.descripcion || "—"}
- Entregables: ${Array.isArray(b.entregables) && b.entregables.length ? b.entregables.join(", ") : "—"}
- Fechas: ${Array.isArray(b.logistica?.fechas) && b.logistica.fechas.length ? b.logistica.fechas.join(", ") : "—"}

**Faltantes:** ${faltan.length ? faltan.join(", ") : "—"}

${next}`.trim();

      if (pendingUserEntry) {
        pendingUserEntry.content = [pendingUserEntry.content, seed]
          .filter(Boolean)
          .join("\n\n");
      } else {
        history.push({ role: "user", content: seed });
      }
      renderMarkdown(addBotContainer(), seed);
      seedUploaded = true;
      if (fileInput) fileInput.value = "";
    } catch (err) {
      showWarning(`No pude procesar el archivo. Detalle: ${err?.message || err}`);
    }
  }

  input.value = "";
  sendBtn.disabled = true;
  streamReply(trimHistory());
}

/* ------------------------------ Welcome / Reset ------------------------------ */
function showWelcome() {
  // El saludo inicial lo envía el backend vía SSE. Dejamos el snippet anterior
  // comentado por si se quiere mostrar un mensaje estático antes de la respuesta
  // en streaming.
  streamReply([]);
}

function resetConversation() {
  log.innerHTML = "";
  history.length = 0;
  finalizeTriggered = false;
  selectedFile = null;
  seedUploaded = false;
  if (fileInput) fileInput.value = "";
  showWelcome();
  input.focus();
}

/* ------------------------------ Bindings ------------------------------ */
sendBtn.onclick = send;
if (resetBtn) resetBtn.onclick = resetConversation;

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    send();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  showWelcome();
  input.focus();
});
