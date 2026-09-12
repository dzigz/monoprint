import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { EditCommand } from "../shared/commands.js";
import type { Deck, Frame, Slide, TextObject } from "../shared/types.js";
import { cssFontStack, resolveFont } from "./fonts.js";
import { snapFrame, type Guide } from "./snapping.js";
import { FocusSpotlight } from "./FocusSpotlight.js";

export type SlideCanvasProps = {
  deck: Deck;
  slide: Slide;
  width: number;
  interactive?: boolean;
  selectedId?: string;
  editingId?: string;
  onSelect?: (id?: string) => void;
  onStartEditing?: (id: string) => void;
  onStopEditing?: () => void;
  dispatch?: (commands: EditCommand | EditCommand[]) => void;
  onMeasure?: (heights: Map<string, number>) => void;
  overlay?: ReactNode;
  focusBox?: [number, number, number, number];
  focusMode?: "highlight" | "spotlight";
  className?: string;
};

type Interaction = {
  mode: "move" | "resize-left" | "resize-right";
  objectId: string;
  startPointer: { x: number; y: number };
  startFrame: Frame;
  moved: boolean;
};

const SNAP_THRESHOLD = 6;
const MIN_WIDTH = 40;

export function textObjectStyle(deck: Deck, object: TextObject, frame: Frame): CSSProperties {
  const font = resolveFont(deck, object.style);
  const baseWeight = font?.weight ?? 400;
  return {
    position: "absolute",
    left: frame.x,
    top: frame.y,
    width: frame.width,
    margin: 0,
    padding: 0,
    fontFamily: cssFontStack(font),
    fontSize: object.style.fontSize,
    lineHeight: object.style.lineHeight,
    letterSpacing: object.style.letterSpacing ? `${object.style.letterSpacing}px` : undefined,
    wordSpacing: object.style.wordSpacing ? `${object.style.wordSpacing}px` : undefined,
    textAlign: object.style.align,
    color: object.style.color,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    textTransform: object.style.transform === "uppercase" ? "uppercase" : "none",
    fontWeight: object.style.bold && baseWeight < 600 ? 700 : baseWeight,
    fontStyle: object.style.italic && font?.style !== "italic" ? "italic" : "normal",
    fontKerning: "normal",
    textRendering: "geometricPrecision",
  };
}

function TextObjectView({
  deck,
  object,
  frame,
  editing,
  interactive,
  onPointerDown,
  onDoubleClick,
  onCommit,
  onMeasure,
}: {
  deck: Deck;
  object: TextObject;
  frame: Frame;
  editing: boolean;
  interactive: boolean;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
  onCommit?: (text: string) => void;
  onMeasure?: (height: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !onMeasure) return;
    onMeasure(element.offsetHeight);
    const observer = new ResizeObserver(() => onMeasure(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMeasure, object.style.fontSize, object.style.lineHeight, object.text, frame.width]);

  useEffect(() => {
    if (!editing || !ref.current) return;
    const element = ref.current;
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);

  const commit = () => {
    if (!ref.current) return;
    const text = ref.current.innerText.replace(/ /g, " ").replace(/\n$/, "");
    onCommit?.(text);
  };

  return (
    <div
      ref={ref}
      className={`text-object ${editing ? "text-object--editing" : ""} ${interactive ? "text-object--interactive" : ""}`}
      style={object.resolved && !editing
        ? { position: "absolute", left: frame.x, top: frame.y, width: frame.width, height: frame.height }
        : textObjectStyle(deck, object, frame)}
      data-object-id={object.id}
      contentEditable={editing ? ("plaintext-only" as unknown as boolean) : false}
      suppressContentEditableWarning
      spellCheck={false}
      onPointerDown={editing ? undefined : onPointerDown}
      onDoubleClick={editing ? undefined : onDoubleClick}
      onBlur={editing ? commit : undefined}
      onKeyDown={editing ? (event) => {
        if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key === "Enter")) {
          event.preventDefault();
          commit();
        }
        event.stopPropagation();
      } : undefined}
    >
      {object.resolved && !editing ? (
        <svg width={frame.width} height={frame.height} style={{ overflow: "visible", display: "block" }}>
          {object.resolved.words.map((word) => {
            const font = deck.fonts.find((candidate) => candidate.id === word.fontId);
            const [x,y] = word.baseline;
            return <text key={word.id} x={0} y={0}
              transform={`translate(${x} ${y}) scale(${word.scaleX} 1) rotate(${word.angle})`}
              fontFamily={cssFontStack(font)} fontSize={word.em} fontWeight={font?.weight ?? 400}
              fontStyle={font?.style ?? "normal"} fill={word.color}
              style={{ fontKerning: "normal", fontSynthesis: "none", textRendering: "geometricPrecision" }}
            >{word.text}</text>;
          })}
        </svg>
      ) : object.text}
    </div>
  );
}

