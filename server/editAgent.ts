// Prompt editing: a small tool-using author that reads the deck, looks at the
// slides as currently rendered, and emits edit commands, a repaint proposal,
// or an answer. Commands go through the same reducer as hand edits.

import { Agent, OpenAIProvider, Runner, tool, user, type AgentInputItem } from "@openai/agents";
import { z } from "zod";
import { applyCommands, describeCommand, editCommandSchema, type EditCommand } from "../src/shared/commands.js";
import type { Deck, EditRequest, EditResponse, FontCatalogEntry, RepaintProposal, Slide } from "../src/shared/types.js";
import { getOpenAIClient } from "./openaiClient.js";

const EDIT_AGENT_INSTRUCTIONS = `
You edit an existing, art-directed presentation on the user's request. The deck is described as JSON: a design system (four font roles and a seven-color palette) and slides. Recovered slides carry editable text objects with frames in canvas pixels (origin top-left, canvas usually 1536x864). Visual changes to slides that are not recovered yet need a repaint. Slide metadata, including talkingPoints and speakerNotes, can be edited at any recovery stage.

You have three ways to respond, and you must use exactly one:
1. apply_edits: for text-layer and metadata edits. Rewrites, shortening, renaming a term across the deck, moving or resizing text, alignment, emphasis, size steps, palette changes, font role changes, deleting or adding text, retitling, talking points, and speaker notes. Emit a complete list of commands in one call.
2. propose_repaint: when the request needs new pixels: a different illustration, background, chart, diagram, or a layout overhaul of the painted content. Give the image author a precise instruction. The user confirms before anything is repainted.
3. A plain text answer: when the user asked a question or the request cannot be done.

Rules:
- Stay inside the current design system. Use colorRole (text, mutedText, accent, accentText) and fontRole (display, heading, body, label) instead of raw values whenever the intent is a role. Change the design system itself (set_colors, set_font_role) only when the user asks for a deck-wide look change.
- Keep text inside the canvas with comfortable margins. Keep the deck's reading order and hierarchy intact unless asked to change them.
- When a deck-wide request touches many slides, apply it to every affected slide in one apply_edits call.
- Preserve the user's wording when they give exact text. Otherwise write plain, specific, editorial copy in the deck's voice.
- Use set_slide_meta.talkingPoints to write or revise the full spoken talk for a slide, including slides with no transcript yet. Write what the presenter says while the slide is shown, with explanation and natural transitions, not a summary or bullet outline. Format it as Markdown paragraphs, short headings, and emphasis. Mark focus areas inline with bold bracketed delivery cues such as **[Point to the left column]**; describe only elements supported by the current slide. These cues are text only. Keep facts grounded in the supplied brief, slide content, and notes; do not invent evidence or visual details. Keep speakerNotes for supplementary context and preserve them unless asked to edit them. A talking-points request changes metadata only, not canvas text or pixels.
- For size changes use fontSize steps of roughly 10-15 percent; do not shrink text below 14 px or grow body text above the heading size.
- To choose a different font family use find_fonts first and then set_font_role with the exact catalog id and family.
- Never invent object ids or slide ids. Use only those in the deck description.
- Do not put arrows or other pictorial symbols (→, ⇒, ▸, •, ✓) inside text. Use words, or propose a repaint if a drawn arrow is what the slide needs. Recovery after a repaint treats arrows as drawings.
- Summaries are one or two plain sentences describing what changed.
`.trim();

function describeSlide(slide: Slide, index: number, includeObjects: boolean) {
  return {
    slideId: slide.id,
    number: index + 1,
    title: slide.title,
    purpose: slide.purpose,
    transitionFromPrevious: slide.transitionFromPrevious,
    speakerNotes: slide.speakerNotes,
    talkingPoints: slide.talkingPoints,
    state: slide.state,
    canvas: slide.canvas,
    editable: Boolean(slide.layers),
    ...(includeObjects && slide.layers
      ? {
          objects: slide.layers.objects.map((object) => ({
            objectId: object.id,
            kind: object.kind,
            copyRole: object.copyRole,
            text: object.text,
            frame: object.frame,
            style: object.style,
          })),
        }
      : {}),
    ...(!slide.layers ? { copy: slide.copy } : {}),
  };
}

function describeDeck(deck: Deck, request: EditRequest) {
  const inScope = (slide: Slide) => request.scope === "deck" || slide.id === request.slideId;
  return {
    deckTitle: deck.title,
    brief: deck.brief.prompt,
    designSystem: {
      name: deck.designSystem.name,
      creativeDirection: deck.designSystem.creativeDirection,
      typography: deck.designSystem.typography,
      colors: deck.designSystem.colors,
    },
    slides: deck.slides.map((slide, index) => describeSlide(slide, index, inScope(slide))),
  };
}

