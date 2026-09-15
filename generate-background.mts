import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import OpenAI, { toFile } from "openai";

const STORE = "forma-jobs";

function jobStore() {
  return getStore(STORE, { consistency: "strong" });
}

function cleanJson(text: string) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("La IA no devolvió JSON válido");
}

function asDataUrl(mime: string, b64: string) {
  return `data:${mime};base64,${b64}`;
}

function extFor(mime: string) {
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  return "png";
}

async function setStatus(jobId: string, status: string, progress: number, extra: any = {}) {
  await jobStore().setJSON(`jobs/${jobId}/status.json`, { status, progress, updatedAt: new Date().toISOString(), ...extra });
}

async function saveImage(jobId: string, name: string, b64: string, mime = "image/png") {
  const bytes = Buffer.from(b64, "base64");
  await jobStore().set(`jobs/${jobId}/${name}`, bytes, { metadata: { contentType: mime } });
}

async function analyzeProject(openai: OpenAI, input: any) {
  const content: any[] = [
    {
      type: "input_text",
      text: `Actúa como interiorista y planificador espacial. Analiza el plano medido y la foto actual.\n\nREGLAS CRÍTICAS:\n- La geometría base es sagrada: muros, puertas, ventanas, pilares, bajantes y huecos se mantienen exactamente en la misma posición, salvo que el texto indique explícitamente que se pueden mover.\n- No inventes nuevas ventanas o puertas.\n- Las tres propuestas deben ser distintas entre sí y viables para el tipo de estancia.\n- El dossier es una propuesta inicial para que el cliente elija, no un plano ejecutivo.\n\nDevuelve SOLO JSON válido con esta forma exacta:\n{\n  \"room_type\": \"cocina|salon|dormitorio|bano|otro\",\n  \"summary\": \"resumen breve del espacio\",\n  \"fixed_elements\": [\"...\"],\n  \"dimensions_text\": [\"...\"],\n  \"distributions\": [\n    {\"code\":\"A\",\"name\":\"...\",\"strategy\":\"...\",\"benefits\":[\"...\",\"...\",\"...\"],\"plan_prompt\":\"instrucciones concretas para redistribuir SOLO mobiliario/equipamiento respetando geometría\"},\n    {\"code\":\"B\",\"name\":\"...\",\"strategy\":\"...\",\"benefits\":[\"...\",\"...\",\"...\"],\"plan_prompt\":\"...\"},\n    {\"code\":\"C\",\"name\":\"...\",\"strategy\":\"...\",\"benefits\":[\"...\",\"...\",\"...\"],\"plan_prompt\":\"...\"}\n  ],\n  \"styles\": [\n    {\"code\":\"1\",\"name\":\"...\",\"description\":\"...\",\"render_prompt\":\"...\",\"materials\":{\"frentes\":\"...\",\"encimera\":\"...\",\"suelo\":\"...\",\"revestimiento\":\"...\",\"griferia\":\"...\",\"iluminacion\":\"...\"}},\n    {\"code\":\"2\",\"name\":\"...\",\"description\":\"...\",\"render_prompt\":\"...\",\"materials\":{\"frentes\":\"...\",\"encimera\":\"...\",\"suelo\":\"...\",\"revestimiento\":\"...\",\"griferia\":\"...\",\"iluminacion\":\"...\"}},\n    {\"code\":\"3\",\"name\":\"...\",\"description\":\"...\",\"render_prompt\":\"...\",\"materials\":{\"frentes\":\"...\",\"encimera\":\"...\",\"suelo\":\"...\",\"revestimiento\":\"...\",\"griferia\":\"...\",\"iluminacion\":\"...\"}}\n  ]\n}\n\nDATOS DEL PROYECTO:\nCliente: ${input.client || "Sin nombre"}\nPresupuesto orientativo: ${input.budget || "Sin definir"}\nObjetivos: ${input.goals || ""}\nDebe mantenerse: ${input.keep || ""}\nReferencias escritas: ${input.referenceText || ""}\n\nSi el cliente adjunta referencias visuales, usa una de las tres direcciones de estilo inspirada en ellas y las otras dos como alternativas razonables. Si no hay referencias, propón tres estilos suficientemente distintos para que el cliente pueda descubrir sus preferencias.`
    },
    { type: "input_image", image_url: asDataUrl(input.plan.mime, input.plan.base64), detail: "high" },
  ];

  if (input.currentPhoto?.base64) {
    content.push({ type: "input_image", image_url: asDataUrl(input.currentPhoto.mime, input.currentPhoto.base64), detail: "high" });
  }
  for (const ref of (input.references || []).slice(0, 3)) {
    content.push({ type: "input_image", image_url: asDataUrl(ref.mime, ref.base64), detail: "auto" });
  }

  const rsp = await openai.responses.create({
    model: "gpt-5.6-terra",
    input: [{ role: "user", content }],
  });
  return cleanJson(rsp.output_text);
}

