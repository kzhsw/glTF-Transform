import { GraphEdge } from 'property-graph';
import { BufferViewUsage } from '../constants';
import type { Property } from '../properties';

export type Ref = GraphEdge<Property, Property>;
export type RefMap = { [key: string]: Ref };
export type UnknownRef = Ref | Ref[] | RefMap | unknown;

export function equalsRef(refA: Ref, refB: Ref): boolean {
	if (!!refA !== !!refB) return false;

	const a = refA.getChild();
	const b = refB.getChild();

	return a === b || a.equals(b);
}

export function equalsRefList(refListA: Ref[], refListB: Ref[]): boolean {
	if (!!refListA !== !!refListB) return false;
	if (refListA.length !== refListB.length) return false;

	for (let i = 0; i < refListA.length; i++) {
		const a = refListA[i];
		const b = refListB[i];

		if (a.getChild() === b.getChild()) continue;

		if (!a.getChild().equals(b.getChild())) return false;
	}

	return true;
}

export function equalsRefMap(refMapA: RefMap, refMapB: RefMap): boolean {
	if (!!refMapA !== !!refMapB) return false;

	const keysA = Object.keys(refMapA);
	const keysB = Object.keys(refMapB);
	if (keysA.length !== keysB.length) return false;

	for (const key in refMapA) {
		const refA = refMapA[key];
		const refB = refMapB[key];
		if (!!refA !== !!refB) return false;

		const a = refA.getChild();
		const b = refB.getChild();
		if (a === b) continue;

		if (!a.equals(b)) return false;
	}

	return true;
}

export function equalsArray(a: ArrayLike<unknown> | null, b: ArrayLike<unknown> | null): boolean {
	if (a === b) return true;

	if (!!a !== !!b || !a || !b) return false;

	if (a.length !== b.length) return false;

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}

	return true;
}

export type RefAttributes = Record<string, unknown>;

export interface AccessorRefAttributes extends RefAttributes {
	/** Usage role of an accessor reference. */
	usage: BufferViewUsage | string;
}

export interface TextureRefAttributes extends RefAttributes {
	/** Bitmask for {@link TextureChannel TextureChannels} used by a texture reference. */
	channels: number;
}