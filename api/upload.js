// api/upload.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs/promises";
import path from "node:path";

export const config = {
  api: { bodyParser: false },
  runtime: "nodejs",
};

// ── Multipart ──────────────────────────────────────────────────────────────
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      keepExtensions: true,
      maxFileSize: 100 * 1024 * 1024, // 100MB
    });

    form.parse(req, async (err, fields, files) => {
      try {
        if (err) return reject(err);
        let f =
          files.file ?? files.upload ?? files.attachment ?? Object.values(files)[0];
        if (Array.isArray(f)) f = f[0];
        if (!f || !f.filepath) return resolve({ fields, file: null });

        const buffer = await fs.readFile(f.filepath);
        const filename = f.originalFilename || f.newFilename || "upload";
        const mimeFromForm = (f.mimetype || "").split(";")[0].trim().toLowerCase();
        const ext = path.extname(filename).toLowerCase();
        const guessedMime =
          ext === ".pdf"
            ? "application/pdf"
            : ext === ".docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : mimeFromForm || "application/octet-stream";

        resolve({
          fields,
          file: { buffer, filename, mimeType: guessedMime, _tmpPath: f.filepath },
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ── Extractores ────────────────────────────────────────────────────────────
async function extractText({ buffer, mimeType }) {
  try {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("Archivo vacío o no es Buffer válido");
    }

    const mt = (mimeType || "").toLowerCase();

    if (mt.includes("pdf")) {
      try {
        // 1) Primer intento: pdf-parse
        const pdfParse = (await import("pdf-parse")).default;
        const data = await pdfParse(buffer);
        return (data.text || "").trim();
      } catch (err) {
        console.warn("pdf-parse falló, usando pdfjs-dist:", err?.message);

        // 2) Fallback: pdfjs-dist (requiere Uint8Array, no Buffer)
        const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
        const pdfDoc = await loadingTask.promise;

        let text = "";
        for (let i = 1; i <= pdfDoc.numPages; i++) {
          const page = await pdfDoc.getPage(i);
          const content = await page.getTextContent();
          text += content.items.map((item) => item.str).join(" ") + "\n";
        }
        return text.trim();
      }
    }

    if (
      mt.includes("wordprocessingml") ||
      mt.includes("msword") ||
      mt.includes("officedocument")
    ) {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer });
      return (value || "").trim();
    }

    return "";
  } catch (err) {
    console.error("extractText error:", err);
    return "⚠️ No se pudo extraer texto del archivo que subiste. Puede estar malformado o protegido.";
  }
}


// ── Prompt breve para sembrar ──────────────────────────────────────────────
function briefPrompt(texto, nombreArchivo) {
  return [
    { role: "system", content: "Eres un PM creativo. Devuelve SOLO JSON válido." },
    {
      role: "user",
      content: `
Basado en el archivo "${nombreArchivo}". Texto (truncado):
"""
${(texto || "").slice(0, 12000)}
"""
Tarea: propón un JSON de brief INICIAL con la siguiente estructura, rellenando sólo lo seguro y listando "faltantes":
{
  "contacto": { "nombre": "", "correo": "" },
  "alcance": "",
  "objetivos": [],
  "audiencia": { "descripcion": "", "canales": [] },
  "marca": { "tono": "", "valores": [], "referencias": [] },
  "entregables": [],
  "logistica": { "fechas": [], "duracion": [], "presupuesto": null, "aprobaciones": [] },
  "extras": { "riesgos": [], "notas": [] },
  "campania": { "tipo": [], "mercados": [], "otro_tipo": [], "otros_tipos": [], "otros": [], "otros_mercados": [] },
  "brand_sections": {
    "challenge": "",
    "strategic_foundation": "",
    "creative_strategy": "",
    "campaign_architecture": "",
    "appendix": ""
  },
  "meli_sections": {
    "ecosystem_integration": "",
    "campaign_architecture": "",
    "media_ecosystem": "",
    "production_considerations": "",
    "appendix": ""
  },
  "faltantes": [],
  "siguiente_pregunta": ""
}
      `.trim(),
    },
  ];
}

// ── Handler ────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { file } = await parseMultipart(req);
    if (!file) return res.status(400).json({ error: "No file" });

    const size = file?.buffer?.length ?? 0;
    console.log(
      `[upload] Archivo recibido: ${file.filename} (${file.mimeType || "sin mime"}) · ${size} bytes`
    );

    const text = await extractText(file);

    if (!text || !text.trim() || text.startsWith("⚠️")) {
      console.warn(
        `[upload] Texto extraído vacío o inválido para ${file.filename}.` +
          ` Vista previa: ${String(text || "").slice(0, 160).replace(/\s+/g, " ")}`
      );
    } else {
      console.log(
        `[upload] Texto extraído (${text.length} caracteres) para ${file.filename}:` +
          ` "${text.slice(0, 160).replace(/\s+/g, " ")}"`
      );
    }

    // Opcional: semilla de brief para UX (rápida)
    let brief = {};
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const ai = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: briefPrompt(text, file.filename),
        response_format: { type: "json_object" },
      });
      brief = JSON.parse(ai.choices?.[0]?.message?.content || "{}");
    } catch (e) {
      console.warn("[upload] seed brief warn:", e?.message || e);
      brief = {};
    }

    if (!brief || Object.keys(brief).length === 0) {
      console.warn(`[upload] El modelo no devolvió datos de brief para ${file.filename}.`);
    }

    // Limpieza tmp de formidable
    try {
      if (file._tmpPath) await fs.unlink(file._tmpPath).catch(() => {});
    } catch {}

    return res.status(200).json({
      brief,
      textPreview: (text || "").slice(0, 800),
      meta: { filename: file.filename, mimeType: file.mimeType },
    });
  } catch (e) {
    console.error("upload handler error:", e?.response?.data || e);
    const message = e?.response?.data?.error || e?.message || "Upload error";
    return res.status(500).json({ error: message });
  }
}
