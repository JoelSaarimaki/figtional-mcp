/**
 * The shared state and helpers that the Plugin API's node member modules use (built in
 * createFigmaApi). Member modules are classes whose members are copied onto the node class.
 */
import type { NodeChange } from '@figtional/fig-format';
import type { SceneNode } from '@figtional/fig-model';

export type PluginRuntime = Record<string, any>;

/** Typing base for member classes: members of other modules are reached through `this`. */
export class NodeMembers {
  [key: string]: any;
  declare readonly id: string;
  /** The scene node and its raw node change (getters on the node class). */
  declare readonly _s: SceneNode;
  declare readonly _d: NodeChange;
}

/** Copies the members of each class onto `target`'s prototype. */
export function mixMembers(target: { prototype: object }, ...sources: { prototype: object }[]): void {
  for (const source of sources) {
    for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(source.prototype))) {
      if (key !== 'constructor') Object.defineProperty(target.prototype, key, desc);
    }
  }
}
