/**
 * Builds small synthetic .fig archives for committed tests. The schema is a tiny subset of
 * Figma's (same field names), compiled from kiwi text, so these files exercise the same code paths
 * without depending on real Figma exports.
 */
import { createRequire } from 'node:module';
import { deflateRawSync, zstdCompressSync } from 'node:zlib';
import {
  METHOD_DEFLATE,
  METHOD_STORED,
  serializeFigKiwi,
  writeZip,
  type Message,
} from '@figtional/fig-format';

const require = createRequire(import.meta.url);
const kiwi = require('kiwi-schema');

// Field names and enum values follow Figma's schema, so edit code paths behave the same; field
// numbers are our own. Fields 1–17 were the original synthetic set; edit tests use the rest.
export const SYNTHETIC_SCHEMA = `
enum MessageType { NODE_CHANGES = 1; }
enum NodeType { DOCUMENT = 1; CANVAS = 2; FRAME = 3; TEXT = 4; ROUNDED_RECTANGLE = 5; SYMBOL = 6; INSTANCE = 7; VARIABLE_SET = 8; VARIABLE = 9; ELLIPSE = 10; LINE = 11; SECTION = 12; VECTOR = 13; }
enum NodePhase { CREATED = 0; REMOVED = 1; }
enum PaintType { SOLID = 0; IMAGE = 1; GRADIENT_LINEAR = 2; GRADIENT_RADIAL = 3; }
enum BlendMode { PASS_THROUGH = 0; NORMAL = 1; MULTIPLY = 2; }
enum StrokeAlign { CENTER = 0; INSIDE = 1; OUTSIDE = 2; }
enum StrokeJoin { MITER = 0; BEVEL = 1; ROUND = 2; }
enum StackMode { NONE = 0; HORIZONTAL = 1; VERTICAL = 2; GRID = 3; }
enum StackSize { FIXED = 0; RESIZE_TO_FIT = 1; RESIZE_TO_FIT_WITH_IMPLICIT_SIZE = 2; }
enum StackJustify { MIN = 0; CENTER = 1; MAX = 2; SPACE_EVENLY = 3; SPACE_BETWEEN = 4; SPACE_AROUND = 5; }
enum StackAlign { MIN = 0; CENTER = 1; MAX = 2; BASELINE = 3; }
enum StackCounterAlign { MIN = 0; CENTER = 1; MAX = 2; STRETCH = 3; AUTO = 4; BASELINE = 5; }
enum StackPositioning { AUTO = 0; ABSOLUTE = 1; }
enum StackWrap { NO_WRAP = 0; WRAP = 1; }
enum TextAutoResize { NONE = 0; WIDTH_AND_HEIGHT = 1; HEIGHT = 2; }
enum TextAlignHorizontal { LEFT = 0; CENTER = 1; RIGHT = 2; JUSTIFIED = 3; }
enum TextAlignVertical { TOP = 0; CENTER = 1; BOTTOM = 2; }
enum NumberUnits { RAW = 0; PIXELS = 1; PERCENT = 2; }
enum EffectType { INNER_SHADOW = 0; DROP_SHADOW = 1; FOREGROUND_BLUR = 2; BACKGROUND_BLUR = 3; }
enum VariableResolvedDataType { BOOLEAN = 0; FLOAT = 1; STRING = 2; COLOR = 4; SYMBOL_ID = 7; TEXT_DATA = 9; }
enum VariableDataType { BOOLEAN = 0; FLOAT = 1; STRING = 2; ALIAS = 3; COLOR = 4; SYMBOL_ID = 7; TEXT_DATA = 9; PROP_REF = 13; }
enum VariableField { MISSING = 0; CORNER_RADIUS = 1; STACK_SPACING = 5; STACK_PADDING_LEFT = 6; STACK_PADDING_TOP = 7; STACK_PADDING_RIGHT = 8; STACK_PADDING_BOTTOM = 9; VISIBLE = 10; TEXT_DATA = 11; WIDTH = 12; OVERRIDDEN_SYMBOL_ID = 40; HEIGHT = 13; OPACITY = 31; FONT_SIZE = 32; }
enum CodeSyntaxPlatform { WEB = 0; ANDROID = 1; iOS = 2; }
enum ComponentPropType { BOOL = 0; TEXT = 1; COLOR = 2; INSTANCE_SWAP = 3; VARIANT = 4; NUMBER = 5; IMAGE = 6; SLOT = 7; }
enum ComponentPropNodeField { VISIBLE = 0; TEXT_DATA = 1; OVERRIDDEN_SYMBOL_ID = 2; INHERIT_FILL_STYLE_ID = 3; SLOT_CONTENT_ID = 4; }
enum InstanceSwapPreferredValueType { COMPONENT = 0; COMPONENT_SET = 1; }
struct GUID { uint sessionID; uint localID; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct Color { float r; float g; float b; float a; }
struct Number { float value; NumberUnits units; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Image { byte[] hash = 1; string name = 2; }
message ColorStop { Color color = 1; float position = 2; }
message AssetRef { string key = 1; string version = 2; }
message VariableID { GUID guid = 1; AssetRef assetRef = 2; }
message SymbolId { GUID guid = 1; AssetRef assetRef = 2; }
message PropRefValue { GUID defId = 1; }
message VariableAnyValue { bool boolValue = 1; string textValue = 2; float floatValue = 3; VariableID alias = 4; Color colorValue = 5; SymbolId symbolIdValue = 6; TextData textDataValue = 7; PropRefValue propRefValue = 8; }
message VariableData { VariableAnyValue value = 1; VariableDataType dataType = 2; VariableResolvedDataType resolvedDataType = 3; }
message Paint {
  PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; Image image = 5; BlendMode blendMode = 6;
  ColorStop[] stops = 7; Matrix transform = 8; VariableData colorVar = 9; Image imageThumbnail = 10; string imageScaleMode = 11;
  float scale = 12; float rotation = 13; uint originalImageWidth = 14; uint originalImageHeight = 15;
}
message Effect { EffectType type = 1; Color color = 2; Vector offset = 3; float radius = 4; bool visible = 5; BlendMode blendMode = 6; float spread = 7; bool showShadowBehindNode = 8; }
message FontName { string family = 1; string style = 2; string postscript = 3; }
message TextLineData { string lineType = 1; uint styleId = 2; uint indentationLevel = 3; string sourceDirectionality = 4; uint listStartOffset = 5; bool isFirstLineOfList = 6; }
message TextData { string characters = 1; TextLineData[] lines = 2; uint[] characterStyleIDs = 3; NodeChange[] styleOverrideTable = 4; }
message GUIDPath { GUID[] guids = 1; }
enum WindingRule { NONZERO = 0; ODD = 1; }
message Path { WindingRule windingRule = 1; uint commandsBlob = 2; }
message ComponentPropValue { bool boolValue = 1; TextData textValue = 2; GUID guidValue = 3; float floatValue = 4; }
message InstanceSwapPreferredValue { InstanceSwapPreferredValueType type = 1; string key = 2; }
message ComponentPropPreferredValues { string[] stringValues = 1; InstanceSwapPreferredValue[] instanceSwapValues = 2; }
message ComponentPropDef { GUID id = 1; string name = 2; ComponentPropValue initialValue = 3; string sortPosition = 4; GUID parentPropDefId = 5; ComponentPropType type = 6; bool isDeleted = 7; ComponentPropPreferredValues preferredValues = 8; VariableData varValue = 9; string description = 10; }
message ComponentPropAssignment { GUID defID = 1; ComponentPropValue value = 2; VariableData varValue = 3; }
message ComponentPropRef { uint nodeField = 1; GUID defID = 2; string zombieFallbackName = 3; ComponentPropNodeField componentPropNodeField = 4; bool isDeleted = 5; }
message VariantPropSpec { GUID propDefId = 1; string value = 2; }
message StateGroupPropertyValueOrder { string property = 1; string[] values = 2; }
message SymbolData { GUID symbolID = 1; NodeChange[] symbolOverrides = 2; float uniformScaleFactor = 3; }
message OptionalVector { Vector value = 1; }
message VariableSetID { GUID guid = 1; AssetRef assetRef = 2; }
message VariableSetMode { GUID id = 1; string name = 2; string sortPosition = 3; }
message VariableDataValuesEntry { GUID modeID = 1; VariableData variableData = 2; }
message VariableDataValues { VariableDataValuesEntry[] entries = 1; }
message VariableDataMapEntry { VariableData variableData = 1; VariableField variableField = 2; }
message VariableDataMap { VariableDataMapEntry[] entries = 1; }
message CodeSyntaxMapEntry { CodeSyntaxPlatform platform = 1; string value = 2; }
message CodeSyntaxMap { CodeSyntaxMapEntry[] entries = 1; }
message NodeChange {
  GUID guid = 1; NodePhase phase = 2; ParentIndex parentIndex = 3; NodeType type = 4; string name = 5;
  bool visible = 6; float opacity = 7; Vector size = 8; Matrix transform = 9; Paint[] fillPaints = 10;
  float fontSize = 11; FontName fontName = 12; TextData textData = 13; Color backgroundColor = 14;
  bool internalOnly = 15; SymbolData symbolData = 16; string unknownFutureField = 17;
  float strokeWeight = 18; StrokeAlign strokeAlign = 19; StrokeJoin strokeJoin = 20; Paint[] strokePaints = 21;
  Effect[] effects = 22; float cornerRadius = 23; bool frameMaskDisabled = 24; BlendMode blendMode = 25;
  StackMode stackMode = 26; float stackSpacing = 27; float stackHorizontalPadding = 28; float stackVerticalPadding = 29;
  float stackPaddingRight = 30; float stackPaddingBottom = 31; StackSize stackPrimarySizing = 32; StackSize stackCounterSizing = 33;
  StackJustify stackPrimaryAlignItems = 34; StackAlign stackCounterAlignItems = 35; float stackChildPrimaryGrow = 36;
  StackCounterAlign stackChildAlignSelf = 37; StackPositioning stackPositioning = 38; StackWrap stackWrap = 39; float stackCounterSpacing = 40;
  bool bordersTakeSpace = 41; OptionalVector minSize = 42; OptionalVector maxSize = 43;
  Number lineHeight = 44; Number letterSpacing = 45; TextAutoResize textAutoResize = 46; TextAlignHorizontal textAlignHorizontal = 47;
  TextAlignVertical textAlignVertical = 48; bool autoRename = 49; bool locked = 50; string description = 51;
  bool rectangleCornerRadiiIndependent = 52; float rectangleTopLeftCornerRadius = 53; float rectangleTopRightCornerRadius = 54;
  float rectangleBottomLeftCornerRadius = 55; float rectangleBottomRightCornerRadius = 56;
  VariableSetMode[] variableSetModes = 57; VariableSetID variableSetID = 58; VariableResolvedDataType variableResolvedType = 59;
  VariableDataValues variableDataValues = 60; VariableDataMap variableConsumptionMap = 61; bool isPublishable = 62;
  bool isCollectionExtendable = 63; CodeSyntaxMap codeSyntax = 64; GUIDPath guidPath = 65; bool backgroundEnabled = 66;
  float backgroundOpacity = 67; bool mask = 68; uint styleID = 69;
  bool isStateGroup = 70; StateGroupPropertyValueOrder[] stateGroupPropertyValueOrders = 71; ComponentPropDef[] componentPropDefs = 72;
  ComponentPropRef[] componentPropRefs = 73; VariantPropSpec[] variantPropSpecs = 74; ComponentPropAssignment[] componentPropAssignments = 75;
  VariableDataMap parameterConsumptionMap = 76; GUID overriddenSymbolID = 77; bool isSymbolPublishable = 78; string componentKey = 79;
  Path[] fillGeometry = 80; Path[] strokeGeometry = 81; NodeChange[] derivedSymbolData = 82;
  VariableModeBySetMap variableModeBySetMap = 83;
  string key = 84; StyleType styleType = 85; string styleDescription = 86; string version = 87; string sortPosition = 88;
  StyleId styleIdForFill = 89; StyleId styleIdForStrokeFill = 90; StyleId styleIdForText = 91; StyleId styleIdForEffect = 92;
  StyleId styleIdForGrid = 93; TextCase textCase = 94; TextDecoration textDecoration = 95; float paragraphSpacing = 96;
  float paragraphIndent = 97; VectorData vectorData = 98; StrokeCap strokeCap = 99;
}
message VectorData { uint vectorNetworkBlob = 1; Vector normalizedSize = 2; }
enum StrokeCap { NONE = 0; ROUND = 1; SQUARE = 2; }
enum StyleType { NONE = 0; FILL = 1; STROKE = 2; TEXT = 3; EFFECT = 4; EXPORT = 5; GRID = 6; }
enum TextCase { ORIGINAL = 0; UPPER = 1; LOWER = 2; TITLE = 3; SMALL_CAPS = 4; SMALL_CAPS_FORCED = 5; }
enum TextDecoration { NONE = 0; UNDERLINE = 1; STRIKETHROUGH = 2; }
message StyleId { GUID guid = 1; AssetRef assetRef = 2; }
message VariableModeBySetMapEntry { VariableSetID variableSetID = 1; GUID variableModeID = 2; VariableSetID variableSetExtensionID = 3; }
message VariableModeBySetMap { VariableModeBySetMapEntry[] entries = 1; }
message Blob { byte[] bytes = 1; }
message Message { MessageType type = 1; NodeChange[] nodeChanges = 2; Blob[] blobs = 3; }
`;