export async function runEditAgent({
  deck,
  request,
  fontCatalog,
  signal,
}: {
  deck: Deck;
  request: EditRequest;
  fontCatalog: FontCatalogEntry[];
  signal?: AbortSignal;
}): Promise<EditResponse> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");

  let applied: { deck: Deck; commands: EditCommand[]; summary: string } | undefined;
  let proposal: { proposal: RepaintProposal; summary: string } | undefined;

  const applyEdits = tool({
    name: "apply_edits",
    description: "Apply a list of edit commands to the deck. Commands are validated and applied in order; an invalid command rejects the whole call so you can correct it.",
    parameters: z.object({
      commands: z.array(editCommandSchema).min(1).max(120),
      summary: z.string().min(1).max(400),
    }),
    async execute({ commands, summary }) {
      const next = applyCommands(deck, commands);
      applied = { deck: next, commands, summary };
      return JSON.stringify({ applied: commands.length, changes: commands.map((command) => describeCommand(command, deck)) });
    },
  });

  const proposeRepaint = tool({
    name: "propose_repaint",
    description: "Propose repainting one slide with the image author. Use only when the request needs new pixels. The user confirms before the repaint starts.",
    parameters: z.object({
      slideId: z.string().min(1),
      instruction: z.string().min(1).max(2000).describe("Precise production instruction for the image author: what changes, what stays, and why."),
      reason: z.string().min(1).max(300).describe("One sentence for the user on why this needs a repaint rather than a text edit."),
      summary: z.string().min(1).max(400),
    }),
    async execute({ slideId, instruction, reason, summary }) {
      if (!deck.slides.some((slide) => slide.id === slideId)) throw new Error(`Unknown slide ${slideId}.`);
      proposal = { proposal: { slideId, instruction, reason }, summary };
      return JSON.stringify({ proposed: true });
    },
  });

  const findFonts = tool({
    name: "find_fonts",
    description: "Search the font catalog by family name. Returns catalog ids to use with set_font_role.",
    parameters: z.object({ query: z.string().min(1).max(80), limit: z.number().int().min(1).max(40).optional() }),
    async execute({ query, limit = 20 }) {
      const needle = query.toLowerCase();
      const matches = fontCatalog
        .filter((font) => font.family.toLowerCase().includes(needle) || font.subfamily.toLowerCase().includes(needle))
        .slice(0, limit)
        .map((font) => ({ id: font.id, family: font.family, subfamily: font.subfamily }));
      return JSON.stringify(matches);
    },
  });

  const agent = new Agent({
    name: "Monoprint editor",
    instructions: EDIT_AGENT_INSTRUCTIONS,
    model: "gpt-5.6-sol",
    modelSettings: { reasoning: { effort: "medium" }, parallelToolCalls: false, retry: { maxRetries: 0 } },
    tools: [applyEdits, proposeRepaint, findFonts],
  });

  const targetSlide = request.slideId ? deck.slides.find((slide) => slide.id === request.slideId) : undefined;
  const targetObject = targetSlide && request.objectId
    ? targetSlide.layers?.objects.find((object) => object.id === request.objectId)
    : undefined;
  const scopeDescription = request.scope === "deck"
    ? "Scope: the whole deck."
    : request.scope === "object" && targetObject
      ? `Scope: object ${targetObject.id} (${targetObject.copyRole ?? "text"}) on slide ${(deck.slides.findIndex((slide) => slide.id === request.slideId) ?? 0) + 1}. Edit that object unless the request clearly needs more.`
      : `Scope: slide ${(deck.slides.findIndex((slide) => slide.id === request.slideId) ?? 0) + 1}.`;

  const snapshotEntries = Object.entries(request.snapshots ?? {})
    .filter(([slideId]) => request.scope === "deck" || slideId === request.slideId)
    .slice(0, 8);
  const content: Parameters<typeof user>[0] = [
    { type: "input_text", text: `${scopeDescription}\n\nUser request: ${request.prompt}\n\nDeck:\n${JSON.stringify(describeDeck(deck, request), null, 1)}` },
    ...snapshotEntries.flatMap(([slideId, dataUrl]) => [
      { type: "input_text" as const, text: `Current render of slide ${deck.slides.findIndex((slide) => slide.id === slideId) + 1} (${slideId}):` },
      { type: "input_image" as const, image: dataUrl },
    ]),
  ];
  const input: AgentInputItem[] = [user(content)];

  const runner = new Runner({ modelProvider: new OpenAIProvider({ openAIClient: getOpenAIClient() }) });
  const result = await runner.run(agent, input, { maxTurns: 8, signal });
  const finalText = typeof result.finalOutput === "string" ? result.finalOutput.trim() : "";

  if (applied) {
    const done: { deck: Deck; commands: EditCommand[]; summary: string } = applied;
    return { kind: "applied", deck: done.deck, summary: done.summary || finalText || "Edits applied.", commandCount: done.commands.length };
  }
  if (proposal) {
    const done: { proposal: RepaintProposal; summary: string } = proposal;
    return { kind: "repaint", proposal: done.proposal, summary: done.summary || finalText || "This change needs a repaint." };
  }
  return { kind: "answer", summary: finalText || "No change was made." };
}