async function generatePlan(openai: OpenAI, input: any, analysis: any, dist: any, retryIssues = "") {
  const planFile = await toFile(Buffer.from(input.plan.base64, "base64"), `plan.${extFor(input.plan.mime)}`, { type: input.plan.mime });
  const prompt = `Edita el plano arquitectónico adjunto para crear la propuesta de distribución ${dist.code}: ${dist.name}.\n\nOBLIGATORIO:\n- Conserva EXACTAMENTE el perímetro, muros, puerta(s), ventana(s), pilares, bajantes, huecos y cotas del plano original.\n- No cambies el tamaño ni la posición de puertas o ventanas.\n- No alteres las medidas exteriores ni la escala.\n- Cambia únicamente mobiliario, equipamiento y piezas móviles/interiores autorizadas.\n- Mantén el dibujo en vista 2D cenital, limpio, técnico y profesional.\n- Incluye cotas legibles de los pasos principales, mobiliario relevante, islas/penínsulas/mesas y dimensiones clave de la propuesta.\n- Etiqueta claramente los elementos principales.\n- No añadas decoración, renders ni perspectiva: SOLO PLANO TÉCNICO 2D.\n\nPlano analizado: ${analysis.summary}. Elementos fijos: ${(analysis.fixed_elements || []).join(", ")}.\nEstrategia: ${dist.strategy}.\nInstrucción de distribución: ${dist.plan_prompt}.\n${retryIssues ? `Corrige especialmente estos fallos detectados en un intento anterior: ${retryIssues}` : ""}`;

  const rsp = await openai.images.edit({
    model: "gpt-image-2",
    image: planFile,
    prompt,
    size: "1536x1024",
    quality: "medium",
  });
  return rsp.data[0].b64_json!;
}

async function validatePlan(openai: OpenAI, input: any, generatedB64: string) {
  const rsp = await openai.responses.create({
    model: "gpt-5.6-luna",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: `Compara el plano original (primera imagen) con la propuesta (segunda imagen). Evalúa SOLO fidelidad geométrica. Deben mantenerse exactamente paredes, perímetro, puertas y ventanas. Devuelve SOLO JSON válido: {\"valid\":true|false,\"issues\":[\"...\"]}. Considera válido aunque cambien muebles, encimeras, electrodomésticos o cotas interiores de mobiliario.` },
        { type: "input_image", image_url: asDataUrl(input.plan.mime, input.plan.base64), detail: "high" },
        { type: "input_image", image_url: asDataUrl("image/png", generatedB64), detail: "high" },
      ]
    }]
  });
  return cleanJson(rsp.output_text);
}

