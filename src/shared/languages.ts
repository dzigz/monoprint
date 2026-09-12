import { z } from "zod";

/** Canonical BCP 47 tags retain explicit script/region choices. No language guessing here. */
export function canonicalLanguages(languages: string[]): string[] {
  if (!languages.length) throw new Error("Declare at least one target language.");
  return [...new Set(languages.map(value => {
    const locale = new Intl.Locale(value.trim());
    if (!locale.language || locale.language === "und") throw new Error("Use a specific target language instead of und.");
    return locale.baseName;
  }))];
}

export const targetLanguagesSchema = z.array(z.string().trim().min(2).max(100)).min(1).max(20)
  .refine(values => {
    try { canonicalLanguages(values); return true; } catch { return false; }
  }, "Use valid BCP 47 language tags, including the script when relevant.");

export function targetLanguageInstruction(languages?: string[]) {
  return languages?.length
    ? `Target presentation language(s), in priority order: ${languages.join(", ")}. Keep reader-facing wording in these languages. Preserve the exact supplied copy, including diacritics, punctuation, names, and intentional quotations in other languages; do not translate or transliterate it.`
    : "Preserve the language and exact wording of the supplied slide copy, including diacritics and punctuation.";
}
