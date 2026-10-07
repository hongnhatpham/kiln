# Exact USD(Z) -> glTF 2.0 conversion with the USD library bundled in Blender (pxr + numpy).
# Blender's importer and exporter are skipped so every float, index and texture byte carries over.
# Data changes: UV v is flipped (glTF's UV origin is top-left), polygons are fan-triangulated, and
# faceVarying data is split into glTF vertices. Z-up stages and non-meter units get a root transform.
#
#   blender -b --factory-startup --python-exit-code 1 -P usd-to-gltf.py -- <source> <out dir> <report.json>
#
# Anything this converter cannot map exactly is reported as status "unsupported" with a reason, and Kiln
# falls back to Blender's importer with a warning. Nothing is dropped silently.
import json
import math
import os
import shutil
import sys
import traceback
import zipfile

src, out_dir, report_path = sys.argv[sys.argv.index("--") + 1:][:3]
report = {"status": "ok", "converter": "pxr-direct", "reason": None, "warnings": []}
warned = set()


class Unsupported(Exception):
    pass


def warn(message):
    if message not in warned:
        warned.add(message)
        report["warnings"].append(message)


def progress(percent, message):
    print(f"KILN_PROGRESS {percent} {message}", flush=True)


IMAGE_MAGIC = {".png": b"\x89PNG\r\n\x1a\n", ".jpg": b"\xff\xd8\xff", ".jpeg": b"\xff\xd8\xff"}
WRAP = {"repeat": 10497, "mirror": 33648, "clamp": 33071, "black": 33071, "useMetadata": 10497}


