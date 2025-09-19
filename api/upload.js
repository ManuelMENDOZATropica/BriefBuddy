// api/upload.js
import { google } from "googleapis";
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs/promises";
import path from "node:path";

// Configuración para Vercel/Next
export const config = {
  api: { bodyParser: false },
  runtime: "nodejs",
};

// ——— Helpers env ———
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// ——— Google Auth/Drive ———
function oauthClient() {
  const oauth = new google.auth.OAuth2(
    required("GOOGLE_CLIENT_ID"),
    required("GOOGLE_CLIENT_SECRET"),
    required("GOOGLE_REDIRECT_URI")
  );
  oauth.setCredentials({ refresh_token: required("GOOGLE_REFRESH_TOKEN") });
  return oauth;
}

function driveClient() {
  const auth = oauthClient();
  return google.drive({ version: "v3", auth });
}

// ——— Multipart parser ———
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
          files.file ??
          files.upload ??
          files.attachment ??
          Object.values(files)[0];

        if (Array.isArray(f)) f = f[0];

        if (!f || !f.filepath) {
          return resolve({ fields, file: null });
        }

        const buffer = await fs.readFile(f.filepath);

        // Normaliza filename y MIME; usa la extensión como respaldo
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
          file: {
            buffer,
            filename,
            mimeType: guessedMime,
            _tmpPath: f.filepath, // para cleanup
          },
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ——— Extractores ———
async function extractText({ buffer, mimeType }) {
  try {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error("Archivo vacío o no es Buffer válido");
    }

    const mt = (mimeType || "").toLowerCase();

    if (mt.includes("pdf")) {
      // 🚑 Importamos la función real para evitar el ejemplo interno
      const pdfParseModule = await import("pdf-parse/lib/pdf-parse.js");
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const data = await pdfParse(buffer);
      return (data.text || "").trim();
    }

    if (mt.includes("wordprocessingml") || mt.includes("msword") || mt.includes("officedocument")) {
      const mammothModule = await import("mammoth");
      const { extractRawText } = mammothModule;
      const { value } = await extractRawText({ buffer });
      return (value || "").trim();
    }

    // Tipos no soportados
    return "";
  } catch (err) {
    console.error("extractText error:", err);
    return "";
  }
}

// ——— Prompt para brief ———
function briefPrompt(texto, nombreArchivo, link) {
  return [
    { role: "system", content: "Eres un PM creativo. Devuelve SOLO JSON válido." },
    {
      role: "user",
      content: `
Archivo del cliente:
- Nombre: ${nombreArchivo}
- Link Drive: ${link}

Texto extraído:
"""
${(texto || "").slice(0, 12000)}
"""

Tarea:
1) Devuelve JSON con:
{
  "contacto": { "nombre": "", "correo": "" },
  "alcance": "",
  "objetivos": [],
  "audiencia": { "descripcion": "", "canales": [] },
  "marca": { "tono": "", "valores": [], "referencias": [] },
  "entregables": [],
  "logistica": { "fechas": [], "presupuesto": null, "aprobaciones": [] },
  "extras": { "riesgos": [], "notas": [] },
  "faltantes": [],
  "siguiente_pregunta": ""
}
2) Rellena solo si estás seguro; no inventes.
3) "faltantes" = campos importantes que faltan.
4) "siguiente_pregunta" = UNA pregunta clara para avanzar.
      `.trim(),
    },
  ];
}

// ——— Handler principal ———
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    required("OPENAI_API_KEY");
    required("DRIVE_FOLDER_ID");

    const { file } = await parseMultipart(req);
    if (!file) return res.status(400).json({ error: "No file" });

    // 1) Subir a Drive
    const drive = driveClient();
    const { Readable } = await import("stream");
    const stream = new Readable({
      read() {
        this.push(file.buffer);
        this.push(null);
      },
    });

    const upload = await drive.files.create({
      requestBody: {
        name: file.filename,
        parents: [process.env.DRIVE_FOLDER_ID],
      },
      media: { mimeType: file.mimeType, body: stream },
      fields: "id,name,mimeType,webViewLink",
    });

    // Compartir por link (ajústalo a dominio en prod)
    try {
      await drive.permissions.create({
        fileId: upload.data.id,
        requestBody: { role: "reader", type: "anyone" },
      });
    } catch (permErr) {
      console.warn("permissions.create warning:", permErr?.message || permErr);
    }

    const { data: meta } = await drive.files.get({
      fileId: upload.data.id,
      fields: "id,name,mimeType,webViewLink",
    });

    const driveLink = meta.webViewLink;

    // 2) Extraer texto con guardas
    const text = await extractText(file);

    // 3) Normalizar con OpenAI
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: briefPrompt(text, file.filename, driveLink),
      response_format: { type: "json_object" },
    });

    let brief = {};
    try {
      brief = JSON.parse(ai.choices?.[0]?.message?.content || "{}");
    } catch (jerr) {
      console.warn("JSON parse warn:", jerr);
      brief = {};
    }

    // Limpia el tmp si existe
    try { if (file._tmpPath) await fs.unlink(file._tmpPath).catch(() => {}); } catch {}

    return res.status(200).json({
      drive: {
        id: meta.id,
        name: meta.name,
        link: driveLink,
        mimeType: meta.mimeType,
      },
      brief,
      textPreview: (text || "").slice(0, 500),
    });
  } catch (e) {
    console.error("upload handler error:", e?.response?.data || e);
    const message = e?.response?.data?.error || e?.message || "Upload error";
    return res.status(500).json({ error: message });
  }
}
