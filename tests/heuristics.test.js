import test from "node:test";
import assert from "node:assert/strict";

import {
  detectors,
  missingSections,
  guessCategoryFrom,
  guessClientFrom,
  buildStateNudge,
  SECTIONS,
} from "../api/chat/stream.js";

test("detectors recognize each section", () => {
  assert.ok(detectors.Contacto("Juan Pérez juan@example.com"));
  assert.strictEqual(detectors.Contacto("Juan sin correo"), false);

  assert.ok(detectors.Alcance("Necesitamos un video, banners y más piezas para la campaña"));
  assert.ok(detectors.Objetivos("Nuestro objetivo es awareness y conversiones"));
  assert.ok(detectors.Audiencia("Audiencia: público joven y digital"));
  assert.ok(detectors.Marca("La marca tiene un tono alegre y valores claros"));
  assert.ok(detectors.Entregables("Entregables: formatos y versiones en video"));
  assert.ok(detectors.Logística("Deadline 2024-12-01 con presupuesto y aprobaciones"));
  assert.ok(detectors.Extras("Riesgos y referencias adicionales"));
});

test("missingSections omits completed sections", () => {
  const messages = [
    { role: "user", content: "Hola, soy Juan Pérez juan@example.com" },
    {
      role: "user",
      content:
        "El alcance del proyecto es un video para campaña digital y nuestro objetivo principal es awareness",
    },
  ];

  const missing = missingSections(messages);
  assert.ok(!missing.includes("Contacto"));
  assert.ok(!missing.includes("Alcance"));
  assert.ok(!missing.includes("Objetivos"));
  assert.strictEqual(missing[0], "Audiencia");
  assert.deepStrictEqual(
    missing.filter((section) => !["Contacto", "Alcance", "Objetivos"].includes(section)),
    missing,
    "Solo deben faltar secciones posteriores"
  );
});

test("missingSections ignores seed placeholders with em dashes", () => {
  const messages = [
    {
      role: "user",
      content: `
**Vista previa del archivo analizado.**
- Alcance: —
- Objetivos: —
- Audiencia: —
- Marca: —
- Entregables: —
- Logística: —

**Faltantes:** Alcance, Objetivos, Audiencia, Marca, Entregables, Logística, Extras

¿Seguimos con la siguiente sección?
      `.trim(),
    },
  ];

  const missing = missingSections(messages);
  assert.deepStrictEqual(missing, SECTIONS);
});

test("missingSections leverages seed values when provided", () => {
  const messages = [
    {
      role: "user",
      content: `
**Vista previa del archivo analizado.**
- Alcance: Necesitamos un video y banners para campaña digital.
- Objetivos: Aumentar awareness y conversiones.
- Audiencia: Público joven urbano en redes sociales.
- Entregables: Videos 30s y versiones cuadradas.
- Fechas: Deadline 2024-12-01 con aprobación semanal.
      `.trim(),
    },
  ];

  const missing = missingSections(messages);
  assert.ok(missing.includes("Contacto"));
  assert.ok(!missing.includes("Alcance"));
  assert.ok(!missing.includes("Objetivos"));
  assert.ok(!missing.includes("Audiencia"));
  assert.ok(!missing.includes("Entregables"));
  assert.ok(!missing.includes("Logística"));
});

test("guessCategoryFrom infers categories from keywords", () => {
  assert.equal(guessCategoryFrom("Produciremos un spot de video para TV"), "Videos");
  assert.equal(guessCategoryFrom("Es una campaña integral para la marca"), "Campaña");
  assert.equal(guessCategoryFrom("Necesitamos refresh de branding y marca"), "Branding");
  assert.equal(guessCategoryFrom("Queremos un nuevo sitio web"), "Web");
  assert.equal(guessCategoryFrom("Prepararemos un evento híbrido"), "Evento");
  assert.equal(guessCategoryFrom("Proyecto sin pistas"), "Proyecto");
});

test("guessClientFrom prioritizes email domains and labels", () => {
  assert.equal(guessClientFrom("Contacto: ana@super-empresa.com"), "Super Empresa");
  assert.equal(guessClientFrom("Cliente: Mega Studio S.A. de C.V."), "Mega");
});

test("buildStateNudge reflects progress and suggestions", () => {
  const messages = [
    { role: "user", content: "Juan Pérez juan@example.com" },
    {
      role: "user",
      content: "Necesitamos un video para la campaña y el objetivo es awareness",
    },
  ];

  const nudge = buildStateNudge(messages);

  assert.match(nudge, /Sección \*\*Objetivos\*\* completada\. Ahora avanza a \*\*Audiencia\*\*\./);
  assert.match(nudge, /Pregunta sugerida: "¿Quién es la audiencia/);

  const expectedMissing = ["Audiencia", ...SECTIONS.slice(4)];
  assert.match(
    nudge,
    new RegExp(
      `<!-- PROGRESS: {\\"complete\\":false,\\"missing\\":\\[\\"${expectedMissing.join('\\",\\"')}\\"\\]} -->`
    )
  );
});

test("buildStateNudge signals completion with auto finalize", () => {
  const messages = [
    {
      role: "user",
      content: `
Juan Pérez juan@super-empresa.com
El alcance incluye video, banners y landing page para la campaña.
Nuestros objetivos son awareness y conversiones.
Audiencia: público joven en redes sociales.
La marca tiene tono alegre, valores de innovación y referencias en el brandbook.
Entregables: piezas en video y versiones 16:9.
Logística: deadline 2024-12-01 con presupuesto tentativo y aprobaciones de dirección.
Extras: riesgos mínimos y referencias https://ejemplo.com.
      `.trim(),
    },
  ];

  const nudge = buildStateNudge(messages);

  assert.match(nudge, /\"complete\":true/);
  assert.match(
    nudge,
    /<!-- AUTO_FINALIZE: {\"category\":\"Videos\",\"client\":\"Super Empresa\"} -->/
  );
});
