/**
 * Notes about Figtional's font limitation, added to a tool result only when it affected that
 * result: text in a font that isn't installed is measured (use_figma) or drawn (screenshots) with a
 * replacement, so sizes and looks can differ from Figma. The tool's own output stays as Figma's;
 * the note is a separate text block, worded as a Figtional limitation (CLAUDE.md rule 4).
 */

type Fallbacks = Map<string, string | undefined>;

const list = (f: Fallbacks, verb: string) =>
  [...f]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([font, used]) =>
        `"${font}" (${used ? `${verb} with ${used}` : `no fonts installed: ${verb} approximately`})`,
    )
    .join(', ');

/** use_figma: text measured with replacement fonts. */
export function measuredFontNote(f: Fallbacks): string | undefined {
  if (!f.size) return undefined;
  return (
    `Figtional limitation: ${f.size === 1 ? 'this font is' : 'these fonts are'} not installed on this computer, ` +
    `so Figtional measured text in ${f.size === 1 ? 'it' : 'them'} with a replacement: ${list(f, 'measured')}. ` +
    'Text sizes, and the auto layout around them, may differ slightly when the file is opened in Figma, ' +
    'which uses the real fonts. Installing the fonts avoids this.'
  );
}

/** Screenshots: edited text drawn with replacement fonts. */
export function drawnFontNote(f: Fallbacks): string | undefined {
  if (!f.size) return undefined;
  return (
    `Figtional limitation: ${f.size === 1 ? 'this font is' : 'these fonts are'} not installed on this computer, ` +
    `so edited text in the screenshot is drawn with a replacement: ${list(f, 'drawn')}. ` +
    'Figma would show the real fonts.'
  );
}