const I = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const at = (x: number, y: number) => ({ ...I, m02: x, m12: y });
const g = (s: number, l: number) => ({ sessionID: s, localID: l });
const parent = (s: number, l: number, position: string) => ({ guid: g(s, l), position });

export const IMAGE_HASH = 'aa'.repeat(20);

export function syntheticMessage(): Message {
  return {
    type: 'NODE_CHANGES',
    nodeChanges: [
      { guid: g(0, 0), phase: 'CREATED', type: 'DOCUMENT', name: 'Document', visible: true, opacity: 1 },
      {
        guid: g(0, 1),
        phase: 'CREATED',
        type: 'CANVAS',
        name: 'Page 1',
        parentIndex: parent(0, 0, '!'),
        backgroundColor: { r: 0.9, g: 0.9, b: 0.9, a: 1 },
      },
      {
        guid: g(0, 2),
        phase: 'CREATED',
        type: 'CANVAS',
        name: 'Internal Only Canvas',
        parentIndex: parent(0, 0, '~'),
        internalOnly: true,
      },
      {
        guid: g(1, 2),
        phase: 'CREATED',
        type: 'FRAME',
        name: 'Screen',
        parentIndex: parent(0, 1, '!'),
        size: { x: 390, y: 800 },
        transform: at(0, 0),
        fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }],
      },
      {
        guid: g(1, 4),
        phase: 'CREATED',
        type: 'TEXT',
        name: 'Title',
        parentIndex: parent(1, 2, '"'), // sorts after "!" → second child
        size: { x: 200, y: 30 },
        transform: at(20, 100),
        fontSize: 24,
        fontName: { family: 'Inter', style: 'Bold', postscript: 'Inter-Bold' },
        textData: { characters: 'Hello' },
        unknownFutureField: 'keep me',
      },
      {
        guid: g(1, 3),
        phase: 'CREATED',
        type: 'ROUNDED_RECTANGLE',
        name: 'Photo',
        parentIndex: parent(1, 2, '!'),
        size: { x: 100, y: 50 },
        transform: at(20, 20),
        fillPaints: [
          {
            type: 'IMAGE',
            opacity: 1,
            visible: true,
            image: { hash: new Uint8Array(20).fill(0xaa), name: 'p' },
          },
        ],
      },
      {
        guid: g(1, 5),
        phase: 'CREATED',
        type: 'FRAME',
        name: 'Hidden',
        parentIndex: parent(0, 1, '#'),
        visible: false,
        size: { x: 10, y: 10 },
        transform: at(500, 0),
      },
    ],
    blobs: [],
  };
}

