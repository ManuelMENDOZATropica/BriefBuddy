// api/chat/stream.js
import OpenAI from "openai";

// === Prompt & helpers (idénticos a tu server local) ===
const SYSTEM_PROMPT = `
Eres **BRIEF BUDDY @TRÓPICA**, un Project Manager creativo especializado en briefs publicitarios y de comunicación.
- Personalidad: cálido, empático, cercano, profesional. Estilo: guía paso a paso, claridad, simplicidad, sin jerga.
- Propósito: construir briefs claros y accionables para creatividad, publicidad y tecnología.
- Secuencia fija: Contacto → Alcance → Objetivos → Audiencia → Marca → Entregables → Logística → Extras.
- Dinámica por turno: (1) reconoce lo recibido; (2) mini-resumen en bullets de la sección actual (si aplica); (3) **una sola pregunta** para la **siguiente** sección.
- Validaciones: emails correctos, fechas realistas, links válidos, compatibilidad tiempos/entregables.
- Reglas: no asumas presupuestos ni fechas; no avances si faltan datos críticos; evita preguntas genéricas;
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
const transcriptText = (messages=[]) => messages.map(m => m?.content || "").join("\n");
const sectionCompleted = (s, txt) => { try { return detectors[s]?.(txt) || false; } catch { return false; } };
const nextSection = (txt) => { for (const s of SECTIONS) if (!sectionCompleted(s, txt)) return s; return "Extras"; };
function buildStateNudge(messages=[]) {
  const txt = transcriptText(messages);
  const current = nextSection(txt);
  const idx = SECTIONS.indexOf(current);
  const prev = idx > 0 ? SECTIONS[idx - 1] : null;

  const progress = prev
    ? `Sección **${prev}** completada. Agradece lo recibido brevemente. Ahora avanza a **${current}**.`
    : `Iniciemos en **${current}**. Pide los datos necesarios sin preguntar si desea comenzar.`;

  const ask = `Acción:
- Mini-resumen en bullets solo si ya hay datos válidos de la sección actual.
- Formula **una sola pregunta** clara y positiva para **${current}**.
- Nunca digas "no has compartido información" ni "¿quieres comenzar?". Avanza siempre.`;

  const suggested = `Pregunta sugerida: "${NEXT_QUESTION[current] || "Continuemos con la siguiente sección, ¿de acuerdo?"}"`;

  return `${progress}\n${ask}\n${suggested}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") { res.status(405).send("Method Not Allowed"); return; }

    // Parse historial desde query (?messages=...)
    let messages = [];
    if (req.query.messages) {
      try { messages = JSON.parse(String(req.query.messages)); }
      catch { messages = []; }
    }
    const isWelcome = messages.length === 0;

    // Cabeceras SSE
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    // Cierre limpio
    req.on("close", () => { try { res.end(); } catch {} });

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const stateNudge = isWelcome
      ? `Saluda (2–3 líneas), explica brevemente qué harás y pasa DIRECTO a **Contacto** con una sola pregunta (nombre y correo). No preguntes si desea comenzar ni remarques ausencia.`
      : buildStateNudge(messages);

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      temperature: 0.7,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: stateNudge },
        ...messages,
      ],
    });

    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) res.write(`data: ${JSON.stringify(delta)}\n\n`);
    }
    res.write("event: done\ndata: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error(err);
    try {
      res.write(`event: error\ndata: ${JSON.stringify("OpenAI error")}\n\n`);
      res.end();
    } catch {}
  }
}
