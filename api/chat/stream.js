// api/chat/stream.js
import OpenAI from "openai";

export const config = {
  runtime: "edge", // 👈 Forzamos Edge Runtime (usa Web Streams, no bufferiza)
};

/* ───────────────────────────── Prompt base ───────────────────────────── */
const SYSTEM_PROMPT = `
Eres **BRIEF BUDDY @TRÓPICA**, un Project Manager creativo para briefs publicitarios/tecnológicos.
Estilo: cálido, claro, una sola pregunta por turno. Formato SIEMPRE en Markdown (sin bloques de código salvo necesidad).

Flujo de secciones (en orden):
Contacto → Alcance → Objetivos → Audiencia → Marca → Entregables → Logística → Extras.

Validaciones:
- Emails válidos, fechas realistas, links válidos.
- No asumas presupuesto ni fechas si no están.
- No avances si faltan datos críticos de la sección actual, pero mantén una sola pregunta.
- **No repitas literalmente la misma pregunta si el usuario aún no ha respondido; reformula de manera más específica o con un ejemplo.**

PROTOCOLO (IMPORTANTE):
- Al FINAL de **cada** respuesta, agrega un comentario HTML oculto con el progreso:
  <!-- PROGRESS: {"complete": false, "missing": ["Contacto","Alcance", ...]} -->
- Cuando el brief esté COMPLETO (sin faltantes), agrega TAMBIÉN:
  <!-- AUTO_FINALIZE: {"category":"<Videos|Campaña|Branding|Web|Evento|Proyecto>", "client":"<NombreCliente>"} -->
- No expliques estos comentarios. Van ocultos, fuera del contenido visible.

ARRANQUE:
- En la primera respuesta: saluda (2–3 líneas), explica qué harás y DI:
  “Si tienes un documento del proyecto (**PDF** o **DOCX**), adjúntalo ahora y lo usaré para prellenar el brief”.
- Luego pregunta por **Contacto** (nombre y correo) en una sola pregunta.
`;

/* ───────────────────────────── Secciones y heurísticas ───────────────────────────── */
const SECTIONS = [
  "Contacto",
  "Alcance",
  "Objetivos",
  "Audiencia",
  "Marca",
  "Entregables",
  "Logística",
  "Extras",
];

const NEXT_QUESTION = {
  Contacto: "¿Me compartes tu nombre completo y correo?",
  Alcance:
    "En 1–2 frases, ¿cómo describes el proyecto y qué piezas esperas (p. ej., video, KV, sitio, banners)?",
  Objetivos:
    "¿Qué objetivos o KPIs quieres lograr (awareness, leads, ventas, engagement) y cómo medirías el éxito?",
  Audiencia:
    "¿Quién es la audiencia (edad, ubicación, intereses) y en qué canales suelen estar?",
  Marca:
    "¿Qué debemos saber de la marca (tono, valores, referencias, guía/brandbook o links)?",
  Entregables:
    "Lista los entregables concretos con formatos o versiones (si aplica).",
  Logística:
    "Fechas clave y dependencias: ¿hay deadline, presupuesto tentativo, aprobaciones o restricciones?",
  Extras:
    "¿Hay riesgos, supuestos, referencias o notas adicionales que debamos considerar?",
};

const detectors = {
  Contacto: (t) =>
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(t) &&
    /\b([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,})\b/.test(t),
  Alcance: (t) =>
    /\b(alcance|piezas?|entregables?|video|kv|banners?|sitio|landing|app|spot|ooh|social|camp[aá]ña)\b/i.test(t) ||
    t.split(/\s+/).length > 20,
  Objetivos: (t) =>
    /\b(objetiv|kpi|meta|resultado|conversi[oó]n|awareness|engagement|ventas)\b/i.test(t),
  Audiencia: (t) =>
    /\b(audiencia|target|p[uú]blico|segmento|demogr[aá]fico|buyer|persona|clientes?)\b/i.test(t),
  Marca: (t) =>
    /\b(marca|brand|tono|valores|gu[ií]a de marca|brandbook|manual de marca|lineamientos)\b/i.test(t),
  Entregables: (t) => /\b(entregables?|piezas?|formatos?|resoluciones?|versiones?)\b/i.test(t),
  Logística: (t) =>
    /\b(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{4}-\d{2}-\d{2}|hoy|ma[ñn]ana|semana|mes|deadline|fecha|entrega|presupuesto|budget|aprobaciones?|stakeholders?)\b/i.test(
      t
    ),
  Extras: (t) => /\b(riesgos?|supuestos?|referencias?|links?|notas?|extras?)\b/i.test(t),
};

/* ───────────────────────────── Utils ───────────────────────────── */
const PREVIEW_LABELS = [...SECTIONS, "Fechas"];
const SECTION_LABEL_PATTERN = PREVIEW_LABELS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const SEED_LINE_RE = new RegExp(`^-\\s*(?:${SECTION_LABEL_PATTERN})\\s*:\\s*(.*)$`, "i");