export interface SyntheticOptions {
  compression?: 'zstd' | 'deflate-raw';
  message?: Message;
  fileName?: string;
}

/** Returns the bytes of a complete synthetic .fig archive. */
export function syntheticFig(opts: SyntheticOptions = {}): Uint8Array {
  const schema = kiwi.parseSchema(SYNTHETIC_SCHEMA);
  const compiled = kiwi.compileSchema(schema);
  const schemaBytes: Uint8Array = kiwi.encodeBinarySchema(schema);
  const msgBytes: Uint8Array = compiled.encodeMessage(opts.message ?? syntheticMessage());
  const msgChunk =
    (opts.compression ?? 'zstd') === 'zstd' ? zstdCompressSync(msgBytes) : deflateRawSync(msgBytes);
  const canvas = serializeFigKiwi({
    magic: 'fig-kiwi',
    version: 106,
    chunks: [new Uint8Array(deflateRawSync(schemaBytes)), new Uint8Array(msgChunk)],
  });
  const meta = {
    client_meta: {
      background_color: { r: 0.9, g: 0.9, b: 0.9, a: 1 },
      thumbnail_size: { width: 4, height: 4 },
    },
    file_name: opts.fileName ?? 'Synthetic',
    developer_related_links: [],
    exported_at: '2026-11-24T00:00:00.000Z',
  };
  const parts: Uint8Array[] = [];
  writeZip(
    [
      { name: 'canvas.fig', data: canvas, method: METHOD_STORED },
      { name: 'thumbnail.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), method: METHOD_STORED },
      { name: 'meta.json', data: new TextEncoder().encode(JSON.stringify(meta)), method: METHOD_DEFLATE },
      { name: 'images/', data: new Uint8Array(0) },
      { name: `images/${IMAGE_HASH}`, data: new Uint8Array([1, 2, 3, 4]) },
    ],
    { write: (b) => parts.push(b) },
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
