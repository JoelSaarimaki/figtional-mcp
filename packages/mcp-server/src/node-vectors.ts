/** Plugin API node members: Vector paths and networks. Mixed into the node class by createFigmaApi. */
import { type VectorNetwork, encodeVectorNetwork } from '@figtional/fig-format';
import { type Subpath, networkToPathData, parsePathData, transformSubpaths } from '@figtional/fig-model';
import { IDENTITY_T, deepFreeze } from './plugin-values.js';
import { NodeMembers, type PluginRuntime } from './plugin-runtime.js';

export function vectorsMembers(rt: PluginRuntime) {
  const { dynamicPage, editRaw, networkOf, session, typeError, vectorFields } = rt;
  return class VectorsMembers extends NodeMembers {
    // ------------------------------------------------ polygons, stars, arcs
    get pointCount(): number {
      if (this.type !== 'POLYGON' && this.type !== 'STAR') throw typeError('pointCount', this.type);
      return this._d.count ?? (this.type === 'STAR' ? 5 : 3);
    }
    set pointCount(v: number) {
      if (this.type !== 'POLYGON' && this.type !== 'STAR') throw typeError('pointCount', this.type);
      if (!Number.isInteger(v) || v < 3) throw new Error('pointCount must be an integer of at least 3');
      editRaw(this.id, { count: v });
      session.invalidateGeometry(session.raw(this.id));
    }
    get innerRadius(): number {
      if (this.type !== 'STAR') throw typeError('innerRadius', this.type);
      return this._d.starInnerScale ?? 0.382;
    }
    set innerRadius(v: number) {
      if (this.type !== 'STAR') throw typeError('innerRadius', this.type);
      if (typeof v !== 'number' || v < 0 || v > 1) throw new Error('innerRadius must be between 0 and 1');
      editRaw(this.id, { starInnerScale: v });
      session.invalidateGeometry(session.raw(this.id));
    }
    get arcData() {
      if (this.type !== 'ELLIPSE') throw typeError('arcData', this.type);
      const a = this._d.arcData ?? {};
      return {
        startingAngle: a.startingAngle ?? 0,
        endingAngle: a.endingAngle ?? 2 * Math.PI,
        innerRadius: a.innerRadius ?? 0,
      };
    }
    set arcData(v: { startingAngle: number; endingAngle: number; innerRadius: number }) {
      if (this.type !== 'ELLIPSE') throw typeError('arcData', this.type);
      if (
        typeof v?.startingAngle !== 'number' ||
        typeof v?.endingAngle !== 'number' ||
        typeof v?.innerRadius !== 'number'
      )
        throw new Error('arcData must be { startingAngle, endingAngle, innerRadius }');
      if (v.innerRadius < 0 || v.innerRadius > 1)
        throw new Error('arcData.innerRadius must be between 0 and 1');
      editRaw(this.id, {
        arcData: { startingAngle: v.startingAngle, endingAngle: v.endingAngle, innerRadius: v.innerRadius },
      });
      session.invalidateGeometry(session.raw(this.id));
    }

    // ------------------------------------------------ boolean operations
    get booleanOperation(): string {
      if (this.type !== 'BOOLEAN_OPERATION') throw typeError('booleanOperation', this.type);
      const op = this._d.booleanOperation ?? 'UNION';
      return op === 'XOR' ? 'EXCLUDE' : op;
    }
    set booleanOperation(v: string) {
      if (this.type !== 'BOOLEAN_OPERATION') throw typeError('booleanOperation', this.type);
      if (!['UNION', 'INTERSECT', 'SUBTRACT', 'EXCLUDE'].includes(v))
        throw new Error(`Invalid booleanOperation "${v}"`);
      // A changed operation invalidates Figma's stored result.
      editRaw(this.id, {
        booleanOperation: v === 'EXCLUDE' ? 'XOR' : v,
        fillGeometry: [],
        strokeGeometry: [],
      });
    }

    // ------------------------------------------------ vectors
    requireVector(prop: string) {
      if (this.type !== 'VECTOR') throw typeError(prop, this.type);
    }
    get vectorPaths() {
      this.requireVector('vectorPaths');
      const net: VectorNetwork = networkOf(this._d);
      const ns = this._d.vectorData?.normalizedSize;
      const sx = ns?.x ? this.width / ns.x : 1;
      const sy = ns?.y ? this.height / ns.y : 1;
      const spaced = (d: string) =>
        d
          .replace(/([MLCZ])/g, ' $1 ')
          .replace(/\s+/g, ' ')
          .trim();
      if (!net.regions.length)
        return net.segments.length
          ? [{ windingRule: 'NONE', data: spaced(networkToPathData(net, sx, sy)) }]
          : [];
      return net.regions.map((r) => ({
        windingRule: r.windingRule === 'ODD' ? 'EVENODD' : 'NONZERO',
        data: spaced(networkToPathData({ ...net, regions: [r] }, sx, sy, true)),
      }));
    }
    set vectorPaths(v: { windingRule: string; data: string }[]) {
      this.requireVector('vectorPaths');
      if (!Array.isArray(v)) throw new Error('vectorPaths must be an array of { windingRule, data }');
      const filled: Subpath[] = [];
      const open: Subpath[] = [];
      let rule: 'NONZERO' | 'ODD' = 'NONZERO';
      v.forEach((p, i) => {
        if (!['NONZERO', 'EVENODD', 'NONE'].includes(p?.windingRule))
          throw new Error(`Invalid windingRule at [${i}]: expected "NONZERO", "EVENODD" or "NONE"`);
        const paths = parsePathData(String(p.data ?? ''));
        if (p.windingRule === 'NONE') open.push(...paths);
        else {
          filled.push(...paths);
          if (p.windingRule === 'EVENODD') rule = 'ODD';
        }
      });
      const t = this._d.transform ?? IDENTITY_T;
      const toParent = { m00: 1, m01: 0, m02: t.m02, m10: 0, m11: 1, m12: t.m12 };
      editRaw(
        this.id,
        vectorFields(
          transformSubpaths(filled, toParent),
          filled.length ? rule : null,
          transformSubpaths(open, toParent),
        ),
      );
      session.invalidateGeometry(session.raw(this.id));
    }
    get vectorNetwork() {
      this.requireVector('vectorNetwork');
      const net: VectorNetwork = networkOf(this._d);
      return deepFreeze({
        vertices: net.vertices.map((p) => ({ x: p.x, y: p.y })),
        segments: net.segments.map((s) => ({
          start: s.start,
          end: s.end,
          tangentStart: { ...s.tangentStart },
          tangentEnd: { ...s.tangentEnd },
        })),
        regions: net.regions.map((r) => ({
          windingRule: r.windingRule === 'ODD' ? 'EVENODD' : 'NONZERO',
          loops: r.loops.map((l) => [...l]),
        })),
      });
    }
    set vectorNetwork(_v: unknown) {
      throw dynamicPage('vectorNetwork', 'setVectorNetworkAsync');
    }
    async setVectorNetworkAsync(v: any) {
      this.requireVector('setVectorNetworkAsync');
      const vertices = (v?.vertices ?? []).map((p: any) => ({ x: Number(p.x), y: Number(p.y), styleID: 0 }));
      const segments = (v?.segments ?? []).map((s: any, i: number) => {
        if (vertices[s.start] === undefined || vertices[s.end] === undefined)
          throw new Error(`Invalid vertex index in segments[${i}]`);
        return {
          styleID: 0,
          start: s.start,
          end: s.end,
          tangentStart: { x: s.tangentStart?.x ?? 0, y: s.tangentStart?.y ?? 0 },
          tangentEnd: { x: s.tangentEnd?.x ?? 0, y: s.tangentEnd?.y ?? 0 },
        };
      });
      const regions = (v?.regions ?? []).map((r: any) => ({
        styleID: 0,
        windingRule: r.windingRule === 'EVENODD' ? 'ODD' : 'NONZERO',
        loops: (r.loops ?? []).map((l: number[]) => [...l]),
      }));
      const xs = vertices.map((p: any) => p.x);
      const ys = vertices.map((p: any) => p.y);
      const w = xs.length ? Math.max(...xs) - Math.min(0, ...xs) : 0;
      const h = ys.length ? Math.max(...ys) - Math.min(0, ...ys) : 0;
      const size = { x: Math.max(w, 0.01), y: Math.max(h, 0.01) };
      editRaw(this.id, {
        size,
        vectorData: {
          vectorNetworkBlob: session.addBlob(encodeVectorNetwork({ vertices, segments, regions })),
          normalizedSize: { ...size },
        },
      });
      session.invalidateGeometry(session.raw(this.id));
    }
  };
}
