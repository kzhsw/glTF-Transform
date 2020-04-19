import { GLB_BUFFER } from '../constants';
import { Container } from '../container';
import { Link } from '../graph';
import { Accessor, AttributeLink, Buffer, IndexLink, Material, Mesh, Node, Primitive, Property, Root, Texture, TextureInfo } from '../properties';
import { BufferUtils } from '../utils';
import { Asset } from './asset';

type PropertyDef = GLTF.IScene | GLTF.INode | GLTF.IMaterial | GLTF.ISkin | GLTF.ITexture;

const BufferViewTarget = {
	ARRAY_BUFFER: 34962,
	ELEMENT_ARRAY_BUFFER: 34963
};

export interface WriterOptions {
	basename: string;
	isGLB: boolean;
}

export class GLTFWriter {
	public static write(container: Container, options: WriterOptions): Asset {
		const root = container.getRoot();
		const asset = {json: {asset: root.getAsset()}, resources: {}} as Asset;
		const json = asset.json;

		const numBuffers = root.listBuffers().length;
		const numImages = root.listTextures().length;
		const bufferURIGenerator = new UniqueURIGenerator(numBuffers> 1, options.basename);
		const imageURIGenerator = new UniqueURIGenerator(numImages > 1, options.basename);

		/* Lookup tables. */

		const accessorIndexMap = new Map<Accessor, number>();
		const materialIndexMap = new Map<Material, number>();
		const meshIndexMap = new Map<Mesh, number>();
		const nodeIndexMap = new Map<Node, number>();
		const imageIndexMap = new Map<Texture, number>();
		const textureIndexMap = new Map<string, number>(); // textureDef JSON -> index
		const samplerIndexMap = new Map<string, number>(); // samplerDef JSON -> index

		const imageData: ArrayBuffer[] = [];

		/* Utilities. */

		interface BufferViewResult {
			byteLength: number;
			buffers: ArrayBuffer[];
		}

		/**
		* Pack a group of accessors into a sequential buffer view. Appends accessor and buffer view
		* definitions to the root JSON lists.
		*
		* @param accessors Accessors to be included.
		* @param bufferIndex Buffer to write to.
		* @param bufferByteOffset Current offset into the buffer, accounting for other buffer views.
		* @param bufferViewTarget (Optional) target use of the buffer view.
		*/
		function concatAccessors(accessors: Accessor[], bufferIndex: number, bufferByteOffset: number, bufferViewTarget?: number): BufferViewResult {
			const buffers: ArrayBuffer[] = [];
			let byteLength = 0;

			// Create accessor definitions, determining size of final buffer view.
			for (const accessor of accessors) {
				const accessorDef = createAccessorDef(accessor);
				accessorDef.bufferView = json.bufferViews.length;
				// TODO(feat): accessorDef.sparse

				const data = BufferUtils.pad(accessor.getArray().buffer);
				accessorDef.byteOffset = byteLength;
				byteLength += data.byteLength;
				buffers.push(data);

				accessorIndexMap.set(accessor, json.accessors.length);
				json.accessors.push(accessorDef);
			}

			// Create buffer view definition.
			const bufferViewData = BufferUtils.concat(buffers);
			const bufferViewDef: GLTF.IBufferView = {
				buffer: bufferIndex,
				byteOffset: bufferByteOffset,
				byteLength: bufferViewData.byteLength,
			};
			if (bufferViewTarget) bufferViewDef.target = bufferViewTarget;
			json.bufferViews.push(bufferViewDef);

			return {buffers, byteLength}
		}

		/**
		* Pack a group of accessors into an interleaved buffer view. Appends accessor and buffer view
		* definitions to the root JSON lists. Buffer view target is implicitly attribute data.
		*
		* References:
		* - [Apple • Best Practices for Working with Vertex Data](https://developer.apple.com/library/archive/documentation/3DDrawing/Conceptual/OpenGLES_ProgrammingGuide/TechniquesforWorkingwithVertexData/TechniquesforWorkingwithVertexData.html)
		* - [Khronos • Vertex Specification Best Practices](https://www.khronos.org/opengl/wiki/Vertex_Specification_Best_Practices)
		*
		* @param accessors Accessors to be included.
		* @param bufferIndex Buffer to write to.
		* @param bufferByteOffset Current offset into the buffer, accounting for other buffer views.
		*/
		function interleaveAccessors(accessors: Accessor[], bufferIndex: number, bufferByteOffset: number): BufferViewResult {
			const vertexCount = accessors[0].getCount();
			let byteStride = 0;

			// Create accessor definitions, determining size and stride of final buffer view.
			for (const accessor of accessors) {
				const accessorDef = createAccessorDef(accessor);
				accessorDef.bufferView = json.bufferViews.length;
				accessorDef.byteOffset = byteStride;

				const itemSize = accessor.getItemSize();
				const valueSize = accessor.getComponentSize();
				byteStride += BufferUtils.padNumber(itemSize * valueSize);

				accessorIndexMap.set(accessor, json.accessors.length);
				json.accessors.push(accessorDef);
			}

			// Allocate interleaved buffer view.
			const byteLength = vertexCount * byteStride;
			const buffer = new ArrayBuffer(byteLength);
			const view = new DataView(buffer);

			// Write interleaved accessor data to the buffer view.
			for (let i = 0; i < vertexCount; i++) {
				let vertexByteOffset = 0;
				for (const accessor of accessors) {
					const itemSize = accessor.getItemSize();
					const valueSize = accessor.getComponentSize();
					const componentType = accessor.getComponentType();
					const array = accessor.getArray();
					for (let j = 0; j < itemSize; j++) {
						const viewByteOffset = i * byteStride + vertexByteOffset + j * valueSize;
						const value = array[i * itemSize + j];
						switch (componentType) {
							case GLTF.AccessorComponentType.FLOAT:
								view.setFloat32(viewByteOffset, value, true);
								break;
							case GLTF.AccessorComponentType.BYTE:
								view.setInt8(viewByteOffset, value);
								break;
							case GLTF.AccessorComponentType.SHORT:
								view.setInt16(viewByteOffset, value, true);
								break;
							case GLTF.AccessorComponentType.UNSIGNED_BYTE:
								view.setUint8(viewByteOffset, value);
								break;
							case GLTF.AccessorComponentType.UNSIGNED_SHORT:
								view.setUint16(viewByteOffset, value, true);
								break;
							case GLTF.AccessorComponentType.UNSIGNED_INT:
								view.setUint32(viewByteOffset, value, true);
								break;
							default:
								throw new Error('Unexpected component type: ' + componentType);
						}
					}
					vertexByteOffset += BufferUtils.padNumber(itemSize * valueSize);
				}
			}

			// Create buffer view definition.
			const bufferViewDef: GLTF.IBufferView = {
				buffer: bufferIndex,
				byteOffset: bufferByteOffset,
				byteLength: byteLength,
				byteStride: byteStride,
				target: BufferViewTarget.ARRAY_BUFFER,
			};
			json.bufferViews.push(bufferViewDef);

			return {byteLength, buffers: [buffer]};
		}

		/**
		 * Creates a TextureInfo definition, and any Texture or Sampler definitions it requires. If
		 * possible, Texture and Sampler definitions are shared.
		 */
		function createTextureInfoDef(texture: Texture, textureInfo: TextureInfo): GLTF.ITextureInfo {
			const samplerDef = {
				magFilter: textureInfo.getMagFilter() || undefined,
				minFilter: textureInfo.getMinFilter() || undefined,
				wrapS: textureInfo.getWrapS(),
				wrapT: textureInfo.getWrapT(),
			} as GLTF.ISampler;

			const samplerKey = JSON.stringify(samplerDef);
			if (!samplerIndexMap.has(samplerKey)) {
				samplerIndexMap.set(samplerKey, json.samplers.length);
				json.samplers.push(samplerDef);
			}

			const textureDef = {
				source: imageIndexMap.get(texture),
				sampler: samplerIndexMap.get(samplerKey)
			} as GLTF.ITexture;

			const textureKey = JSON.stringify(textureDef);
			if (!textureIndexMap.has(textureKey)) {
				textureIndexMap.set(textureKey, json.textures.length);
				json.textures.push(textureDef);
			}

			return {
				index: textureIndexMap.get(textureKey),
				texCoord: textureInfo.getTexCoord(),
			} as GLTF.ITextureInfo;
		}

		/* Data use pre-processing. */

		const accessorLinks = new Map<Accessor, Link<Property, Accessor>[]>();

		// Gather all accessors, creating a map to look up their uses.
		for (const link of container.getGraph().getLinks()) {
			if (link.getParent() === root) continue;

			const child = link.getChild();

			if (child instanceof Accessor) {
				const uses = accessorLinks.get(child) || [];
				uses.push(link as Link<Property, Accessor>);
				accessorLinks.set(child, uses);
			}
		}

		json.accessors = [];
		json.bufferViews = [];

		/* Textures. */

		// glTF-Transform's "Texture" properties correspond 1:1 with glTF "Image" properties, and
		// with image files. The glTF file may contain more one texture per image, where images
		// are reused with different sampler properties.
		json.samplers = [];
		json.textures = [];
		json.images = root.listTextures().map((texture, textureIndex) => {
			const imageDef = createPropertyDef(texture) as GLTF.IImage;

			if (texture.getMimeType()) {
				imageDef.mimeType = texture.getMimeType() as GLTF.ImageMimeType;
			}

			if (options.isGLB) {
				imageData.push(texture.getImage());
				imageDef.bufferView = json.bufferViews.length;
				json.bufferViews.push({
					buffer: 0,
					byteOffset: -1, // determined while iterating buffers, below.
					byteLength: texture.getImage().byteLength
				});
			} else {
				const extension = texture.getMimeType() === 'image/png' ? 'png' : 'jpeg';
				imageDef.uri = imageURIGenerator.createURI(texture, extension);
				asset.resources[imageDef.uri] = texture.getImage();
			}

			imageIndexMap.set(texture, textureIndex);
			return imageDef;
		});

		/* Buffers, buffer views, and accessors. */

		json.buffers = [];
		root.listBuffers().forEach((buffer, bufferIndex) => {
			const bufferDef = createPropertyDef(buffer) as GLTF.IBuffer;

			// Attributes are grouped and interleaved in one buffer view per mesh primitive. Indices for
			// all primitives are grouped into a single buffer view. Everything else goes into a
			// miscellaneous buffer view.
			const attributeAccessors = new Map<Primitive, Set<Accessor>>();
			const indexAccessors = new Set<Accessor>();
			const otherAccessors = new Set<Accessor>();

			const bufferParents = buffer.listParents()
				.filter((property) => !(property instanceof Root)) as Property[];

			// Categorize accessors by use.
			for (const parent of bufferParents) {
				if ((!(parent instanceof Accessor))) { // Not expected.
					throw new Error('Unimplemented buffer reference: ' + parent);
				}

				let isAttribute = false;
				let isIndex = false;
				let isOther = false;

				const accessorRefs = accessorLinks.get(parent) || [];

				for (const link of accessorRefs) {
					if (link instanceof AttributeLink) {
						isAttribute = true;
					} else if (link instanceof IndexLink) {
						isIndex = true;
					} else {
						isOther = true;
					}
				}

				// If the Accessor isn't used at all, treat it as "other".
				if (!isAttribute && !isIndex && !isOther) isOther = true;

				if (isAttribute && !isIndex && !isOther) {
					const primitive = accessorRefs[0].getParent() as Primitive;
					const primitiveAccessors = attributeAccessors.get(primitive) || new Set<Accessor>();
					primitiveAccessors.add(parent);
					attributeAccessors.set(primitive, primitiveAccessors);
				} else if (isIndex && !isAttribute && !isOther) {
					indexAccessors.add(parent);
				} else if (isOther && !isAttribute && !isIndex) {
					otherAccessors.add(parent);
				} else {
					throw new Error('Attribute or index accessors must be used only for that purpose.');
				}
			}

			// Write accessor groups to buffer views.

			const buffers: ArrayBuffer[] = [];
			let bufferByteLength = 0;

			if (indexAccessors.size) {
				const indexResult = concatAccessors(Array.from(indexAccessors), bufferIndex, bufferByteLength, BufferViewTarget.ELEMENT_ARRAY_BUFFER);
				bufferByteLength += indexResult.byteLength;
				buffers.push(...indexResult.buffers);
			}

			for (const primitiveAccessors of attributeAccessors.values()) {
				if (primitiveAccessors.size) {
					const primitiveResult = interleaveAccessors(Array.from(primitiveAccessors), bufferIndex, bufferByteLength);
					bufferByteLength += primitiveResult.byteLength;
					buffers.push(...primitiveResult.buffers);
				}
			}

			if (otherAccessors.size) {
				const otherResult = concatAccessors(Array.from(otherAccessors), bufferIndex, bufferByteLength);
				bufferByteLength += otherResult.byteLength;
				buffers.push(...otherResult.buffers);
			}

			// We only support embedded images in GLB, so we know there is only one buffer.
			if (imageData.length) {
				for (let i = 0; i < imageData.length; i++) {
					json.bufferViews[json.images[i].bufferView].byteOffset = bufferByteLength;
					bufferByteLength += imageData[i].byteLength;
					buffers.push(imageData[i]);
				}
			}

			if (!bufferByteLength) return;

			// Assign buffer URI.

			let uri: string;
			if (options.isGLB) {
				uri = GLB_BUFFER;
			} else {
				uri = bufferURIGenerator.createURI(buffer, 'bin');
				bufferDef.uri = uri;
			}

			// Write buffer views to buffer.

			bufferDef.byteLength = bufferByteLength;
			asset.resources[uri] = BufferUtils.concat(buffers);

			json.buffers.push(bufferDef);
		});

		/* Materials. */

		json.materials = root.listMaterials().map((material, index) => {
			const materialDef = createPropertyDef(material) as GLTF.IMaterial;

			// Program state & blending.

			materialDef.alphaMode = material.getAlphaMode();
			if (material.getAlphaMode() === GLTF.MaterialAlphaMode.MASK) {
				materialDef.alphaCutoff = material.getAlphaCutoff();
			}
			materialDef.doubleSided = material.getDoubleSided();

			// Factors.

			materialDef.pbrMetallicRoughness = {};
			materialDef.pbrMetallicRoughness.baseColorFactor = material.getBaseColorFactor();
			materialDef.emissiveFactor = material.getEmissiveFactor();
			materialDef.pbrMetallicRoughness.roughnessFactor = material.getRoughnessFactor();
			materialDef.pbrMetallicRoughness.metallicFactor = material.getMetallicFactor();

			// Textures.

			if (material.getBaseColorTexture()) {
				const texture = material.getBaseColorTexture();
				const textureInfo = material.getBaseColorTextureInfo();
				materialDef.pbrMetallicRoughness.baseColorTexture = createTextureInfoDef(texture, textureInfo);
			}

			if (material.getEmissiveTexture()) {
				const texture = material.getEmissiveTexture();
				const textureInfo = material.getEmissiveTextureInfo();
				materialDef.emissiveTexture = createTextureInfoDef(texture, textureInfo);
			}

			if (material.getNormalTexture()) {
				const texture = material.getNormalTexture();
				const textureInfo = material.getNormalTextureInfo();
				const textureInfoDef = createTextureInfoDef(texture, textureInfo) as GLTF.IMaterialNormalTextureInfo;
				if (material.getNormalScale() !== 1) {
					textureInfoDef.scale = material.getNormalScale();
				}
				materialDef.normalTexture = textureInfoDef;
			}

			if (material.getOcclusionTexture()) {
				const texture = material.getOcclusionTexture();
				const textureInfo = material.getOcclusionTextureInfo();
				const textureInfoDef = createTextureInfoDef(texture, textureInfo) as GLTF.IMaterialOcclusionTextureInfo;
				if (material.getOcclusionStrength() !== 1) {
					textureInfoDef.strength = material.getOcclusionStrength();
				}
				materialDef.occlusionTexture = textureInfoDef;
			}

			if (material.getMetallicRoughnessTexture()) {
				const texture = material.getMetallicRoughnessTexture();
				const textureInfo = material.getMetallicRoughnessTextureInfo();
				materialDef.pbrMetallicRoughness.metallicRoughnessTexture = createTextureInfoDef(texture, textureInfo);
			}

			materialIndexMap.set(material, index);
			return materialDef;
		});

		/* Meshes. */

		json.meshes = root.listMeshes().map((mesh, index) => {
			const meshDef = createPropertyDef(mesh) as GLTF.IMesh;
			meshDef.primitives = mesh.listPrimitives().map((primitive) => {
				const primitiveDef: GLTF.IMeshPrimitive = {attributes: {}};
				primitiveDef.material = materialIndexMap.get(primitive.getMaterial());
				primitiveDef.mode = primitive.getMode();

				if (primitive.getIndices()) {
					primitiveDef.indices = accessorIndexMap.get(primitive.getIndices());
				}

				for (const semantic of primitive.listSemantics()) {
					primitiveDef.attributes[semantic] = accessorIndexMap.get(primitive.getAttribute(semantic));
				}

				// TODO(feat): .targets
				// TODO(feat): .targetNames

				return primitiveDef;
			});

			// TODO(feat): meshDef.weights

			meshIndexMap.set(mesh, index);
			return meshDef;
		});

		/* Nodes. */

		json.nodes = root.listNodes().map((node, index) => {
			const nodeDef = createPropertyDef(node) as GLTF.INode;
			nodeDef.translation = node.getTranslation();
			nodeDef.rotation = node.getRotation();
			nodeDef.scale = node.getScale();

			if (node.getMesh()) {
				nodeDef.mesh = meshIndexMap.get(node.getMesh());
			}

			// node.weights
			// node.light
			// node.camera

			nodeIndexMap.set(node, index);
			return nodeDef;
		});
		root.listNodes().forEach((node, index) => {
			if (node.listChildren().length === 0) return;

			const nodeDef = json.nodes[index];
			nodeDef.children = node.listChildren().map((node) => nodeIndexMap.get(node));
		});

		/* Scenes. */

		json.scenes = root.listScenes().map((scene) => {
			const sceneDef = createPropertyDef(scene) as GLTF.IScene;
			sceneDef.nodes = scene.listNodes().map((node) => nodeIndexMap.get(node));
			return sceneDef;
		});

		//

		clean(json);

		return asset;
	}
}

