// Edit commands: the single vocabulary for changing a deck after generation.
// Hand edits in the editor and prompt edits from the agent both produce these,
// so undo, autosave, validation, and previews behave identically.

import { z } from "zod";
import type {
  Deck,
  DeckColors,
  FontRole,
  FontRoleName,
  Frame,
  Slide,
  SlideObject,
  TextObject,
  TextStyle,
} from "./types.js";

const frameSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

const fontRoleNameSchema = z.enum(["display", "heading", "body", "label"]);
const colorRoleNameSchema = z.enum(["background", "surface", "text", "mutedText", "accent", "accentText", "border"]);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color.");

export const textStyleSchema = z.object({
  fontRole: fontRoleNameSchema,
  fontId: z.string().min(1).optional(),
  fontSize: z.number().finite().min(4).max(600),
  lineHeight: z.number().finite().min(0.6).max(3),
  letterSpacing: z.number().finite().optional(),
  wordSpacing: z.number().finite().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]),
  color: hexColor,
  colorRole: colorRoleNameSchema.optional(),
  transform: z.enum(["none", "uppercase"]).optional(),
});

export const textObjectSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("text"),
  frame: frameSchema,
  text: z.string().max(4000),
  style: textStyleSchema,
  resolved: z.object({
    revision: z.string(),
    words: z.array(z.object({
      id: z.number().int(), text: z.string(), fontId: z.string(),
      em: z.number().finite().positive(), baseline: z.tuple([z.number().finite(), z.number().finite()]),
      angle: z.number().finite(), color: hexColor, line: z.string(), scaleX: z.number().finite().positive(),
    })),
  }).optional(),
  copyRole: z.string().optional(),
  locked: z.boolean().optional(),
  origin: z.object({
    kind: z.enum(["recovered", "user", "agent"]),
    frame: frameSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
});

export const slideObjectSchema = z.discriminatedUnion("kind", [textObjectSchema]);

export const editCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_text"), slideId: z.string(), objectId: z.string(), text: z.string().max(4000) }),
  z.object({ type: z.literal("move_object"), slideId: z.string(), objectId: z.string(), x: z.number().finite(), y: z.number().finite() }),
  z.object({ type: z.literal("resize_object"), slideId: z.string(), objectId: z.string(), frame: frameSchema }),
  z.object({ type: z.literal("set_text_style"), slideId: z.string(), objectId: z.string(), style: textStyleSchema.partial() }),
  z.object({ type: z.literal("add_text"), slideId: z.string(), object: textObjectSchema }),
  z.object({ type: z.literal("delete_object"), slideId: z.string(), objectId: z.string() }),
  z.object({ type: z.literal("set_colors"), colors: z.object({
    background: hexColor.optional(),
    surface: hexColor.optional(),
    text: hexColor.optional(),
    mutedText: hexColor.optional(),
    accent: hexColor.optional(),
    accentText: hexColor.optional(),
    border: hexColor.optional(),
  }) }),
  z.object({ type: z.literal("set_font_role"), role: fontRoleNameSchema, font: z.object({
    fontId: z.string().min(1),
    family: z.string().min(1),
    weight: z.number().int().min(100).max(900).optional(),
    style: z.enum(["normal", "italic"]).optional(),
    letterSpacing: z.number().finite().optional(),
  }) }),
  z.object({
    type: z.literal("set_slide_meta"),
    slideId: z.string(),
    title: z.string().min(1).optional(),
    purpose: z.string().min(1).optional(),
    speakerNotes: z.string().optional(),
    talkingPoints: z.string().optional().describe("Replace the full spoken transcript in Markdown, including textual focus cues. An empty string clears it. Available before or after text recovery."),
  }),
  z.object({ type: z.literal("set_deck_title"), title: z.string().min(1) }),
  z.object({ type: z.literal("reorder_slides"), slideIds: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("delete_slide"), slideId: z.string() }),
]);

export type EditCommand = z.infer<typeof editCommandSchema>;