async function generateRender(openai: OpenAI, input: any, analysis: any, style: any) {
  const images: any[] = [];
  if (input.currentPhoto?.base64) {
    images.push(await toFile(Buffer.from(input.currentPhoto.base64, "base64"), `current.${extFor(input.currentPhoto.mime)}`, { type: input.currentPhoto.mime }));
  }
  images.push(await toFile(Buffer.from(input.plan.base64, "base64"), `plan.${extFor(input.plan.mime)}`, { type: input.plan.mime }));
  for (const ref of (input.references || []).slice(0, 2)) {
    images.push(await toFile(Buffer.from(ref.base64, "base64"), `ref.${extFor(ref.mime)}`, { type: ref.mime }));
  }
  const prompt = `Genera un render fotorrealista de propuesta de interiorismo para este espacio.\n\nREGLAS CRÍTICAS:\n- Usa la foto actual como referencia principal de cámara y arquitectura si está disponible.\n- Usa el plano como referencia de geometría.\n- Mantén EXACTAMENTE la ubicación de ventanas, puertas, muros, pilares y huecos del espacio existente.\n- No inventes aperturas nuevas.\n- Cambia únicamente mobiliario, acabados, iluminación, equipamiento y decoración.\n- El resultado debe parecer una fotografía profesional de interiorismo, realista y viable.\n- Sin personas.\n\nESTILO: ${style.name}. ${style.description}.\nDirección visual: ${style.render_prompt}.\nMateriales: ${Object.entries(style.materials || {}).map(([k,v])=>`${k}: ${v}`).join("; ")}.\nObjetivo del cliente: ${input.goals || ""}.`;

  const rsp = await openai.images.edit({
    model: "gpt-image-2",
    image: images,
    prompt,
    size: "1536x1024",
    quality: "medium",
  });
  return rsp.data[0].b64_json!;
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) return;

  try {
    const input = await req.json();
    const openai = new OpenAI();
    await jobStore().setJSON(`jobs/${jobId}/input.json`, input);
    await setStatus(jobId, "processing", 4, { message: "Analizando plano y briefing…" });

    const analysis = await analyzeProject(openai, input);
    await jobStore().setJSON(`jobs/${jobId}/analysis.json`, analysis);
    await setStatus(jobId, "processing", 14, { message: "Plano analizado. Generando distribuciones…", analysis });

    const layouts: any[] = [];
    for (let i = 0; i < 3; i++) {
      const dist = analysis.distributions[i];
      let b64 = await generatePlan(openai, input, analysis, dist);
      let validation: any = { valid: true, issues: [] };
      try {
        validation = await validatePlan(openai, input, b64);
        if (!validation.valid) {
          b64 = await generatePlan(openai, input, analysis, dist, (validation.issues || []).join("; "));
          validation = await validatePlan(openai, input, b64);
        }
      } catch (e) {
        console.warn("Plan validation skipped", e);
      }
      const name = `layout-${dist.code}.png`;
      await saveImage(jobId, name, b64);
      layouts.push({ code: dist.code, name: dist.name, strategy: dist.strategy, benefits: dist.benefits, validation, url: `/api/asset?jobId=${jobId}&name=${encodeURIComponent(name)}` });
      await setStatus(jobId, "processing", 20 + i * 12, { message: `Distribución ${dist.code} lista…`, analysis, layouts });
    }

    const styles: any[] = [];
    for (let i = 0; i < 3; i++) {
      const style = analysis.styles[i];
      const b64 = await generateRender(openai, input, analysis, style);
      const name = `style-${style.code}.png`;
      await saveImage(jobId, name, b64);
      styles.push({ code: style.code, name: style.name, description: style.description, materials: style.materials, url: `/api/asset?jobId=${jobId}&name=${encodeURIComponent(name)}` });
      await setStatus(jobId, "processing", 62 + i * 11, { message: `Ambiente ${style.code} listo…`, analysis, layouts, styles });
    }

    const result = { analysis, layouts, styles, project: { client: input.client || "Cliente", budget: input.budget || "Por definir", goals: input.goals || "", keep: input.keep || "" } };
    await jobStore().setJSON(`jobs/${jobId}/result.json`, result);
    await setStatus(jobId, "done", 100, { message: "Dossier listo", ...result });
  } catch (error: any) {
    console.error(error);
    await setStatus(jobId, "error", 100, { message: error?.message || "Error generando la propuesta" });
  }
};
