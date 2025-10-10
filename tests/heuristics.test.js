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
  assert.ok(
    detectors["Campaign Overview"](
      "Es un product launch con enfoque performance en México y Argentina"
    )
  );
  assert.ok(detectors["The Challenge"]("El desafío es recuperar share en la categoría"));
  assert.ok(
    detectors["Strategic Foundation"](
      "El insight clave proviene de estudios y benchmarks del sector retail"
    )
  );
  assert.ok(
    detectors["Creative Strategy"]("La estrategia creativa propone una big idea omnicanal")
  );
  assert.ok(
    detectors["Campaign Architecture (Brand)"](
      "La arquitectura contempla un journey en tres fases con touchpoints en tienda y social"
    )
  );
  assert.ok(
    detectors["Appendix (Brand)"](
      "Compartiremos brandbook, assets y materiales adicionales en el appendix"
    )
  );
  assert.ok(
    detectors["MELI Ecosystem Integration"](
      "Integraremos Mercado Ads y la tienda oficial dentro del ecosistema MELI"
    )
  );
  assert.ok(
    detectors["Campaign Architecture (MELI)"](
      "El journey en MELI incluye landing, tienda oficial y pauta en Ads"
    )
  );
  assert.ok(
    detectors["Media Ecosystem"](
      "El mix de medios combina paid media, social y email marketing"
    )
  );
  assert.ok(
    detectors["Production Considerations"](
      "Consideraciones de producción: tiempos de rodaje y aprobaciones técnicas"
    )
  );
  assert.ok(
    detectors["Appendix (MELI)"](
      "Appendix MELI: benchmarks, datos adicionales y referencias internas"
    )
  );
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
- Contacto: —
- Alcance: —
- Objetivos: —
- Audiencia: —
- Marca: —
- Entregables: —
- Logística: —
- Extras: —


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
- Contacto: Juan Pérez · juan@example.com
- Alcance: Necesitamos un video y banners para campaña digital.
- Objetivos: Aumentar awareness y conversiones.
- Audiencia: Público joven urbano en redes sociales.
- Marca: Tono: alegre. Valores: innovación.
- Entregables: Videos 30s y versiones cuadradas.
- Logística: Deadline 2024-12-01 con presupuesto tentativo y aprobaciones clave.
- Extras: Riesgos mínimos y referencias https://ejemplo.com.

      `.trim(),
    },
  ];

  const missing = missingSections(messages);
  const expectedMissing = SECTIONS.filter((section) =>
    ![
      "Contacto",
      "Alcance",
      "Objetivos",
      "Audiencia",
      "Marca",
      "Entregables",
      "Logística",
      "Extras",
      "Campaign Overview",
      "Production Considerations",
    ].includes(section)
  );
  assert.deepStrictEqual(missing, expectedMissing);

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

  const expectedMissing = missingSections(messages);
  const progressMarker = `<!-- PROGRESS: ${JSON.stringify({ complete: false, missing: expectedMissing })} -->`;
  assert.ok(nudge.includes(progressMarker));
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
Campaign Overview: product launch enfocado en performance para México y Argentina.
The Challenge: recuperar share frente a competidores agresivos.
Strategic Foundation: insight basado en búsquedas y datos de Mercado Libre.
Creative Strategy: big idea omnicanal que conecta beneficios con lifestyle.
Campaign Architecture (Brand): tres fases con teasing, lanzamiento y always on.
Appendix (Brand): brandbook actualizado y toolkit de identidad.
MELI Ecosystem Integration: activar tienda oficial, audiencias y Mercado Ads.
Campaign Architecture (MELI): journey con landing, retargeting y promociones en MELI.
Media Ecosystem: mix de paid media, social, email y on-site.
Production Considerations: tiempos de producción de 6 semanas y aprobaciones legales.
Appendix (MELI): benchmarks internos y datos de performance previos.
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