def main():
    try:
        import numpy as np
        from pxr import Usd, UsdGeom, UsdShade, Gf
    except ImportError as error:
        raise Unsupported(f"this Blender has no USD Python library ({error})")

    os.makedirs(out_dir, exist_ok=True)
    progress(5, "Opening USD stage")
    layer = src
    if src.lower().endswith(".usdz"):
        package_dir = os.path.join(out_dir, "_package")
        with zipfile.ZipFile(src) as z:
            names = z.namelist()
            root = os.path.realpath(package_dir)
            for name in names:
                target = os.path.realpath(os.path.join(package_dir, name))
                if not target.startswith(root + os.sep):
                    raise RuntimeError("the USDZ package contains unsafe file paths")
            z.extractall(package_dir)
        # USDZ spec: the first file in the archive is the root layer.
        first = next((n for n in names if n.lower().endswith((".usdc", ".usda", ".usd"))), None)
        if not first:
            raise RuntimeError("the USDZ package has no USD layer")
        layer = os.path.join(package_dir, first)
    stage = Usd.Stage.Open(layer)
    if not stage:
        raise RuntimeError("USD could not open this file")

    gltf = {"asset": {"version": "2.0", "generator": "Kiln usd-to-gltf.py (direct pxr conversion)"},
            "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [], "materials": [], "textures": [],
            "images": [], "samplers": [], "accessors": [], "bufferViews": [], "buffers": [], "cameras": []}
    extensions_used = set()
    bin_chunks = []
    bin_len = [0]

    def add_view(arr, target):
        data = arr.tobytes()
        pad = (-bin_len[0]) % 4
        if pad:
            bin_chunks.append(b"\0" * pad)
            bin_len[0] += pad
        view = {"buffer": 0, "byteOffset": bin_len[0], "byteLength": len(data)}
        if target:
            view["target"] = target
        gltf["bufferViews"].append(view)
        bin_chunks.append(data)
        bin_len[0] += len(data)
        return len(gltf["bufferViews"]) - 1

    def add_accessor(arr, comp, typ, target, minmax=False):
        acc = {"bufferView": add_view(arr, target), "componentType": comp, "count": len(arr), "type": typ}
        if minmax:
            acc["min"] = [float(x) for x in arr.min(0)]
            acc["max"] = [float(x) for x in arr.max(0)]
        gltf["accessors"].append(acc)
        return len(gltf["accessors"]) - 1

    def no_animation(attr, what):
        if attr and attr.GetNumTimeSamples() > 1:
            raise Unsupported(f"{what} is animated, which needs Blender's importer")

    # ---------------- Materials: UsdPreviewSurface -> metallic-roughness ----------------
    samplers = {}
    images = {}
    textures = {}

    def sampler_for(wrap_s, wrap_t):
        key = (wrap_s, wrap_t)
        if key not in samplers:
            gltf["samplers"].append({"magFilter": 9729, "minFilter": 9987, "wrapS": WRAP[wrap_s], "wrapT": WRAP[wrap_t]})
            samplers[key] = len(gltf["samplers"]) - 1
        return samplers[key]

    def resolve(shader, name):
        """Returns ('const', value) | ('tex', shader, channel) | None for a shader input, following node graphs."""
        inp = shader.GetInput(name)
        if not inp:
            return None
        attrs = UsdShade.Utils.GetValueProducingAttributes(inp)
        if not attrs:
            return None
        attr = attrs[0]
        if UsdShade.Utils.GetType(attr.GetName()) == UsdShade.AttributeType.Output:
            return ("tex", UsdShade.Shader(attr.GetPrim()), UsdShade.Utils.GetBaseNameAndType(attr.GetName())[0])
        value = attr.Get()
        return None if value is None else ("const", value)

    def const_of(shader, name, default):
        r = resolve(shader, name)
        if r is None:
            return default
        if r[0] != "const":
            raise Unsupported(f"the material input {name} is driven by a texture, which the exact converter cannot map")
        return r[1]

    def reader_input(tex, name, default):
        r = resolve(tex, name)
        if r is None:
            return default
        if r[0] != "const":
            raise Unsupported(f"a texture's {name} input is driven by another node")
        return r[1]

    def texture_for(tex, mat_name, slot, color):
        if tex.GetIdAttr().Get() != "UsdUVTexture":
            raise Unsupported(f"material {mat_name} drives {slot} with a {tex.GetIdAttr().Get()} node instead of a texture")
        asset = reader_input(tex, "file", None)
        if asset is None or not asset.path:
            raise Unsupported(f"material {mat_name} has a texture without a file")
        if "<UDIM>" in asset.path:
            raise Unsupported("UDIM textures are not supported by glTF")
        path = asset.resolvedPath or os.path.join(os.path.dirname(layer), asset.path)
        ext = os.path.splitext(path)[1].lower()
        if ext not in IMAGE_MAGIC:
            raise Unsupported(f"texture {os.path.basename(asset.path)} is {ext or 'an unknown format'}, which glTF cannot store directly")
        with open(path, "rb") as fh:
            if not fh.read(8).startswith(IMAGE_MAGIC[ext]):
                raise RuntimeError(f"texture {os.path.basename(path)} is not a valid {ext[1:].upper()} file")
        space = reader_input(tex, "sourceColorSpace", "auto")
        if color and space == "raw":
            raise Unsupported(f"material {mat_name} marks its {slot} texture as raw data, but glTF color maps are sRGB")
        if not color and space == "sRGB":
            raise Unsupported(f"material {mat_name} marks its {slot} texture as sRGB, but glTF data maps are linear")
        wrap_s, wrap_t = reader_input(tex, "wrapS", "useMetadata"), reader_input(tex, "wrapT", "useMetadata")
        if "black" in (wrap_s, wrap_t):
            warn("Texture wrap mode 'black' became 'clamp', since glTF has no border color.")
        st = resolve(tex, "st")
        varname = "st"
        if st and st[0] == "tex":
            reader = st[1]
            rid = reader.GetIdAttr().Get()
            if rid != "UsdPrimvarReader_float2":
                raise Unsupported(f"material {mat_name} uses a {rid} node for UVs (texture transforms are not mapped)")
            varname = str(reader_input(reader, "varname", "st"))
        key = (os.path.realpath(path), wrap_s, wrap_t)
        if key not in textures:
            real = os.path.realpath(path)
            if real not in images:
                name = f"{len(images)}_{os.path.basename(path)}"
                shutil.copyfile(path, os.path.join(out_dir, name))  # byte-identical copy
                gltf["images"].append({"uri": name, "name": os.path.splitext(os.path.basename(path))[0]})
                images[real] = len(gltf["images"]) - 1
            gltf["textures"].append({"sampler": sampler_for(wrap_s, wrap_t), "source": images[real]})
            textures[key] = len(gltf["textures"]) - 1
        scale = tuple(reader_input(tex, "scale", Gf.Vec4f(1, 1, 1, 1)))
        bias = tuple(reader_input(tex, "bias", Gf.Vec4f(0, 0, 0, 0)))
        return textures[key], os.path.realpath(path), scale, bias, varname

    known_inputs = {"diffuseColor", "emissiveColor", "metallic", "roughness", "normal", "occlusion", "opacity",
                    "opacityThreshold", "ior", "clearcoat", "clearcoatRoughness", "useSpecularWorkflow", "specularColor",
                    "displacement", "opacityMode"}
    materials = {}

    def material_for(mat_prim, double_sided):
        key = (str(mat_prim.GetPath()) if mat_prim else None, double_sided)
        if key in materials:
            return materials[key]
        if mat_prim is None:
            m = {"name": "default", "pbrMetallicRoughness": {"baseColorFactor": [0.18, 0.18, 0.18, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.5}}
            uv = "st"
        else:
            m, uv = convert_material(mat_prim)
        if double_sided:
            m["doubleSided"] = True
        gltf["materials"].append(m)
        materials[key] = (len(gltf["materials"]) - 1, uv)
        return materials[key]

    def convert_material(mat_prim):
        name = mat_prim.GetName()
        surf = UsdShade.Material(mat_prim).ComputeSurfaceSource()[0]
        if not surf or surf.GetIdAttr().Get() != "UsdPreviewSurface":
            raise Unsupported(f"material {name} does not use UsdPreviewSurface")
        for i in surf.GetInputs():
            if i.GetBaseName() not in known_inputs:
                warn(f"Material {name}: input {i.GetBaseName()} has no glTF equivalent and was ignored, as USD viewers also ignore it.")
        if int(const_of(surf, "useSpecularWorkflow", 0)) != 0:
            raise Unsupported(f"material {name} uses the specular workflow")
        pbr = {}
        m = {"name": name, "pbrMetallicRoughness": pbr}
        uvs = set()

        def tex(input_name, color):
            r = resolve(surf, input_name)
            if not r or r[0] != "tex":
                return None
            index, path, scale, bias, varname = texture_for(r[1], name, input_name, color)
            uvs.add(varname)
            return index, path, scale, bias, r[2]

        # Base color and opacity. USD default diffuse is 0.18 gray, glTF's is white.
        t = tex("diffuseColor", True)
        if not t:
            base = [*map(float, const_of(surf, "diffuseColor", Gf.Vec3f(0.18))), 1.0]
        else:
            index, path, scale, bias, channel = t
            if channel != "rgb" or any(abs(b) > 0 for b in bias[:3]):
                raise Unsupported(f"material {name} remaps its color texture in a way glTF cannot express")
            pbr["baseColorTexture"] = {"index": index}
            base = [float(scale[0]), float(scale[1]), float(scale[2]), 1.0]
        ot = tex("opacity", False)
        opacity = 1.0
        if ot:
            index, path, scale, bias, channel = ot
            if not t or path != t[1] or channel != "a" or bias[3] != 0:
                raise Unsupported(f"material {name} uses an opacity map separate from the color texture's alpha")
            base[3] = float(scale[3])
        else:
            opacity = float(const_of(surf, "opacity", 1.0))
            base[3] = opacity
        threshold = float(const_of(surf, "opacityThreshold", 0.0))
        if threshold > 0:
            m["alphaMode"], m["alphaCutoff"] = "MASK", threshold
        elif ot or opacity < 1:
            m["alphaMode"] = "BLEND"
        if base != [1.0, 1.0, 1.0, 1.0]:
            pbr["baseColorFactor"] = base

        # Metallic and roughness. USD defaults (metallic 0, roughness 0.5) differ from glTF's (1, 1), so always write them.
        mt, rt = tex("metallic", False), tex("roughness", False)
        metallic = float(const_of(surf, "metallic", 0.0)) if not mt else None
        roughness = float(const_of(surf, "roughness", 0.5)) if not rt else None
        if mt or rt:
            if mt and mt[4] != "b" or rt and rt[4] != "g" or (mt and rt and mt[1] != rt[1]):
                raise Unsupported(f"material {name} stores metallic and roughness in a layout other than glTF's (roughness G, metallic B of one texture)")
            if rt and not mt and metallic != 0.0:
                raise Unsupported(f"material {name} combines a roughness map with a nonzero metallic value")
            if mt and not rt:
                raise Unsupported(f"material {name} has a metallic map without a roughness map")
            for r in (mt, rt):
                if r and r[3][{"r": 0, "g": 1, "b": 2, "a": 3}[r[4]]] != 0:
                    raise Unsupported(f"material {name} offsets its metallic or roughness map")
            pbr["metallicRoughnessTexture"] = {"index": (rt or mt)[0]}
            channel_scale = lambda r: float(r[2][{"r": 0, "g": 1, "b": 2, "a": 3}[r[4]]])
            pbr["metallicFactor"] = channel_scale(mt) if mt else 0.0
            pbr["roughnessFactor"] = channel_scale(rt)
        else:
            pbr["metallicFactor"], pbr["roughnessFactor"] = metallic, roughness

        nt = tex("normal", False)
        if nt:
            index, path, scale, bias, channel = nt
            s = float(scale[0])
            if channel != "rgb" or scale[0] != scale[1] or abs(scale[2] - 2) > 1e-6 or abs(bias[2] + 1) > 1e-6 \
                    or abs(bias[0] + s / 2) > 1e-6 or abs(bias[1] + s / 2) > 1e-6 or s == 0:
                raise Unsupported(f"material {name} decodes its normal map in a non-standard way")
            m["normalTexture"] = {"index": index}
            if abs(s - 2) > 1e-6:
                m["normalTexture"]["scale"] = s / 2

        at = tex("occlusion", False)
        if at:
            index, path, scale, bias, channel = at
            if channel != "r":
                raise Unsupported(f"material {name} reads occlusion from the {channel} channel; glTF reads red")
            s, b = float(scale[0]), float(bias[0])
            if abs(b - (1 - s)) > 1e-6:
                raise Unsupported(f"material {name} remaps occlusion in a way glTF cannot express")
            m["occlusionTexture"] = {"index": index}
            if abs(s - 1) > 1e-6:
                m["occlusionTexture"]["strength"] = s

        et = tex("emissiveColor", True)
        if et:
            index, path, scale, bias, channel = et
            if channel != "rgb" or any(abs(b) > 0 for b in bias[:3]):
                raise Unsupported(f"material {name} remaps its emissive texture")
            m["emissiveTexture"] = {"index": index}
            emissive = [float(x) for x in scale[:3]]
        else:
            emissive = [float(x) for x in const_of(surf, "emissiveColor", Gf.Vec3f(0))]
        if any(emissive):
            strength = max(emissive)
            if strength > 1:
                m.setdefault("extensions", {})["KHR_materials_emissive_strength"] = {"emissiveStrength": strength}
                extensions_used.add("KHR_materials_emissive_strength")
                emissive = [c / strength for c in emissive]
            m["emissiveFactor"] = emissive

        ior = float(const_of(surf, "ior", 1.5))
        if abs(ior - 1.5) > 1e-6:
            m.setdefault("extensions", {})["KHR_materials_ior"] = {"ior": ior}
            extensions_used.add("KHR_materials_ior")
        clearcoat = float(const_of(surf, "clearcoat", 0.0))
        if clearcoat > 0:
            m.setdefault("extensions", {})["KHR_materials_clearcoat"] = {
                "clearcoatFactor": clearcoat, "clearcoatRoughnessFactor": float(const_of(surf, "clearcoatRoughness", 0.01))}
            extensions_used.add("KHR_materials_clearcoat")
        d = resolve(surf, "displacement")
        if d and (d[0] == "tex" or float(d[1]) != 0):
            warn(f"Material {name}: displacement has no glTF equivalent and was ignored. Fine relief should be in the normal map or mesh.")
        if len(uvs) > 1:
            raise Unsupported(f"material {name} uses several UV sets")
        return m, (uvs.pop() if uvs else "st")

    # ---------------- Meshes ----------------
    mesh_cache = {}

    def per_corner(values, interpolation, idx, face_of_corner, n_points, label):
        values = np.asarray(values)
        n_corners, n_faces = len(idx), int(face_of_corner[-1]) + 1 if len(face_of_corner) else 0
        if interpolation in ("vertex", "varying"):
            expected, out = n_points, values[idx] if len(values) == n_points else None
        elif interpolation == "faceVarying":
            expected, out = n_corners, values if len(values) == n_corners else None
        elif interpolation == "uniform":
            expected, out = n_faces, values[face_of_corner] if len(values) == n_faces else None
        elif interpolation == "constant":
            expected, out = 1, np.repeat(values.reshape(1, -1), n_corners, 0) if len(values) >= 1 else None
        else:
            raise Unsupported(f"{label} uses {interpolation} interpolation")
        if out is None:
            raise Unsupported(f"{label} has {len(values)} values where {expected} were expected")
        return out

    def smooth_normals(pts, tris):
        a, b, c = pts[tris[:, 0]], pts[tris[:, 1]], pts[tris[:, 2]]
        face = np.cross(b - a, c - a).astype(np.float64)  # area-weighted
        acc = np.zeros((len(pts), 3))
        for k in range(3):
            np.add.at(acc, tris[:, k], face)
        length = np.linalg.norm(acc, axis=1, keepdims=True)
        acc = np.where(length > 0, acc / np.maximum(length, 1e-30), [0.0, 1.0, 0.0])
        return acc.astype(np.float32)

    def convert_mesh(prim):
        mesh = UsdGeom.Mesh(prim)
        for attr, what in ((mesh.GetPointsAttr(), "geometry"), (mesh.GetNormalsAttr(), "normals"),
                           (mesh.GetFaceVertexIndicesAttr(), "topology")):
            no_animation(attr, f"{what} of {prim.GetPath()}")
        if "SkelBindingAPI" in prim.GetAppliedSchemas():
            raise Unsupported("the model has skinning (UsdSkel)")
        counts = np.asarray(mesh.GetFaceVertexCountsAttr().Get() or [], dtype=np.int64)
        idx = np.asarray(mesh.GetFaceVertexIndicesAttr().Get() or [], dtype=np.int64)
        pts = np.asarray(mesh.GetPointsAttr().Get() or [], dtype=np.float32)
        if not len(counts) or not len(pts):
            warn(f"Skipped an empty mesh ({prim.GetName()}).")
            return None
        holes = mesh.GetHoleIndicesAttr().Get()
        if holes and len(holes):
            raise Unsupported("a mesh has holes (holeIndices)")
        if mesh.GetSubdivisionSchemeAttr().Get() != "none":
            warn("Some meshes are marked for subdivision. glTF has no subdivision, so they keep their stored (control) shape.")
        if (counts > 4).any():
            warn("Polygons with more than four sides were fan-triangulated. Check concave faces.")
        if (counts < 3).any():
            warn("Faces with fewer than three corners were skipped.")
        if len(idx) != counts.sum() or (idx >= len(pts)).any() or (idx < 0).any():
            raise RuntimeError(f"mesh {prim.GetPath()} has invalid face indices")

        n_faces = len(counts)
        face_of_corner = np.repeat(np.arange(n_faces), counts)
        starts = np.cumsum(counts) - counts
        n_tris = np.clip(counts - 2, 0, None)
        tri_face = np.repeat(np.arange(n_faces), n_tris)
        k = np.arange(n_tris.sum()) - np.repeat(np.cumsum(n_tris) - n_tris, n_tris) + 1
        c0 = starts[tri_face]
        c1, c2 = c0 + k, c0 + k + 1
        if mesh.GetOrientationAttr().Get() == "leftHanded":
            c1, c2 = c2, c1
        tri_corners = np.stack([c0, c1, c2], 1)

        api = UsdGeom.PrimvarsAPI(prim)
        attrs = {}  # semantic -> (values, interpolation)
        npv = api.GetPrimvar("normals")
        if npv and npv.HasAuthoredValue():
            no_animation(npv.GetAttr(), f"normals of {prim.GetPath()}")
            attrs["NORMAL"] = (np.asarray(npv.ComputeFlattened(), dtype=np.float32), npv.GetInterpolation())
        elif mesh.GetNormalsAttr().HasAuthoredValue():
            attrs["NORMAL"] = (np.asarray(mesh.GetNormalsAttr().Get(), dtype=np.float32), mesh.GetNormalsInterpolation())

        # Material bindings: whole mesh plus materialBind subsets.
        double_sided = bool(mesh.GetDoubleSidedAttr().Get())
        groups = []  # (face mask, material prim)
        assigned = np.zeros(n_faces, dtype=bool)
        for subset in UsdShade.MaterialBindingAPI(prim).GetMaterialBindSubsets():
            faces = np.asarray(subset.GetIndicesAttr().Get() or [], dtype=np.int64)
            mask = np.zeros(n_faces, dtype=bool)
            mask[faces[(faces >= 0) & (faces < n_faces)]] = True
            mask &= ~assigned
            assigned |= mask
            mat = UsdShade.MaterialBindingAPI(subset.GetPrim()).ComputeBoundMaterial()[0]
            groups.append((mask, mat.GetPrim() if mat else None))
        if not assigned.all():
            mat = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]
            groups.append((~assigned, mat.GetPrim() if mat else None))
        bound = [(mask, material_for(mat, double_sided)) for mask, mat in groups if mask.any()]
        uv_names = {uv for _, (_, uv) in bound}
        if len(uv_names) > 1:
            raise Unsupported("one mesh uses materials with different UV sets")
        uv_name = uv_names.pop() if uv_names else "st"
        if not any(mat is not None for _, mat in groups):
            dpv = api.GetPrimvar("displayColor")
            if dpv and dpv.HasAuthoredValue():
                colors = np.asarray(dpv.ComputeFlattened(), dtype=np.float32)
                if dpv.GetInterpolation() == "constant":
                    warn("Meshes without materials use their display color as a plain material.")
                    for _, (mi, _) in bound:
                        gltf["materials"][mi]["pbrMetallicRoughness"]["baseColorFactor"] = [*map(float, colors[0][:3]), 1.0]
                else:
                    attrs["COLOR_0"] = (colors, dpv.GetInterpolation())
                    for _, (mi, _) in bound:
                        gltf["materials"][mi]["pbrMetallicRoughness"]["baseColorFactor"] = [1.0, 1.0, 1.0, 1.0]
        uvpv = api.GetPrimvar(uv_name)
        if uvpv and uvpv.HasAuthoredValue():
            no_animation(uvpv.GetAttr(), f"UVs of {prim.GetPath()}")
            st = np.asarray(uvpv.ComputeFlattened(), dtype=np.float64)
            attrs["TEXCOORD_0"] = (np.stack([st[:, 0], 1.0 - st[:, 1]], 1).astype(np.float32), uvpv.GetInterpolation())
        elif any("baseColorTexture" in gltf["materials"][mi]["pbrMetallicRoughness"] or "normalTexture" in gltf["materials"][mi] for _, (mi, _) in bound):
            raise Unsupported(f"a textured mesh has no '{uv_name}' UV set")

        if all(interp in ("vertex", "varying") for _, interp in attrs.values()) and \
                all(len(v) == len(pts) for v, _ in attrs.values()):
            # Shared per-point data: keep USD's points and their order exactly.
            vert_pts = pts
            vert_attrs = {k: v for k, (v, _) in attrs.items()}
            tris = idx[tri_corners]
        else:
            # Some data is per face corner: build one vertex per unique (point, attribute values) combination.
            corner_attrs = {k: per_corner(v, interp, idx, face_of_corner, len(pts), f"{k} on {prim.GetName()}")
                            for k, (v, interp) in attrs.items()}
            columns = [idx.astype("<u4").view(np.uint8).reshape(len(idx), 4)]
            columns += [np.ascontiguousarray(v).view(np.uint8).reshape(len(idx), -1) for v in corner_attrs.values()]
            keys = np.ascontiguousarray(np.concatenate(columns, 1))
            keys = keys.view(np.dtype((np.void, keys.shape[1]))).ravel()
            _, first, inverse = np.unique(keys, return_index=True, return_inverse=True)
            order = np.argsort(first)  # keep first-appearance order
            rank = np.empty_like(order)
            rank[order] = np.arange(len(order))
            corner_to_vertex = rank[inverse.ravel()]
            chosen = first[order]
            vert_pts = pts[idx[chosen]]
            vert_attrs = {k: v[chosen] for k, v in corner_attrs.items()}
            tris = corner_to_vertex[tri_corners]

        if "NORMAL" not in vert_attrs:
            warn("Some meshes had no normals, so smooth normals were computed (as USD viewers do).")
            vert_attrs["NORMAL"] = smooth_normals(vert_pts, tris)

        n_verts = len(vert_pts)
        accessors = {"POSITION": add_accessor(np.ascontiguousarray(vert_pts, dtype=np.float32), 5126, "VEC3", 34962, minmax=True)}
        types = {"NORMAL": "VEC3", "TEXCOORD_0": "VEC2"}
        for k, v in vert_attrs.items():
            v = np.ascontiguousarray(v, dtype=np.float32)
            typ = types.get(k) or ("VEC4" if v.shape[1] == 4 else "VEC3")
            accessors[k] = add_accessor(v, 5126, typ, 34962)
        ind_dtype, ind_comp = (np.uint16, 5123) if n_verts < 65535 else (np.uint32, 5125)
        primitives = []
        for mask, (mi, _) in bound:
            sel = tris[mask[tri_face]]
            if not len(sel):
                continue
            primitives.append({"attributes": dict(accessors), "mode": 4, "material": mi,
                               "indices": add_accessor(np.ascontiguousarray(sel.ravel(), dtype=ind_dtype), ind_comp, "SCALAR", 34963)})
        if not primitives:
            return None
        gltf["meshes"].append({"name": prim.GetName(), "primitives": primitives})
        return len(gltf["meshes"]) - 1

    # ---------------- Hierarchy ----------------
    predicate = Usd.TraverseInstanceProxies(Usd.PrimDefaultPredicate)
    skip_types = {"Material", "Shader", "NodeGraph", "GeomSubset"}
    unsupported_geometry = {"Points", "BasisCurves", "NurbsCurves", "NurbsPatch", "PointInstancer", "Cube", "Sphere",
                            "Cylinder", "Cone", "Capsule", "Plane", "TetMesh", "Volume", "HermiteCurves"}
    stats = {"meshes": 0}

    def local_matrix(prim):
        xf = UsdGeom.Xformable(prim)
        for op in xf.GetOrderedXformOps():
            no_animation(op.GetAttr(), f"the transform of {prim.GetPath()}")
        m = xf.GetLocalTransformation()
        # USD row-vector matrix flattened row-major == glTF column-major array.
        return None if m == Gf.Matrix4d(1) else [m[r][c] for r in range(4) for c in range(4)]

    def convert(prim):
        t = prim.GetTypeName()
        if t in skip_types:
            return None
        if t in ("SkelRoot", "Skeleton", "SkelAnimation", "BlendShape"):
            raise Unsupported("the model has skinning or blend shapes (UsdSkel)")
        if t in unsupported_geometry:
            raise Unsupported(f"the model contains {t} prims")
        if prim.IsA(UsdGeom.Imageable):
            img = UsdGeom.Imageable(prim)
            if img.ComputeVisibility() == "invisible":
                warn("Hidden prims were left out, as USD viewers hide them.")
                return None
            if img.ComputePurpose() in ("guide", "proxy"):
                warn("Guide and proxy prims were left out; the render geometry is kept.")
                return None
        node = {"name": prim.GetName()}
        if prim.IsA(UsdGeom.Xformable):
            matrix = local_matrix(prim)
            if matrix:
                node["matrix"] = matrix
        if t == "Mesh":
            key = str(prim.GetPrimInPrototype().GetPath()) if prim.IsInstanceProxy() else str(prim.GetPath())
            key += "|" + str(UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0].GetPath())
            if key not in mesh_cache:
                mesh_cache[key] = convert_mesh(prim)
                stats["meshes"] += 1
                progress(10 + min(70, stats["meshes"]), f"Converted mesh {prim.GetName()}")
            if mesh_cache[key] is not None:
                node["mesh"] = mesh_cache[key]
        elif t == "Camera":
            cam = UsdGeom.Camera(prim)
            if cam.GetProjectionAttr().Get() == "perspective":
                f, va, ha = cam.GetFocalLengthAttr().Get(), cam.GetVerticalApertureAttr().Get(), cam.GetHorizontalApertureAttr().Get()
                near, far = cam.GetClippingRangeAttr().Get()
                gltf["cameras"].append({"name": prim.GetName(), "type": "perspective", "perspective": {
                    "yfov": 2 * math.atan(va / (2 * f)), "aspectRatio": ha / va, "znear": max(float(near), 1e-6), "zfar": float(far)}})
                node["camera"] = len(gltf["cameras"]) - 1
            else:
                warn("An orthographic camera was left out.")
        elif t.endswith("Light"):
            warn("Lights were left out. Web viewers light the model themselves.")
            return None
        elif t not in ("Xform", "Scope", ""):
            warn(f"Unknown prim type {t} was treated as a group.")
        children = [c for c in (convert(child) for child in prim.GetFilteredChildren(predicate)) if c is not None]
        if children:
            node["children"] = children
        if "mesh" not in node and "camera" not in node and not children:
            return None
        gltf["nodes"].append(node)
        return len(gltf["nodes"]) - 1

    progress(10, "Converting meshes")
    roots = [c for c in (convert(p) for p in stage.GetPseudoRoot().GetFilteredChildren(predicate)) if c is not None]
    if not gltf["meshes"]:
        raise Unsupported("the exact converter found no polygon meshes")

    # Stage orientation and units: glTF is Y-up meters. A root node converts without touching vertex data.
    up = UsdGeom.GetStageUpAxis(stage)
    mpu = float(UsdGeom.GetStageMetersPerUnit(stage))
    if up == "Z" or abs(mpu - 1.0) > 1e-9:
        wrapper = {"name": "usd_stage", "children": roots}
        if up == "Z":
            s = math.sqrt(0.5)
            wrapper["rotation"] = [-s, 0.0, 0.0, s]
            warn("The USD stage is Z-up. A root rotation turns it Y-up for glTF.")
        if abs(mpu - 1.0) > 1e-9:
            wrapper["scale"] = [mpu, mpu, mpu]
            warn(f"The USD stage uses {mpu:g} meters per unit. A root scale converts it to meters.")
        gltf["nodes"].append(wrapper)
        roots = [len(gltf["nodes"]) - 1]
    gltf["scenes"][0]["nodes"] = roots

    progress(85, "Writing glTF")
    gltf["buffers"].append({"uri": "geometry.bin", "byteLength": bin_len[0]})
    with open(os.path.join(out_dir, "geometry.bin"), "wb") as fh:
        fh.write(b"".join(bin_chunks))
    if extensions_used:
        gltf["extensionsUsed"] = sorted(extensions_used)
    gltf = {k: v for k, v in gltf.items() if v != []}
    with open(os.path.join(out_dir, "model.gltf"), "w") as fh:
        json.dump(gltf, fh)
    progress(100, "USD converted")


try:
    main()
except Unsupported as error:
    report["status"], report["reason"] = "unsupported", str(error)
except Exception as error:  # noqa: BLE001 - reported to Kiln
    traceback.print_exc()
    report["status"], report["reason"] = "error", str(error) or error.__class__.__name__
finally:
    os.makedirs(os.path.dirname(os.path.abspath(report_path)), exist_ok=True)
    with open(report_path, "w") as fh:
        json.dump(report, fh)
    package = os.path.join(out_dir, "_package")
    if os.path.isdir(package):
        shutil.rmtree(package, ignore_errors=True)
