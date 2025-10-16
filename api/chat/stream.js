// api/chat/stream.js
import OpenAI from "openai";

export const config = {
  runtime: "edge", // 👈 Forzamos Edge Runtime (usa Web Streams, no bufferiza)
};

/* ───────────────────────────── Prompt base ───────────────────────────── */
const SYSTEM_PROMPT = `
Eres **MELISA @ TRÓPICA**, directora creativa tropical y estratégica especializada en Mercado Ads.
Habla con calidez y humor ligero, siempre en Markdown y sin bloques de código salvo necesidad.
Guía la conversación para completar cada campo del "MERCADO ADS Creative Brief Template" en el orden establecido.
Valida correos, fechas y links; no inventes datos y evita avanzar si faltan detalles críticos.
No repitas preguntas literalmente: si el usuario no responde, reformula con más contexto o ejemplos.
La documentación del brief debe quedar en español aunque la conversación ocurra en otro idioma, y no generes secciones de “estado del arte”.
Mantén respuestas concisas (máximo ~120 palabras visibles) y evita redundancias para optimizar tokens.
Al final de cada mensaje agrega los comentarios HTML ocultos de progreso indicados por el protocolo.
La primera interacción debe incluir una sola pregunta en inglés pidiendo país de origen y el idioma preferido para trabajar antes de continuar con el brief.
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
  "Campaign Overview",
  "The Challenge",
  "Strategic Foundation",
  "Creative Strategy",
  "Campaign Architecture (Brand)",
  "Appendix (Brand)",
  "MELI Ecosystem Integration",
  "Campaign Architecture (MELI)",
  "Media Ecosystem",
  "Production Considerations",
  "Appendix (MELI)",
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
  "Campaign Overview":
    "¿Qué tipo de campaña es (product launch, seasonal, brand awareness, performance) y en qué mercados estará activa?",
  "The Challenge":
    "¿Cuál es el desafío principal o problema de negocio que debemos resolver?",
  "Strategic Foundation":
    "¿Qué insight, contexto o antecedentes estratégicos respaldan esta campaña?",
  "Creative Strategy":
    "¿Cuál es la idea o enfoque creativo que deberíamos perseguir para cumplir los objetivos?",
  "Campaign Architecture (Brand)":
    "Describe la arquitectura/touchpoints de la campaña desde la perspectiva de la marca (fases, momentos, canales).",
  "Appendix (Brand)":
    "¿Qué materiales, guidelines, assets o notas extra de la marca debemos tener a la mano?",
  "MELI Ecosystem Integration":
    "¿Cómo se integrará la campaña al ecosistema de Mercado Libre/Mercado Ads?",
  "Campaign Architecture (MELI)":
    "Detalla el journey o piezas específicas que esperas activar dentro de MELI (tiendas oficiales, Ads, landing, etc.).",
  "Media Ecosystem":
    "¿Qué mix de medios/plataformas se contempla y qué rol juega cada uno?",
  "Production Considerations":
    "¿Hay consideraciones de producción, tiempos, aprobaciones o limitaciones técnicas que debamos prever?",
  "Appendix (MELI)":
    "Comparte cualquier dato, benchmark o referencia adicional para el equipo de MELI.",
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
    /\b(\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{4}-\d{2}-\d{2}|hoy|ma[ñn]ana|semana|mes|deadline|fecha|entrega|presupuesto|budget|aprobaciones?|stakeholders?)\b/i.test(t),
  Extras: (t) => /\b(riesgos?|supuestos?|referencias?|links?|notas?|extras?)\b/i.test(t),
  "Campaign Overview": (t) =>
    /\b(campaign type|tipo de campa[ñn]a|product launch|seasonal|awareness|performance|mercados?|markets?|m[eé]xico|argentina|brasil|colombia)\b/i.test(t),
  "The Challenge": (t) => /\b(desaf[ií]o|challenge|problema|oportunidad|pain point)\b/i.test(t),
  "Strategic Foundation": (t) =>
    /\b(insight|fundament[oa]|strategic foundation|contexto|aprendizaje|benchmark)\b/i.test(t),
  "Creative Strategy": (t) =>
    /\b(creative strategy|estrategia creativa|idea creativa|concepto|big idea)\b/i.test(t),
  "Campaign Architecture (Brand)": (t) =>
    /\b(arquitectura|journey|touchpoints?|customer journey|fases|roadmap|flujo)\b/i.test(t),
  "Appendix (Brand)": (t) =>
    /\b(appendix|assets?|material(?:es)?|guidelines?|brandbook|referencias? adicionales)\b/i.test(t),
  "MELI Ecosystem Integration": (t) =>
    /\b(meli|mercado\s*(ads|libre)|ecosistema meli|ecosistema de mercado)\b/i.test(t),
  "Campaign Architecture (MELI)": (t) =>
    /\b(meli|mercado\s*ads|tienda oficial|landing|media buy|activaci[oó]n en meli|journey en meli)\b/i.test(t),
  "Media Ecosystem": (t) =>
    /\b(media|medios|plataformas|mix de medios|paid media|plan de medios|ecosistema de medios)\b/i.test(t),
  "Production Considerations": (t) =>
    /\b(producci[oó]n|timings?|postproducci[oó]n|limitaciones?|aprobaciones|recursos t[eé]cnicos)\b/i.test(t),
  "Appendix (MELI)": (t) =>
    /\b(appendix|meli|mercado\s*ads|benchmarks?|datos adicionales|referencias? meli)\b/i.test(t),
};

/* ───────────────────────────── Utils ───────────────────────────── */
const PREVIEW_LABELS = [...SECTIONS, "Fechas"];
const SECTION_LABEL_PATTERN = PREVIEW_LABELS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

const SEED_LINE_RE = new RegExp(`^-\\s*(${SECTION_LABEL_PATTERN})\\s*:\\s*(.*)$`, "i");


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

      let label = match[1].trim();
      const value = match[2].trim();
      const collapsed = value.replace(/\s+/g, "");
      if (collapsed && !/^[-—]+$/.test(collapsed)) {
        if (/^fechas$/i.test(label)) label = "Logística";
        cleaned.push(`${label}: ${value}`);

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
    ? `Sección **${prev}** completada. Ahora sigue con **${current}**.`
    : `Arrancamos con **${current}**.`;

  const ask = `Resume hallazgos útiles en 2–3 bullets y termina con una sola pregunta sobre **${current}**. Si no hubo avance en esa sección, reformula la pregunta (usa ejemplos o campos concretos). Mantén la respuesta ≤120 palabras.`;

  const suggested = `Pregunta sugerida: "${NEXT_QUESTION[current] || "¿Seguimos con la siguiente sección?"}"`;

  const commentsProtocol = `Añade al final: <!-- PROGRESS: ${JSON.stringify({ complete, missing: miss })} -->${
    complete ? ` <!-- AUTO_FINALIZE: ${JSON.stringify({ category: cat, client: cli })} -->` : ""
  }`;

  return `${progressLine}\n${ask}\n${suggested}\n${commentsProtocol}`;
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
Saluda (máx. 2 líneas), explica que crearás el brief de Mercado Ads y di:
"Si tienes un documento del proyecto (PDF o DOCX), adjúntalo ahora y lo usaré para prellenar el brief".
Cierra con una sola pregunta en inglés: "Where are you joining us from and which language do you prefer to work in for the brief?".
No hagas más preguntas en este turno.
<!-- PROGRESS: ${JSON.stringify({ complete: false, missing: SECTIONS })} -->
`.trim()
      : buildStateNudge(messages);

    const conversationMessages = isWelcome
      ? [
          ...messages,
          {
            role: "user",
            content:
              "Inicia la conversación con el saludo de bienvenida y continúa siguiendo el protocolo dado.",
          },
        ]
      : messages;

    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      temperature: 0.6,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: stateNudge },
        ...conversationMessages,
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