function createPropertyDef(property: Property): PropertyDef {
	const def = {} as PropertyDef;
	if (property.getName()) {
		def.name = property.getName();
	}
	if (Object.keys(property.getExtras()).length > 0) {
		def.extras = property.getExtras();
	}
	if (Object.keys(property.getExtensions()).length > 0) {
		def.extras = property.getExtensions();
	}
	return def;
}

function createAccessorDef(accessor: Accessor): GLTF.IAccessor {
	const accessorDef = createPropertyDef(accessor) as GLTF.IAccessor;
	accessorDef.type = accessor.getType();
	accessorDef.componentType = accessor.getComponentType();
	accessorDef.count = accessor.getCount();
	accessor.getMax((accessorDef.max = []));
	accessor.getMin((accessorDef.min = []));
	accessorDef.normalized = accessor.getNormalized();
	return accessorDef;
}

/**
* Removes empty and null values from an object.
* @param object
*/
function clean(object): void {
	const unused: string[] = [];

	for (const key in object) {
		const value = object[key];
		if (Array.isArray(value) && value.length === 0) {
			unused.push(key);
		} else if (value === null || value === '') {
			unused.push(value);
		}
	}

	for (const key of unused) {
		delete object[key];
	}
}

class UniqueURIGenerator {
	private counter = 1;

	constructor (
		private readonly multiple: boolean,
		private readonly basename: string) {}

	public createURI(object: Texture | Buffer, extension: string): string {
		if (object.getURI()) {
			return object.getURI();
		} else if (!this.multiple) {
			return `${this.basename}.${extension}`;
		} else {
			return `${this.basename}_${this.counter++}.${extension}`;
		}
	}
}