export class EditCommandError extends Error {}

function findSlide(deck: Deck, slideId: string) {
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  if (!slide) throw new EditCommandError(`Unknown slide ${slideId}.`);
  return slide;
}

function findObject(slide: Slide, objectId: string) {
  const object = slide.layers?.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new EditCommandError(`Slide ${slide.id} has no object ${objectId}.`);
  return object;
}

function replaceSlide(deck: Deck, next: Slide): Deck {
  return { ...deck, slides: deck.slides.map((slide) => (slide.id === next.id ? next : slide)) };
}

function withObjects(slide: Slide, objects: SlideObject[]): Slide {
  if (!slide.layers) throw new EditCommandError(`Slide ${slide.id} is not editable yet; text recovery has not finished.`);
  return { ...slide, state: "edited", layers: { ...slide.layers, objects } };
}

function updateObject(slide: Slide, objectId: string, update: (object: TextObject) => TextObject): Slide {
  const existing = findObject(slide, objectId);
  if (existing.kind !== "text") throw new EditCommandError(`Object ${objectId} is not text.`);
  const objects = (slide.layers?.objects ?? []).map((object) => (object.id === objectId ? update(object as TextObject) : object));
  return withObjects(slide, objects);
}

function clampFrame(frame: Frame, canvas: { width: number; height: number }): Frame {
  const width = Math.max(8, Math.min(frame.width, canvas.width));
  const height = Math.max(4, frame.height);
  const x = Math.max(-width * 0.5, Math.min(frame.x, canvas.width - width * 0.5));
  const y = Math.max(-height * 0.5, Math.min(frame.y, canvas.height - height * 0.5));
  return { x, y, width, height };
}

