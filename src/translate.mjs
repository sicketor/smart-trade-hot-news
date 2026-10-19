// Hebrew headlines for the US market (אפיון-תרגום-כותרות.md): Gemini Flash-Lite on the free tier, one call per run,
// each story translated once. Any failure leaves the English title; collection never fails because of it.

const PROMPT = [
  "Translate each English financial news headline to concise, natural Hebrew in the style of Israeli financial media (Calcalist, TheMarker).",
  "Keep tickers and numbers exactly. Keep company names in their usual form: the common Hebrew name if there is one (e.g. אפל, אנבידיה), otherwise English letters.",
  "Translate market jargon by meaning, not word by word (e.g. 'bumper forecast' = תחזית חזקה במיוחד, 'rallies' = מזנקת).",
  "Drop trailing source tags such as '— WSJ', '— Barrons.com' or '— Market Talk'.",
  "Return only a JSON array of strings, one per headline, in the same order.",
].join(" ");

/** Hebrew for each title, in order, or throws. `models`: tried in order (a retired model falls through to the next). */
export async function translateWithGemini(titles, models, apiKey) {
  let lastError;
  for (const model of models) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(titles) }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) {
      lastError = new Error(`model ${model} not found`);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${model} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const out = JSON.parse(text);
    if (!Array.isArray(out) || out.length !== titles.length || out.some((t) => typeof t !== "string" || !t.trim())) {
      throw new Error(`Gemini ${model}: unexpected answer ${text.slice(0, 200)}`);
    }
    return { titles: out.map((t) => t.trim()), model };
  }
  throw lastError ?? new Error("no Gemini model configured");
}

/**
 * Adds `titleHe` / `translatedBy` to `items`: reused from `previous` items with the same id (cache), the rest
 * translated in one call. Returns a warning string when translation was skipped or failed, else null.
 */
export async function addHebrewTitles(items, previous, translate) {
  const cached = new Map((previous ?? []).filter((p) => p.titleHe).map((p) => [p.id, p]));
  const missing = [];
  for (const item of items) {
    const hit = cached.get(item.id);
    if (hit && hit.title === item.title) {
      item.titleHe = hit.titleHe;
      item.translatedBy = hit.translatedBy;
    } else missing.push(item);
  }
  if (!missing.length) return null;
  try {
    const { titles, model } = await translate(missing.map((i) => i.title));
    missing.forEach((item, n) => {
      item.titleHe = titles[n];
      item.translatedBy = model;
    });
    return null;
  } catch (err) {
    return `translate: ${err.message}`;
  }
}
