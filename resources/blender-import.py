# Fallback conversion through Blender's own importers and glTF exporter.
# Used for OBJ, FBX, PLY and STL, and for USD files the exact converter cannot map.
#
#   blender -b --factory-startup --python-exit-code 1 -P blender-import.py -- <source> <out.glb> <report.json>
import json
import os
import sys
import traceback

import bpy

src, out_glb, report_path = sys.argv[sys.argv.index("--") + 1:][:3]
report = {"status": "ok", "converter": "blender-import", "reason": None, "warnings": []}


def progress(percent, message):
    print(f"KILN_PROGRESS {percent} {message}", flush=True)


def main():
    ext = os.path.splitext(src)[1].lower()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    progress(10, "Importing with Blender")
    if ext in (".usd", ".usdz", ".usdc", ".usda"):
        bpy.ops.wm.usd_import(filepath=src, import_textures_mode="IMPORT_PACK", import_usd_preview=True,
                              import_subdivision=False, apply_unit_conversion_scale=True, import_guide=False,
                              import_proxy=False, import_render=True)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=src)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=src)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=src)
    else:
        raise RuntimeError(f"no Blender importer for {ext}")
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("the file contains no meshes Blender could import")
    if ext in (".obj", ".ply", ".stl"):
        report["warnings"].append(f"{ext[1:].upper()} files have no unit information, so 1 unit is read as 1 meter. Check the dimensions.")
    if any(img.packed_file is None and img.source == "FILE" and not os.path.exists(bpy.path.abspath(img.filepath))
           for img in bpy.data.images):
        report["warnings"].append("Some textures referenced by the file were not found and are missing from the result.")
    report["warnings"].append("Converted with Blender, so textures may be re-encoded and materials approximated. Compare with the original closely.")

    progress(60, "Exporting GLB")
    bpy.ops.export_scene.gltf(
        filepath=out_glb, export_format="GLB", export_yup=True, export_apply=False,
        export_image_format="AUTO", export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials="EXPORT", export_cameras=True, export_lights=True, export_extras=True,
        export_animations=True, export_skins=True, export_morph=True,
        export_vertex_color="ACTIVE" if ext == ".ply" else "MATERIAL",
        export_draco_mesh_compression_enable=False, use_selection=False)
    if not os.path.exists(out_glb):
        raise RuntimeError("Blender's glTF exporter did not write a file")
    progress(100, "Converted with Blender")


try:
    main()
except Exception as error:  # noqa: BLE001 - reported to Kiln
    traceback.print_exc()
    report["status"], report["reason"] = "error", str(error) or error.__class__.__name__
finally:
    with open(report_path, "w") as fh:
        json.dump(report, fh)
