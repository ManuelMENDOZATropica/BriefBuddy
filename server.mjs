import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));


const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =============== PROMPT BASE =============== */
const SYSTEM_PROMPT = `
Eres **BRIEF BUDDY @TRÓPICA**, un Project Manager creativo especializado en briefs publicitarios y de comunicación.

- Personalidad: cálido, empático, cercano, profesional. Estilo: guía paso a paso, claridad, simplicidad, sin jerga.
- Propósito: construir briefs claros y accionables para creatividad, publicidad y tecnología.
- Secuencia fija: Contacto → Alcance → Objetivos → Audiencia → Marca → Entregables → Logística → Extras.
- Dinámica por turno: (1) reconoce lo recibido; (2) mini-resumen en bullets de la sección actual; (3) **una sola pregunta** para la **siguiente** sección.
- Validaciones: emails correctos, fechas realistas, links válidos, compatibilidad tiempos/entregables.
- Reglas: no asumas presupuestos ni fechas; no avances si faltan datos críticos; evita preguntas genéricas.
- **Formato SIEMPRE en Markdown** (negritas, bullets, saltos de línea). Evita bloques de código salvo que sea imprescindible.
`;

const SECTIONS = ["Contacto","Alcance","Objetivos","Audiencia","Marca","Entregables","Logística","Extras"];
const NEXT_QUESTION = {
  Contacto: "¿Me compartes tu nombre completo y correo?",
  Alcance: "En 1–2 frases, ¿cómo describes el proyecto y qué piezas esperas (p. ej., video, KV, sitio, banners)?",
  Objetivos: "¿Qué objetivos o KPIs quieres lograr (awareness, leads, ventas, engagement) y cómo medirías el éxito?",
  Audiencia: "¿Quién es la audiencia (edad, ubicación, intereses) y en qué canales suelen estar?",
  Marca: "¿Qué debemos saber de la marca (tono, valores, referencias, guía/brandbook o links)?",
  Entregables: "Lista los entregables concretos con formatos o versiones (si aplica).",
  Logística: "Fechas clave y dependencias: ¿hay deadline, presupuesto tentativo, aprobaciones o restricciones?",
  Extras: "¿Hay riesgos, supuestos, referencias o notas adicionales que debamos considerar?"
};

/* =============== HEURÍSTICAS LIGERAS =============== */
const detectors = {
  Contacto: (t) => /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(t) && /\b([A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,})\b/.test(t),
  Alcance: (t) => /\b(alcance|piezas?|entregables?|video|kv|banners?|sitio|landing|app|spot|ooh|social|camp[aá]ña)\b/i.test(t) || t.split(/\s+/).length > 20,
  Objetivos: (t) => /\b(objetiv|kpi|meta|resultado|conversi[oó]n|awareness|engagement|ventas)\b/i.test(t),
  Audiencia: (t) => /\b(audiencia|target|p[uú]blico|segmento|demogr[aá]fico|buyer|persona|clientes?)\b/i.test(t),
  Marca: (t) => /\b(marca|brand|tono|valores|gu[ií]a de marca|brandbook|manual de marca|lineamientos)\b/i.test(t),
  Entregables: (t) => /\b(entregables?|piezas?|formatos?|resoluciones?|versiones?)\b/i.test(t),
  Logística: (t) => /\b(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{4}-\d{2}-\d{2}|hoy|ma[ñn]ana|semana|mes|deadline|fecha|entrega|presupuesto|budget|aprobaciones?|stakeholders?)\b/i.test(t),
  Extras: (t) => /\b(riesgos?|supuestos?|referencias?|links?|notas?|extras?)\b/i.test(t),
};

function transcriptText(messages = []) {
  return messages.map(m => m?.content || "").join("\n");
}
function sectionCompleted(section, txt) {
  try { return detectors[section]?.(txt) || false; } catch { return false; }
}
function nextSection(txt) {
  for (const s of SECTIONS) if (!sectionCompleted(s, txt)) return s;
  return "Extras";
}
function buildStateNudge(messages = []) {
  const txt = transcriptText(messages);
  const current = nextSection(txt);
  const idx = SECTIONS.indexOf(current);
  const prev = idx > 0 ? SECTIONS[idx - 1] : null;

  let progress;
  if (prev) {
    // Sección anterior completada → confirma en positivo
    progress = `Sección **${prev}** completada. Reconoce y agradece lo recibido brevemente. Ahora avanza a **${current}**.`;
  } else {
    // Primera sección → pide directo
    progress = `Iniciemos en **${current}**. Pide los datos necesarios de manera positiva, sin preguntar si desea comenzar.`;
  }

  const ask = `Acción:
- Haz un mini-resumen en bullets SOLO si ya hay datos válidos de la sección actual.
- Formula **una sola pregunta** clara y positiva para **${current}**.
- Nunca digas frases como "no has compartido información" o "¿quieres comenzar?".
- Si falta algo, pídelo de forma cordial: "¿Podrías compartirme tu correo?" en lugar de remarcar ausencia.`;

  const suggested = `Pregunta sugerida: "${NEXT_QUESTION[current] || "Continuemos con la siguiente sección, ¿de acuerdo?"}"`;

  return `${progress}\n${ask}\n${suggested}`;
}

/* =============== STREAMING (SSE) =============== */
/** 
 * GET /api/chat/stream?messages=<json-urlencoded>
 * - messages: array JSON de {role, content} con todo el historial (user/assistant)
 * - Si no viene nada, se asume bienvenida (Contacto).
 */
app.get("/api/chat/stream", async (req, res) => {
  try {
    // Recuperar historial desde query (para poder usar EventSource)
    let messages = [];
    if (req.query.messages) {
      try { messages = JSON.parse(String(req.query.messages)); }
      catch { messages = []; }
    }

    // Si no hay historial, producir bienvenida dirigida a Contacto
    const isWelcome = messages.length === 0;

    const sseHeaders = {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    };
    Object.entries(sseHeaders).forEach(([k, v]) => res.setHeader(k, v));
    res.flushHeaders?.();

    // Nudge de estado (flujo secuencial)
    const stateNudge = isWelcome
  ? `Saluda de manera cálida (2–3 líneas) y explica qué harás. 
     Luego pasa DIRECTO a la sección **Contacto** con una sola pregunta positiva (nombre y correo).
     No uses frases como "¿quieres comenzar?" ni remarques que falta información.`
  : buildStateNudge(messages);


    // Construir mensajes para el modelo (manteniendo historial)
    const payload = {
      model: "gpt-4o-mini",
      stream: true,
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: stateNudge },
        ...messages,
      ],
    };

    const stream = await openai.chat.completions.create(payload);

    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) res.write(`data: ${JSON.stringify(delta)}\n\n`);
    }
    res.write("event: done\ndata: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error(err);
    res.write(`event: error\ndata: ${JSON.stringify("OpenAI error")}\n\n`);
    res.end();
  }
});

// Estáticos
app.use(express.static("public"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`→ http://localhost:${port}`));