export function applyCommand(deck: Deck, command: EditCommand): Deck {
  switch (command.type) {
    case "set_text": {
      const slide = findSlide(deck, command.slideId);
      return replaceSlide(deck, updateObject(slide, command.objectId, (object) => ({ ...object, text: command.text, resolved: object.text === command.text ? object.resolved : undefined })));
    }
    case "move_object": {
      const slide = findSlide(deck, command.slideId);
      return replaceSlide(deck, updateObject(slide, command.objectId, (object) => ({
        ...object,
        frame: clampFrame({ ...object.frame, x: command.x, y: command.y }, slide.canvas),
      })));
    }
    case "resize_object": {
      const slide = findSlide(deck, command.slideId);
      return replaceSlide(deck, updateObject(slide, command.objectId, (object) => ({
        ...object,
        frame: clampFrame(command.frame, slide.canvas),
        resolved: command.frame.width === object.frame.width ? object.resolved : undefined,
      })));
    }
    case "set_text_style": {
      const slide = findSlide(deck, command.slideId);
      return replaceSlide(deck, updateObject(slide, command.objectId, (object) => {
        const style: TextStyle = { ...object.style, ...command.style };
        if (command.style.color !== undefined && command.style.colorRole === undefined) delete style.colorRole;
        const changesGeometry = Object.entries(command.style).some(([key, value]) =>
          !["color", "colorRole"].includes(key) && value !== object.style[key as keyof TextStyle]);
        const resolved = changesGeometry ? undefined : object.resolved && {
          ...object.resolved,
          words: object.resolved.words.map((word) => ({ ...word, color: command.style.color ?? word.color })),
        };
        return { ...object, style, resolved };
      }));
    }
    case "add_text": {
      const slide = findSlide(deck, command.slideId);
      if (slide.layers?.objects.some((object) => object.id === command.object.id)) {
        throw new EditCommandError(`Object ${command.object.id} already exists on slide ${slide.id}.`);
      }
      const object: TextObject = { ...command.object, frame: clampFrame(command.object.frame, slide.canvas) };
      return replaceSlide(deck, withObjects(slide, [...(slide.layers?.objects ?? []), object]));
    }
    case "delete_object": {
      const slide = findSlide(deck, command.slideId);
      findObject(slide, command.objectId);
      return replaceSlide(deck, withObjects(slide, (slide.layers?.objects ?? []).filter((object) => object.id !== command.objectId)));
    }
    case "set_colors": {
      const colors: DeckColors = { ...deck.designSystem.colors };
      for (const [key, value] of Object.entries(command.colors)) {
        if (value) colors[key as keyof DeckColors] = value;
      }
      return { ...deck, designSystem: { ...deck.designSystem, colors }, slides: deck.slides.map((slide) => slide.layers ? { ...slide, state: "edited" } : slide) };
    }
    case "set_font_role": {
      const current = deck.designSystem.typography[command.role];
      const font: FontRole = {
        fontId: command.font.fontId,
        family: command.font.family,
        weight: command.font.weight ?? current.weight,
        style: command.font.style ?? current.style,
        letterSpacing: command.font.letterSpacing ?? current.letterSpacing,
      };
      return {
        ...deck,
        slides: deck.slides.map((slide) => slide.layers ? { ...slide, state: "edited" } : slide),
        designSystem: {
          ...deck.designSystem,
          typography: { ...deck.designSystem.typography, [command.role]: font },
        },
      };
    }
    case "set_slide_meta": {
      const slide = findSlide(deck, command.slideId);
      return replaceSlide(deck, {
        ...slide,
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.purpose !== undefined ? { purpose: command.purpose } : {}),
        ...(command.speakerNotes !== undefined ? { speakerNotes: command.speakerNotes } : {}),
        ...(command.talkingPoints !== undefined ? { talkingPoints: command.talkingPoints } : {}),
      });
    }
    case "set_deck_title":
      return { ...deck, title: command.title };
    case "reorder_slides": {
      const byId = new Map(deck.slides.map((slide) => [slide.id, slide]));
      if (command.slideIds.length !== deck.slides.length || command.slideIds.some((id) => !byId.has(id))) {
        throw new EditCommandError("reorder_slides must list every slide id exactly once.");
      }
      if (new Set(command.slideIds).size !== command.slideIds.length) {
        throw new EditCommandError("reorder_slides contains duplicate slide ids.");
      }
      return { ...deck, slides: command.slideIds.map((id) => byId.get(id) as Slide) };
    }
    case "delete_slide": {
      findSlide(deck, command.slideId);
      if (deck.slides.length === 1) throw new EditCommandError("A deck must keep at least one slide.");
      return { ...deck, slides: deck.slides.filter((slide) => slide.id !== command.slideId) };
    }
  }
}

export function applyCommands(deck: Deck, commands: EditCommand[]): Deck {
  let next = deck;
  for (const command of commands) next = applyCommand(next, command);
  return next === deck ? deck : { ...next, updatedAt: new Date().toISOString() };
}

/** Human-readable label for history and agent summaries. */
export function describeCommand(command: EditCommand, deck?: Deck) {
  const slideNumber = (slideId: string) => {
    const index = deck?.slides.findIndex((slide) => slide.id === slideId) ?? -1;
    return index >= 0 ? `slide ${index + 1}` : slideId;
  };
  switch (command.type) {
    case "set_text": return `Edit text on ${slideNumber(command.slideId)}`;
    case "move_object": return `Move text on ${slideNumber(command.slideId)}`;
    case "resize_object": return `Resize text on ${slideNumber(command.slideId)}`;
    case "set_text_style": return `Restyle text on ${slideNumber(command.slideId)}`;
    case "add_text": return `Add text to ${slideNumber(command.slideId)}`;
    case "delete_object": return `Delete text on ${slideNumber(command.slideId)}`;
    case "set_colors": return "Change deck colors";
    case "set_font_role": return `Change ${command.role} font`;
    case "set_slide_meta": return `Update ${slideNumber(command.slideId)} details`;
    case "set_deck_title": return "Rename deck";
    case "reorder_slides": return "Reorder slides";
    case "delete_slide": return `Delete ${slideNumber(command.slideId)}`;
  }
}

export type { FontRoleName };