export function SlideCanvas({
  deck,
  slide,
  width,
  interactive = false,
  selectedId,
  editingId,
  onSelect,
  onStartEditing,
  onStopEditing,
  dispatch,
  onMeasure,
  overlay,
  focusBox,
  focusMode = "highlight",
  className = "",
}: SlideCanvasProps) {
  const scale = width / slide.canvas.width;
  const height = slide.canvas.height * scale;
  const [interaction, setInteraction] = useState<Interaction>();
  const [liveFrame, setLiveFrame] = useState<Frame>();
  const [guides, setGuides] = useState<Guide[]>([]);
  const heightsRef = useRef(new Map<string, number>());
  const [, bump] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);

  const baseAsset = useMemo(() => {
    const plate = slide.layers ? deck.assets.find((asset) => asset.id === slide.layers?.plateAssetId) : undefined;
    return plate ?? deck.assets.find((asset) => asset.id === slide.assetId);
  }, [deck.assets, slide.assetId, slide.layers]);

  const objects = slide.layers?.objects ?? [];

  const toCanvas = (event: ReactPointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };

  const measuredFrame = (object: TextObject): Frame => {
    const measured = heightsRef.current.get(object.id);
    const frame = liveFrame && interaction?.objectId === object.id ? liveFrame : object.frame;
    return measured ? { ...frame, height: measured } : frame;
  };

  const begin = (event: ReactPointerEvent<HTMLElement>, object: TextObject, mode: Interaction["mode"]) => {
    if (!interactive || object.locked) return;
    event.stopPropagation();
    if (selectedId !== object.id) onSelect?.(object.id);
    if (editingId && editingId !== object.id) onStopEditing?.();
    const start = toCanvas(event);
    setInteraction({ mode, objectId: object.id, startPointer: start, startFrame: measuredFrame(object), moved: false });
    setLiveFrame(measuredFrame(object));
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!interaction) return;
    const pointer = toCanvas(event);
    const dx = pointer.x - interaction.startPointer.x;
    const dy = pointer.y - interaction.startPointer.y;
    const object = objects.find((candidate) => candidate.id === interaction.objectId);
    if (!object) return;
    const others = objects.filter((candidate) => candidate.id !== object.id).map((candidate) => ({ ...candidate, frame: measuredFrame(candidate as TextObject) }));
    let candidate: Frame;
    if (interaction.mode === "move") {
      candidate = { ...interaction.startFrame, x: interaction.startFrame.x + dx, y: interaction.startFrame.y + dy };
      const snapped = event.altKey ? { x: candidate.x, y: candidate.y, guides: [] } : snapFrame(candidate, slide, others, object.origin.frame, SNAP_THRESHOLD / scale * 1);
      candidate = { ...candidate, x: snapped.x, y: snapped.y };
      setGuides(snapped.guides);
    } else if (interaction.mode === "resize-right") {
      candidate = { ...interaction.startFrame, width: Math.max(MIN_WIDTH, interaction.startFrame.width + dx) };
      setGuides([]);
    } else {
      const widthValue = Math.max(MIN_WIDTH, interaction.startFrame.width - dx);
      candidate = { ...interaction.startFrame, x: interaction.startFrame.x + interaction.startFrame.width - widthValue, width: widthValue };
      setGuides([]);
    }
    setLiveFrame(candidate);
    if (!interaction.moved && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) setInteraction({ ...interaction, moved: true });
  };

  const finish = () => {
    if (!interaction) return;
    const object = objects.find((candidate) => candidate.id === interaction.objectId);
    if (object && liveFrame && interaction.moved && dispatch) {
      const measured = heightsRef.current.get(object.id) ?? liveFrame.height;
      if (interaction.mode === "move") {
        dispatch({ type: "move_object", slideId: slide.id, objectId: object.id, x: round(liveFrame.x), y: round(liveFrame.y) });
      } else {
        dispatch({ type: "resize_object", slideId: slide.id, objectId: object.id, frame: { x: round(liveFrame.x), y: round(liveFrame.y), width: round(liveFrame.width), height: round(measured) } });
      }
    }
    setInteraction(undefined);
    setLiveFrame(undefined);
    setGuides([]);
  };

  const selected = objects.find((object) => object.id === selectedId) as TextObject | undefined;
  const selectionFrame = selected ? measuredFrame(selected) : undefined;

  return (
    <div
      className={`slide-canvas ${className}`}
      style={{ width, height }}
      onPointerDown={interactive ? () => { if (editingId) onStopEditing?.(); onSelect?.(undefined); } : undefined}
    >
      <div
        ref={canvasRef}
        className="slide-canvas__surface"
        style={{ width: slide.canvas.width, height: slide.canvas.height, transform: `scale(${scale})`, backgroundColor: deck.designSystem.colors.background }}
        onPointerMove={interaction ? onMove : undefined}
        onPointerUp={interaction ? finish : undefined}
        onPointerCancel={interaction ? finish : undefined}
      >
        {baseAsset ? <img className="slide-canvas__base" src={baseAsset.url} alt="" draggable={false} /> : <div className="slide-canvas__missing">Missing image</div>}
        {objects.map((object) => object.kind === "text" && (
          <TextObjectView
            key={object.id}
            deck={deck}
            object={object}
            frame={liveFrame && interaction?.objectId === object.id ? liveFrame : object.frame}
            editing={editingId === object.id}
            interactive={interactive}
            onPointerDown={(event) => begin(event, object, "move")}
            onDoubleClick={() => { if (interactive) onStartEditing?.(object.id); }}
            onCommit={(text) => {
              if (text !== object.text && dispatch) {
                const measured = heightsRef.current.get(object.id);
                dispatch([
                  { type: "set_text", slideId: slide.id, objectId: object.id, text },
                  ...(measured && Math.abs(measured - object.frame.height) > 1 ? [{ type: "resize_object" as const, slideId: slide.id, objectId: object.id, frame: { ...object.frame, height: round(measured) } }] : []),
                ]);
              }
              onStopEditing?.();
            }}
            onMeasure={(measured) => {
              if (heightsRef.current.get(object.id) !== measured) {
                heightsRef.current.set(object.id, measured);
                onMeasure?.(new Map(heightsRef.current));
                bump((value) => value + 1);
              }
            }}
          />
        ))}
        {focusBox && !editingId && !interaction && (focusMode === "spotlight"
          ? <FocusSpotlight canvas={slide.canvas} box={focusBox} scale={scale} />
          : <div
              className="slide-canvas__focus" aria-hidden="true" data-testid="focus-region"
              style={{ left: focusBox[0], top: focusBox[1], width: focusBox[2] - focusBox[0], height: focusBox[3] - focusBox[1], borderWidth: 2 / scale, borderRadius: 4 / scale }}
            />)}
        {interactive && guides.map((guide, index) => (
          <div
            key={`${guide.axis}-${guide.position}-${index}`}
            className={`guide guide--${guide.axis} guide--${guide.kind}`}
            style={guide.axis === "x" ? { left: guide.position } : { top: guide.position }}
          />
        ))}
        {interactive && selected && selectionFrame && (
          <div
            className={`selection ${editingId === selected.id ? "selection--editing" : ""}`}
            style={{ left: selectionFrame.x, top: selectionFrame.y, width: selectionFrame.width, height: selectionFrame.height, borderWidth: Math.max(1, 1.5 / scale) }}
          >
            {editingId !== selected.id && (
              <>
                <div className="selection__handle selection__handle--left" style={{ transform: `translate(-50%, -50%) scale(${1 / scale})` }} onPointerDown={(event) => begin(event, selected, "resize-left")} />
                <div className="selection__handle selection__handle--right" style={{ transform: `translate(50%, -50%) scale(${1 / scale})` }} onPointerDown={(event) => begin(event, selected, "resize-right")} />
              </>
            )}
          </div>
        )}
      </div>
      {overlay}
    </div>
  );
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