function normalizeUserText(raw = "") {
  if (!raw) return "";

  const lines = raw.split(/\r?\n/);
  const cleaned = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      cleaned.push(line);
      continue;
    }

    if (/^\*\*Vista previa del archivo analizado\.\*\*/i.test(trimmed)) {
      continue;
    }

    if (/^\*\*Faltantes:\*\*/i.test(trimmed)) {
      continue;
    }

    const match = trimmed.match(SEED_LINE_RE);
    if (match) {
      const value = match[1].trim();
      const collapsed = value.replace(/\s+/g, "");
      if (collapsed && !/^[-—]+$/.test(collapsed)) {
        cleaned.push(value);
      }
      continue;
    }

    cleaned.push(line);
  }

  return cleaned.join("\n");
}

const textFrom = (messages = [], roles = ["user"]) =>
  normalizeUserText(
    messages
      .filter((m) => roles.includes(m?.role))
      .map((m) => m?.content || "")
      .join("\n")
  );

const sectionCompleted = (s, userTxt) => {
  try {
    return detectors[s]?.(userTxt) || false;
  } catch {
    return false;
  }
};

function missingSections(messages = []) {
  const userTxt = textFrom(messages, ["user"]);
  return SECTIONS.filter((s) => !sectionCompleted(s, userTxt));
}

function nextSection(messages = []) {
  const miss = missingSections(messages);
  return miss.length ? miss[0] : "Extras";
}

function guessCategoryFrom(usersTxt = "") {
  const t = usersTxt.toLowerCase();
  if (/\b(spot|video|mp4|film)\b/.test(t)) return "Videos";
  if (/\b(campa[ñn]a|campaign)\b/.test(t)) return "Campaña";
  if (/\b(branding|marca)\b/.test(t)) return "Branding";
  if (/\b(web|sitio|landing)\b/.test(t)) return "Web";
  if (/\b(evento|event)\b/.test(t)) return "Evento";
  return "Proyecto";
}
function titleCase(s = "") {
  return s
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
function guessClientFrom(usersTxt = "") {
  const m = usersTxt.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+)\.[A-Z]{2,}/i);
  if (m?.[1]) {
    const dom = (m[1].split(".")[0] || "").slice(0, 64);
    if (dom) return titleCase(dom);
  }
  const m2 = usersTxt.match(/(?:Cliente|Empresa)\s*:\s*([^\n]+)/i);
  if (m2?.[1]) {
    const cleaned = m2[1]
      .replace(/\b(S\.?A\.?( de C\.?V\.?)?|SAS|SA|Ltd\.?|LLC|Studio|Estudio)\b/gi, "")
      .replace(/[.,\s]+$/g, "")
      .trim();
    if (cleaned) return titleCase(cleaned);
  }
  return "Cliente";
}

function buildStateNudge(messages = []) {
  const usersTxt = textFrom(messages, ["user"]);
  const current = nextSection(messages);
  const idx = SECTIONS.indexOf(current);
  const prev = idx > 0 ? SECTIONS[idx - 1] : null;

  const miss = missingSections(messages);
  const complete = miss.length === 0;

  const cat = guessCategoryFrom(usersTxt);
  const cli = guessClientFrom(usersTxt);

  const progressLine = prev
    ? `Sección **${prev}** completada. Ahora avanza a **${current}**.`
    : `Empecemos en **${current}**.`;

  const ask = `Acción:
- Si ya hay datos válidos de la sección actual, haz un mini-resumen en bullets.
- Formula **una sola pregunta** clara para **${current}**.
- Si la pregunta anterior fue sobre **${current}** y no hubo nueva información del usuario, NO la repitas literal; reformúlala con un ejemplo o con campos concretos.`;

  const suggested = `Pregunta sugerida: "${NEXT_QUESTION[current] || "¿Seguimos con la siguiente sección?"}"`;

  const commentsProtocol = `
Al final de tu respuesta, agrega EXACTAMENTE:
<!-- PROGRESS: ${JSON.stringify({ complete, missing: miss })} -->
${complete ? `<!-- AUTO_FINALIZE: ${JSON.stringify({ category: cat, client: cli })} -->` : ""}`.trim();

  return `${progressLine}\n${ask}\n${suggested}\n\n${commentsProtocol}`;
}

export { SECTIONS, NEXT_QUESTION, detectors, missingSections, nextSection, guessCategoryFrom, guessClientFrom, buildStateNudge };

/* ───────────────────────────── Handler Edge SSE ───────────────────────────── */
export default async function handler(req) {
  try {
    const { searchParams } = new URL(req.url);
    let messages = [];
    const q = searchParams.get("messages");
    if (q) {
      try {
        messages = JSON.parse(q);
      } catch {
        messages = [];
      }
    }

    const isWelcome = messages.filter((m) => m?.role === "user").length === 0;

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const stateNudge = isWelcome
      ? `
Saluda (2–3 líneas), explica brevemente qué harás y di:
“Si tienes un documento del proyecto (PDF o DOCX), adjúntalo ahora y lo usaré para prellenar el brief”.
Pregunta por **Contacto** (nombre y correo).
<!-- PROGRESS: ${JSON.stringify({ complete: false, missing: SECTIONS })} -->
`.trim()
      : buildStateNudge(messages);

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      temperature: 0.6,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: stateNudge },
        ...messages,
      ],
    });

    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const delta = chunk?.choices?.[0]?.delta?.content;
            if (delta) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta)}\n\n`));
            }
          }
          controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
        } catch (err) {
          console.error(err);
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify("OpenAI error")}\n\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    console.error(err);
    return new Response("Error", { status: 500 });
  }
}
