import type { EditCommand } from "../shared/commands";
import type { Deck, FontRoleName, Slide, TextObject } from "../shared/types";
import { FONT_ROLE_NAMES } from "../shared/types";
import { hasVariant } from "./fonts";

const SIZE_STEP = 1.12;
const MIN_SIZE = 10;
const MAX_SIZE = 320;

export function stepFontSize(size: number, direction: 1 | -1) {
  const next = direction > 0 ? size * SIZE_STEP : size / SIZE_STEP;
  return Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, next)) * 10) / 10;
}

export function Toolbar({
  deck,
  slide,
  object,
  dispatch,
  onEdit,
  style,
}: {
  deck: Deck;
  slide: Slide;
  object: TextObject;
  dispatch: (commands: EditCommand | EditCommand[]) => void;
  onEdit: () => void;
  style?: React.CSSProperties;
}) {
  const setStyle = (patch: Partial<TextObject["style"]>) => dispatch({ type: "set_text_style", slideId: slide.id, objectId: object.id, style: patch });
  const canBold = hasVariant(deck, object.style, "bold");
  const canItalic = hasVariant(deck, object.style, "italic");
  return (
    <div className="toolbar" style={style} onPointerDown={(event) => event.stopPropagation()}>
      <div className="toolbar__group" role="group" aria-label="Alignment">
        {(["left", "center", "right"] as const).map((align) => (
          <button key={align} type="button" className={`toolbar__btn ${object.style.align === align ? "is-active" : ""}`} title={`Align ${align}`} onClick={() => setStyle({ align })}>
            <AlignIcon align={align} />
          </button>
        ))}
      </div>
      <div className="toolbar__group" role="group" aria-label="Emphasis">
        <button type="button" className={`toolbar__btn toolbar__btn--bold ${object.style.bold ? "is-active" : ""}`} title={canBold ? "Bold (⌘B)" : "This family has no bold face"} disabled={!canBold} onClick={() => setStyle({ bold: !object.style.bold })}>B</button>
        <button type="button" className={`toolbar__btn toolbar__btn--italic ${object.style.italic ? "is-active" : ""}`} title={canItalic ? "Italic (⌘I)" : "This family has no italic face"} disabled={!canItalic} onClick={() => setStyle({ italic: !object.style.italic })}>I</button>
      </div>
      <div className="toolbar__group" role="group" aria-label="Size">
        <button type="button" className="toolbar__btn" title="Smaller (⌘⇧,)" onClick={() => setStyle({ fontSize: stepFontSize(object.style.fontSize, -1) })}>A<sub>−</sub></button>
        <span className="toolbar__value">{Math.round(object.style.fontSize)}</span>
        <button type="button" className="toolbar__btn" title="Larger (⌘⇧.)" onClick={() => setStyle({ fontSize: stepFontSize(object.style.fontSize, 1) })}>A<sup>+</sup></button>
      </div>
      <div className="toolbar__group" role="group" aria-label="Role">
        <select
          className="toolbar__select"
          value={object.style.fontRole}
          title="Font role"
          onChange={(event) => setStyle({ fontRole: event.target.value as FontRoleName, fontId: undefined })}
        >
          {FONT_ROLE_NAMES.map((role) => <option key={role} value={role}>{role}</option>)}
        </select>
      </div>
      <div className="toolbar__group">
        <button type="button" className="toolbar__btn" title="Edit text (Enter)" onClick={onEdit}>Edit</button>
        <button type="button" className="toolbar__btn toolbar__btn--danger" title="Delete (⌫)" onClick={() => dispatch({ type: "delete_object", slideId: slide.id, objectId: object.id })}>Delete</button>
      </div>
    </div>
  );
}

function AlignIcon({ align }: { align: "left" | "center" | "right" }) {
  const widths = [14, 9, 12];
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
      {widths.map((width, index) => {
        const x = align === "left" ? 1 : align === "right" ? 15 - width : 8 - width / 2;
        return <rect key={index} x={x} y={1 + index * 5} width={width} height={2} rx="1" fill="currentColor" />;
      })}
    </svg>
  );
}
