const log = document.getElementById("log");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const resetBtn = document.getElementById("reset");
const fileInput = document.getElementById("fileInput");

// valla de seguridad por si quedaron datos de versiones previas
try {
  localStorage.removeItem("briefBuddyHistory");
  sessionStorage.removeItem("briefBuddyHistory");
} catch {}

const history = [];         // SOLO memoria
const MAX_TURNS = 20;       // para no saturar la URL del SSE

/* ------------------------------ UI helpers ------------------------------ */
function addUserBubble(text) {
  const div = document.createElement("div");
  div.className = "bubble user";
  div.textContent = text;
  log.prepend(div); // mostramos arriba
}

function addBotContainer() {
  const div = document.createElement("div");
  div.className = "bubble bot";
  div.innerHTML = "";
  log.prepend(div); // mostramos arriba
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

/* ------------------------------ Streaming ------------------------------ */
function streamReply(messages) {
  const qs = encodeURIComponent(JSON.stringify(messages));
  const es = new EventSource(`/api/chat/stream?messages=${qs}`);

  const botDiv = addBotContainer();
  let accum = "";
  let scheduled = false;

  function flush() {
    scheduled = false;
    renderMarkdown(botDiv, accum);
    log.scrollTop = log.scrollHeight;
  }

  es.onmessage = (e) => {
    try {
      const chunk = JSON.parse(e.data);
      accum += chunk;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    } catch {}
  };

  es.addEventListener("done", () => {
    flush();
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

/* ------------------------------ Upload file ------------------------------ */
async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);

  const r = await fetch("/api/upload", { method: "POST", body: fd });

  // Intenta parsear JSON siempre (incluso en error)
  let data = null;
  try {
    data = await r.json();
  } catch {
    data = null;
  }

  if (!r.ok) {
    const detail = (data && (data.error || data.detail)) || `${r.status} ${r.statusText}`;
    const e = new Error(`upload failed: ${detail}`);
    e.status = r.status;
    e.data = data;
    throw e;
  }

  return data || {};
}

/* ------------------------------ Send (texto + archivo) ------------------------------ */
async function send() {
  const q = input.value.trim();
  const file = fileInput.files[0];

  // si no hay nada que enviar, no hacemos nada
  if (!q && !file) return;

  // muestra mensaje del usuario si hay texto
  if (q) {
    addUserBubble(q);
    history.push({ role: "user", content: q });
  }

  // si hay archivo, súbelo y “siembra” un resumen en la conversación
  if (file) {
    addUserBubble(`📎 Subiendo **${file.name}**…`);
    try {
      const data = await uploadFile(file);
      console.log("UPLOAD RESULT", data);

      const b = data.brief || {};
      const faltan = Array.isArray(b.faltantes) ? b.faltantes : [];
      const next = b.siguiente_pregunta || "¿Seguimos con la siguiente sección?";

      // Si no hubo JSON pero sí texto, informa al usuario
      if (!b || Object.keys(b).length === 0) {
        const seedNoJson = `
**Archivo en Drive:** [${data?.drive?.name || file.name}](${data?.drive?.link || "#"})

No pude generar el JSON del brief, pero sí extraje texto. Aquí una vista previa:

\`\`\`
${(data?.textPreview || "").trim() || "—"}
\`\`\`

Continuemos con preguntas para completar el brief.
        `.trim();
        history.push({ role: "assistant", content: seedNoJson });
        renderMarkdown(addBotContainer(), seedNoJson);
      } else {
        const seed = `
**Archivo en Drive:** [${data.drive.name}](${data.drive.link})

**Resumen preliminar:**
- Alcance: ${b.alcance || "—"}
- Objetivos: ${Array.isArray(b.objetivos) && b.objetivos.length ? b.objetivos.join(", ") : "—"}
- Audiencia: ${b.audiencia?.descripcion || "—"}
- Entregables: ${Array.isArray(b.entregables) && b.entregables.length ? b.entregables.join(", ") : "—"}
- Fechas: ${Array.isArray(b.logistica?.fechas) && b.logistica.fechas.length ? b.logistica.fechas.join(", ") : "—"}

**Faltantes:** ${faltan.length ? faltan.join(", ") : "—"}

${next}`.trim();

        history.push({ role: "assistant", content: seed });
        renderMarkdown(addBotContainer(), seed);
      }
    } catch (err) {
      console.error("UPLOAD ERROR", err);
      const detail = err?.data?.error || err?.message || "Error desconocido";
      showWarning(`No pude procesar el archivo. Detalle: ${detail}\n\nContinuemos con preguntas.`);
    }

    fileInput.value = ""; // limpia el input de archivo
  }

  // limpia input de texto y lanza el turno al backend
  input.value = "";
  sendBtn.disabled = true;
  streamReply(trimHistory());
}

/* ------------------------------ Welcome / Reset ------------------------------ */
function showWelcome() { streamReply([]); }

function resetConversation() {
  log.innerHTML = "";
  history.length = 0;
  showWelcome();
  input.focus();
}

/* ------------------------------ Bindings ------------------------------ */
sendBtn.onclick = send;
if (resetBtn) resetBtn.onclick = resetConversation;

// Shift+Enter = enviar  |  Enter = newline
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
