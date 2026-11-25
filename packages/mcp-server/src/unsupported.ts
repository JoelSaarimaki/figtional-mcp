/** Thrown for Plugin API features Figtional doesn't implement (worded as a Figtional limitation). */
export class FigtionalUnsupported extends Error {
  constructor(api: string, detail = '') {
    super(
      `NotSupportedInFigtional: ${api}. This is a limitation of Figtional (the local Figma MCP stand-in), not of Figma.${detail ? ' ' + detail : ''}`,
    );
  }
}
