const log = document.getElementById("log");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const resetBtn = document.getElementById("reset");

// valla de seguridad por si quedaron datos de versiones previas
try {
  localStorage.removeItem("briefBuddyHistory");
  sessionStorage.removeItem("briefBuddyHistory");
} catch {}

const history = [];         // SOLO memoria
const MAX_TURNS = 20;       // para no saturar la URL del SSE

function addUserBubble(text) {
  const div = document.createElement("div");
  div.className = "bubble user";
  div.textContent = text;
  // insertamos arriba
  log.prepend(div);
}

function addBotContainer() {
  const div = document.createElement("div");
  div.className = "bubble bot";
  div.innerHTML = "";
  // insertamos arriba
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

// bienvenida (historial vacío → server saluda y pregunta Contacto)
function showWelcome() { streamReply([]); }

function send() {
  const q = input.value.trim();
  if (!q) return;
  addUserBubble(q);
  input.value = "";
  sendBtn.disabled = true;

  history.push({ role: "user", content: q });
  streamReply(trimHistory());
}
function resetConversation() {
  log.innerHTML = "";
  history.length = 0;
  showWelcome();
  input.focus();
}

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
